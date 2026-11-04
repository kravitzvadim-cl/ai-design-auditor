import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { betaServer } from '../src/beta-server.js';
import type { IntakeServices } from '../src/intake-server.js';
import { SupabaseWorkspace } from '../src/supabase-workspace.js';

const origin = 'https://preview.example.test';
const alice = { id: '10000000-0000-4000-8000-000000000001', token: 'fixture.alice.session' };
const bob = { id: '10000000-0000-4000-8000-000000000002', token: 'fixture.bob.session' };
const element = { id: 'body', tag: 'p', selector: 'p', text: 'Example', classes: '', role: '' };

function fixture(linkSessions = false) {
  const members = new Set([alice.id, bob.id]);
  const projects: Record<string, string>[] = [];
  const records: { id: string; project_id: string; owner_id: string; kind: string; payload: Record<string, unknown> }[] = [];
  const files = new Map<string, Uint8Array>();
  let verificationUsed = false;
  let savedPassword = false;
  let rejectNextSource = false;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const token = headers.get('Authorization')?.split(' ')[1];
    const user = [alice, bob].find(person => person.token === token);
    const method = init?.method ?? 'GET';
    const data = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const answer = (value: unknown, status = 200) => Response.json(value, { status });
    assert.ok(headers.get('apikey')?.startsWith('sb_publishable_'));
    assert.equal(init?.redirect, 'error');

    if (url.pathname === '/auth/v1/token') {
      if (linkSessions && url.searchParams.get('grant_type') === 'refresh_token') {
        return data.refresh_token === 'fixture_refresh' ? answer({ access_token: alice.token, refresh_token: 'fixture_rotated' }) : answer({}, 401);
      }
      const account = data.email === 'alice@example.test' ? alice : data.email === 'bob@example.test' ? bob : undefined;
      return account && data.password === 'fixture password' ? answer({ access_token: account.token, refresh_token: 'never-forward-this', expires_in: 3600 }) : answer({}, 400);
    }
    if (url.pathname === '/auth/v1/verify') {
      if (data.token_hash !== 'fixture_invitation_link' || data.type !== 'invite' || verificationUsed) return answer({}, 403);
      verificationUsed = true;
      return answer({ access_token: alice.token, refresh_token: 'fixture_refresh', expires_in: 3600 });
    }
    if (url.pathname === '/auth/v1/user') {
      if (!user) return answer({}, 401);
      if (method === 'PUT') savedPassword = user.id === alice.id && data.password === 'fixture new password';
      return answer({ id: user.id, is_anonymous: false });
    }
    if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
    if (url.pathname === '/rest/v1/app_members') {
      return answer(user && members.has(user.id) ? [{ user_id: user.id, active: true }] : []);
    }
    if (!user || !members.has(user.id)) return answer({}, 403);
    const matches = (key: string, value: string) => !url.searchParams.has(key) || url.searchParams.get(key) === 'eq.' + value;
    if (url.pathname === '/rest/v1/audit_projects') {
      if (method === 'POST') {
        assert.equal(data.owner_id, user.id);
        projects.push(data);
        return answer([data], 201);
      }
      assert.equal(url.searchParams.get('owner_id'), 'eq.' + user.id);
      return answer(projects.filter(project => project.owner_id === user.id && matches('id', project.id!)));
    }
    if (url.pathname === '/rest/v1/audit_records') {
      if (method === 'POST') {
        assert.equal(data.owner_id, user.id);
        assert.ok(projects.some(project => project.id === data.project_id && project.owner_id === user.id));
        if (rejectNextSource && data.kind === 'source') {
          rejectNextSource = false;
          return answer({}, 500);
        }
        records.push(data);
        return answer([{ id: data.id }], 201);
      }
      assert.equal(url.searchParams.get('owner_id'), 'eq.' + user.id);
      const scoped = records.filter(record => record.owner_id === user.id && matches('project_id', record.project_id) && matches('id', record.id));
      if (url.searchParams.get('kind') === 'in.(system,report)') {
        return answer(scoped.filter(record => ['system', 'report'].includes(record.kind)).map(record => ({ ...record.payload, id: record.id, kind: record.kind })));
      }
      const results = scoped.filter(record => matches('kind', record.kind));
      if (method === 'PATCH') {
        for (const record of results) record.payload = data.payload;
      }
      return answer(results);
    }
    if (url.pathname === '/storage/v1/object/audit-private' && method === 'DELETE') {
      for (const name of data.prefixes as string[]) {
        assert.ok(name.startsWith(user.id + '/'));
        files.delete(name);
      }
      return answer([]);
    }
    const storage = /^\/storage\/v1\/object\/(?:authenticated\/)?audit-private\/(.+)$/.exec(url.pathname);
    if (storage) {
      const key = storage[1]!;
      assert.ok(key.startsWith(user.id + '/'));
      if (method === 'POST') {
        files.set(key, init?.body as Uint8Array);
        return answer({}, 201);
      }
      const bytes = files.get(key);
      return bytes ? new Response(Buffer.from(bytes)) : answer({}, 404);
    }
    throw new Error('Unexpected fixture request ' + url.pathname);
  }) as typeof fetch;

  const services: IntakeServices = { inspect: async (url, directory) => {
    const id = randomUUID();
    const folder = 'reports/web-audits/' + id;
    await mkdir(join(directory, folder), { recursive: true });
    await writeFile(join(directory, folder, 'light-390.png'), Buffer.from('fixture screenshot'));
    return { id, url, folder, candidates: [element], resources: [], browser: 'fixture', capturedAt: new Date().toISOString(), captures: [{
      id: 'light-390', theme: 'light', width: 390, screenshot: 'light-390.png', issues: [], truncated: false,
      elements: [{ ...element, size: '18px', color: '#123456', bounds: { x: 0, y: 0, width: 80, height: 20 }, rootSize: '16px', parentSize: '16px' }],
    }] };
  } };
  return {
    supabase: new SupabaseWorkspace({ url: 'https://abcdefghijklmnopqrst.supabase.co', publishableKey: 'sb_publishable_fixture_not_a_real_key', fetcher }),
    services, members, files, rejectSource: () => { rejectNextSource = true; }, get savedPassword() { return savedPassword; },
  };
}

async function openServer(backend: ReturnType<typeof fixture>, linkOnly = false) {
  const server = betaServer(origin, backend.supabase, backend.services, linkOnly);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const send = (path: string, options: { cookie?: string; json?: unknown; form?: Record<string, string>; requestOrigin?: string } = {}) => {
    const body = options.json !== undefined ? JSON.stringify(options.json) : options.form ? new URLSearchParams(options.form).toString() : undefined;
    const headers: Record<string, string> = { Host: 'preview.example.test' };
    if (options.cookie) headers.Cookie = options.cookie;
    if (body !== undefined) Object.assign(headers, { Origin: options.requestOrigin ?? origin, 'Content-Length': String(Buffer.byteLength(body)), 'Content-Type': options.form ? 'application/x-www-form-urlencoded' : 'application/json' });
    return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.end(body);
    });
  };
  return { send, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test('hosted links create an invited session, cannot be reused and honor revocation after refresh', async () => {
  const backend = fixture(true);
  const app = await openServer(backend, true);
  try {
    assert.equal((await app.send('/health')).body, 'ok');
    assert.doesNotMatch((await app.send('/sign-in')).body, /type="password"/);
    assert.equal((await app.send('/sign-in', { form: { email: 'alice@example.test', password: 'fixture password' } })).status, 405);
    assert.equal((await app.send('/projects/10000000-0000-4000-8000-000000000001/api/library')).status, 401);
    const form = { token: 'fixture_invitation_link', type: 'invite' };
    assert.equal((await app.send('/activate', { form, requestOrigin: 'https://another.example' })).status, 403);
    const signedIn = await app.send('/activate', { form });
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.location, '/');
    const cookies = signedIn.headers['set-cookie']!;
    assert.equal(cookies.length, 2);
    for (const value of cookies) assert.match(value, /HttpOnly; SameSite=Strict; Max-Age=604800; Secure/);
    const session = cookies.map(value => value.split(';')[0]).join('; ');
    assert.match((await app.send('/', { cookie: session })).body, /Your projects/);
    assert.equal((await app.send('/activate', { form })).status, 400);
    const expiredAccess = '__Host-auditor-session=expired.fixture.token; __Host-auditor-refresh=fixture_refresh';
    const refreshed = await app.send('/', { cookie: expiredAccess });
    assert.equal(refreshed.status, 200);
    assert.match(refreshed.headers['set-cookie']![1]!, /^__Host-auditor-refresh=fixture_rotated;/);
    backend.members.delete(alice.id);
    const revoked = await app.send('/', { cookie: expiredAccess });
    assert.equal(revoked.headers.location, '/sign-in');
    assert.match(revoked.headers['set-cookie']![1]!, /Max-Age=0/);
  } finally { await app.close(); }
});

test('invited sign-in, project and screenshot isolation, saved work after restart, and revocation', async () => {
  const backend = fixture();
  let app = await openServer(backend);
  try {
    assert.equal((await app.send('/')).headers.location, '/sign-in');
    const login = async (email: string) => {
      const result = await app.send('/sign-in', { form: { email, password: 'fixture password' } });
      assert.equal(result.status, 303);
      const cookie = result.headers['set-cookie']![0]!;
      assert.match(cookie, /^__Host-auditor-session=/);
      assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=3600; Secure/);
      assert.doesNotMatch(result.body + cookie, /never-forward-this/);
      return cookie.split(';')[0]!;
    };
    const aliceCookie = await login('alice@example.test');
    const bobCookie = await login('bob@example.test');
    const created = await app.send('/projects', { cookie: aliceCookie, form: { name: 'Alice <private>' } });
    assert.equal(created.status, 303);
    const project = created.headers.location!;
    const otherProject = (await app.send('/projects', { cookie: bobCookie, form: { name: 'Bob' } })).headers.location!;
    assert.doesNotMatch((await app.send('/', { cookie: bobCookie })).body, /Alice/);
    assert.match((await app.send(project, { cookie: aliceCookie })).body, /Alice &lt;private&gt;/);
    assert.equal((await app.send(project + '/api/library')).status, 401);
    assert.equal((await app.send(project + '/api/library', { cookie: bobCookie })).status, 404);
    assert.equal((await app.send(project + '/api/import', { cookie: aliceCookie, json: {}, requestOrigin: 'https://elsewhere.example' })).status, 403);

    backend.rejectSource();
    assert.equal((await app.send(project + '/api/import', { cookie: aliceCookie, json: { type: 'text', value: 'Body: 16px' } })).status, 503);
    assert.equal(backend.files.size, 0);
    const imported = await app.send(project + '/api/import', { cookie: aliceCookie, json: { type: 'text', value: 'Body: 16px, #123456' } });
    assert.equal(imported.status, 200, imported.body);
    const source = JSON.parse(imported.body);
    assert.equal(source.original, undefined);
    assert.ok([...backend.files.keys()].some(key => key.endsWith(source.id + '.source')));
    const original = '/api/sources/' + source.id + '/original';
    assert.equal((await app.send(otherProject + original, { cookie: bobCookie })).status, 404);
    assert.equal((await app.send(project + original, { cookie: aliceCookie })).body, 'Body: 16px, #123456');
    const saved = await app.send(project + '/api/save', { cookie: aliceCookie, json: { name: 'Rules', rules: source.rules, sourceIds: [source.id], reviewed: true } });
    assert.equal(saved.status, 200, saved.body);
    const system = JSON.parse(saved.body);
    assert.equal((await app.send(otherProject + '/api/systems/' + system.id, { cookie: bobCookie })).status, 404);

    const capture = await app.send(project + '/api/inspect', { cookie: aliceCookie, json: { systemId: system.id, url: 'https://example.test/', themes: ['light'] } });
    assert.equal(capture.status, 202, capture.body);
    const jobPath = project + '/api/jobs/' + JSON.parse(capture.body).id;
    assert.equal((await app.send(jobPath, { cookie: bobCookie })).status, 404);
    let job;
    for (let attempts = 0; attempts < 50; attempts++) {
      job = JSON.parse((await app.send(jobPath, { cookie: aliceCookie })).body);
      if (job.state !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(job.state, 'done', JSON.stringify(job));
    const shot = '/api/screenshots/' + job.result.id + '/light-390';
    assert.equal((await app.send(otherProject + shot, { cookie: bobCookie })).status, 404);
    const audited = await app.send(project + '/api/audit', { cookie: aliceCookie, json: {
      systemId: system.id, targetId: job.result.id, reviewed: true,
      mappings: [{ ruleId: system.rules[0].id, elementIds: ['body'] }],
    } });
    assert.equal(audited.status, 200, audited.body);
    const report = JSON.parse(audited.body);
    assert.equal(report.differences.length, 1);

    await app.close();
    app = await openServer(backend);
    assert.equal((await app.send(project + shot, { cookie: aliceCookie })).body, 'fixture screenshot');
    assert.equal((await app.send(project + shot, { cookie: bobCookie })).status, 404);
    const reopened = await app.send(project + '/api/systems/' + system.id, { cookie: aliceCookie });
    assert.equal(JSON.parse(reopened.body).sources[0].text, 'Body: 16px, #123456');
    const reopenedReport = await app.send(project + '/api/reports/' + report.id, { cookie: aliceCookie });
    assert.equal(JSON.parse(reopenedReport.body).report.differences.length, 1);
    assert.equal((await app.send(project + '/api/reports/' + report.id, { cookie: bobCookie })).status, 404);

    backend.members.delete(alice.id);
    assert.equal((await app.send(project + shot, { cookie: aliceCookie })).status, 401);
    assert.equal((await app.send('/sign-in', { form: { email: 'alice@example.test', password: 'fixture password' } })).status, 401);
    const logout = await app.send('/sign-out', { cookie: bobCookie, form: {} });
    assert.match(logout.headers['set-cookie']![0]!, /Max-Age=0/);
  } finally { await app.close(); }
});

test('password setup checks membership and consumes a hashed invitation once', async () => {
  const backend = fixture();
  const app = await openServer(backend);
  try {
    const activation = { type: 'invite', token: 'fixture_invitation_link', password: 'fixture new password' };
    const saved = await app.send('/activate', { form: activation });
    assert.equal(saved.status, 200);
    assert.equal(saved.headers['set-cookie'], undefined);
    assert.equal(backend.savedPassword, true);
    assert.doesNotMatch(saved.body, /fixture_invitation_link|fixture new password/);
    assert.equal((await app.send('/activate', { form: activation })).status, 400);
    assert.equal((await app.send('/activate', { form: { ...activation, token: alice.token } })).status, 200);
    backend.members.delete(alice.id);
    assert.equal((await app.send('/activate', { form: { ...activation, token: alice.token } })).status, 400);
  } finally { await app.close(); }
});
