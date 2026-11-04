import { randomUUID } from 'node:crypto';
import type { Job, ProjectRecords, ProjectStore, RecordKind, RecordSummary } from './project-store.js';

export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const accessToken = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export type Project = { id: string; name: string };
export type Member = { id: string; token: string };
export type SupabaseConfig = { url: string; publishableKey: string; fetcher?: typeof fetch };
type AuthSession = { access_token?: string; expires_in?: number };
export class SupabaseUnavailable extends Error {
  constructor() { super('Private workspace storage is temporarily unavailable.'); }
}

export class SupabaseWorkspace {
  constructor(private readonly config: SupabaseConfig) {
    if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(config.url) ||
        !/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(config.publishableKey)) {
      throw new Error('Configure a hosted Supabase URL and publishable key.');
    }
  }

  private async request(path: string, init: RequestInit = {}, token?: string) {
    const headers = new Headers(init.headers);
    headers.set('apikey', this.config.publishableKey);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    try {
      return await (this.config.fetcher ?? fetch)(this.config.url + path, {
        ...init, headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new SupabaseUnavailable(); }
  }

  private async json<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const response = await this.request(path, init, token);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new SupabaseUnavailable();
    }
    return await response.json() as T;
  }

  async member(token: string): Promise<Member | undefined> {
    if (token.length > 3500 || !accessToken.test(token)) return;
    const response = await this.request('/auth/v1/user', {}, token);
    if ([400, 401, 403].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    if (!response.ok) throw new SupabaseUnavailable();
    const user = await response.json() as { id?: string; is_anonymous?: boolean };
    if (!user.id || !uuid.test(user.id) || user.is_anonymous) return;
    const rows = await this.json<{ user_id: string; active: boolean }[]>(
      `/rest/v1/app_members?user_id=eq.${user.id}&active=eq.true&select=user_id,active&limit=1`, {}, token,
    );
    if (rows[0]?.user_id === user.id && rows[0].active === true) return { id: user.id, token };
  }

  async signIn(email: string, password: string) {
    const response = await this.request('/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    if ([400, 401, 403, 429].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    if (!response.ok) throw new SupabaseUnavailable();
    const session = await response.json() as AuthSession;
    if (typeof session.access_token !== 'string' || !await this.member(session.access_token)) return;
    if (!Number.isFinite(session.expires_in) || session.expires_in! < 1) return;
    return { token: session.access_token, maxAge: Math.min(3600, Math.floor(session.expires_in!)) };
  }

  async finishPassword(tokenHash: string, type: 'invite' | 'recovery', password: string) {
    const verification = await this.request('/auth/v1/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token_hash: tokenHash, type }),
    });
    if (!verification.ok) {
      await verification.body?.cancel().catch(() => {});
      return false;
    }
    const session = await verification.json() as AuthSession;
    return typeof session.access_token === 'string' && await this.changePassword(session.access_token, password);
  }

  async changePassword(token: string, password: string) {
    if (!accessToken.test(token) || token.length > 3500) return false;
    try {
      if (!await this.member(token)) return false;
      const response = await this.request('/auth/v1/user', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
      }, token);
      await response.body?.cancel().catch(() => {});
      return response.ok;
    } finally {
      await this.signOut(token).catch(() => {});
    }
  }

  async signOut(token: string) {
    const response = await this.request('/auth/v1/logout?scope=local', { method: 'POST' }, token);
    await response.body?.cancel().catch(() => {});
  }

  projects(member: Member) {
    return this.json<Project[]>(`/rest/v1/audit_projects?owner_id=eq.${member.id}&select=id,name&order=created_at.desc&limit=20`, {}, member.token);
  }

  async project(member: Member, id: string) {
    if (!uuid.test(id)) return;
    const projects = await this.json<Project[]>(`/rest/v1/audit_projects?owner_id=eq.${member.id}&id=eq.${id}&select=id,name&limit=1`, {}, member.token);
    return projects[0]?.id === id ? projects[0] : undefined;
  }

  async createProject(member: Member, name: string) {
    const id = randomUUID();
    await this.json('/rest/v1/audit_projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ id, owner_id: member.id, name }),
    }, member.token);
    return id;
  }

  store(member: Member, projectId: string): ProjectStore {
    const base = '/rest/v1/audit_records';
    const scope = `project_id=eq.${projectId}&owner_id=eq.${member.id}`;
    const object = (name: string) => {
      if (!/^[a-f0-9-]{36}\.(?:source|(?:light|dark)-(?:390|1440)\.png)$/.test(name)) throw new Error('Invalid evidence name.');
      return `audit-private/${member.id}/${projectId}/${name}`;
    };
    return {
      get: async <K extends RecordKind>(kind: K, id: string): Promise<ProjectRecords[K] | undefined> => {
        if (!uuid.test(id)) return;
        const rows = await this.json<{ payload: ProjectRecords[K] }[]>(`${base}?${scope}&kind=eq.${kind}&id=eq.${id}&select=payload&limit=1`, {}, member.token);
        return rows[0]?.payload;
      },
      put: async <K extends RecordKind>(kind: K, record: ProjectRecords[K]) => {
        await this.json(`${base}?select=id`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({ id: record.id, project_id: projectId, owner_id: member.id, kind, payload: record }),
        }, member.token);
      },
      updateJob: async (job: Job) => {
        await this.json(`${base}?${scope}&kind=eq.job&id=eq.${job.id}&select=id`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({ payload: job }),
        }, member.token);
      },
      count: async kind => {
        const rows = await this.json<{ id: string }[]>(`${base}?${scope}&kind=eq.${kind}&select=id&limit=100`, {}, member.token);
        return rows.length;
      },
      library: () => this.json<RecordSummary[]>(
        `${base}?${scope}&kind=in.(system,report)&select=id,kind,name:payload->>name,url:payload->>url,created_at&order=created_at.desc&limit=60`, {}, member.token,
      ),
      upload: async (name, bytes, contentType) => {
        if (bytes.length > 16_000_000) throw new Error('This file exceeds the private storage limit.');
        const response = await this.request('/storage/v1/object/' + object(name), {
          method: 'POST', headers: { 'Content-Type': contentType }, body: new Uint8Array(bytes),
        }, member.token);
        await response.body?.cancel().catch(() => {});
        if (!response.ok) throw new SupabaseUnavailable();
      },
      removeFiles: async names => {
        await this.json('/storage/v1/object/audit-private', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefixes: names.map(name => object(name).slice('audit-private/'.length)) }),
        }, member.token);
      },
      download: async name => {
        const response = await this.request('/storage/v1/object/' + object(name), {}, member.token);
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if ([400, 401, 403, 404].includes(response.status)) return;
          throw new SupabaseUnavailable();
        }
        if (Number(response.headers.get('Content-Length')) > 16_000_000) {
          await response.body?.cancel().catch(() => {});
          throw new SupabaseUnavailable();
        }
        const reader = response.body?.getReader();
        if (!reader) return;
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return Buffer.concat(chunks, length);
          length += value.length;
          if (length > 16_000_000) {
            await reader.cancel();
            throw new SupabaseUnavailable();
          }
          chunks.push(value);
        }
      },
    };
  }
}
