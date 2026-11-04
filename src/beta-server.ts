import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { intakeHandler } from './intake-server.js';
import type { IntakeServices } from './intake-server.js';
import { auditPalette, intakeHTML, intakeStyle, proofPinFavicon, proofPinMark } from './intake-view.js';
import { accessToken, SupabaseUnavailable, SupabaseWorkspace, uuid } from './supabase-workspace.js';

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} · AI Auditor</title>${proofPinFavicon}<style>${intakeStyle}${auditPalette}</style></head><body class="audit-theme"><header class="header"><div class="brand">${proofPinMark}<span>AI Auditor</span></div><span>Invited beta</span></header><main style="max-width:600px"><section class="panel"><h1>${escape(title)}</h1>${body}</section></main></body></html>`;
const signOutForm = '<form method="post" action="/sign-out"><button type="submit">Sign out</button></form>';
const passwordField = (autocomplete: string, minimum: number) => `<div class="field"><label for="password">Password</label><input id="password" name="password" type="password" required minlength="${minimum}" maxlength="128" autocomplete="${autocomplete}"></div>`;
const signInPage = (notice = '') => page('Sign in', `<p>Use the email address on your invitation.</p>${notice ? `<p class="status" role="status">${escape(notice)}</p>` : ''}<form method="post" action="/sign-in"><div class="field"><label for="email">Email</label><input id="email" name="email" type="email" required maxlength="254" autocomplete="username"></div>${passwordField('current-password', 1)}<div class="actions"><button class="primary" type="submit">Sign in</button></div></form>`);
const activatePage = (notice = '') => page('Set your password', `<p>Choose a password with at least 12 characters.</p><p id="activation-status" class="status" role="status">${escape(notice)}</p><form id="activation" method="post" action="/activate"><input type="hidden" name="token"><input type="hidden" name="type">${passwordField('new-password', 12)}<div class="actions"><button class="primary" type="submit" disabled>Save password</button><a href="/sign-in">Back to sign in</a></div></form><script type="module" src="/beta-activate.js"></script>`);
const linkPage = () => page('Sign in to the beta', '<p>Open the private sign-in link from your invitation. If your link has expired, ask the person who invited you for a fresh one.</p><p><a href="https://ai-design-auditor-beta-access.onrender.com/">Request beta access</a></p>');
const redeemPage = (notice = '') => page('Open your workspace', `<p id="activation-status" class="status" role="status">${escape(notice)}</p><form id="activation" method="post" action="/activate"><input type="hidden" name="token"><input type="hidden" name="type"><button class="primary" type="submit" disabled>Continue to AI Auditor</button></form><script type="module" src="/beta-activate.js"></script>`);
const refreshPattern = /^[A-Za-z0-9_-]{8,256}$/;
const linkSessionAge = 7 * 24 * 60 * 60;

async function form(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';', 1)[0] !== 'application/x-www-form-urlencoded') return;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 8192) return;
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function betaServer(origin: string, supabase: SupabaseWorkspace, services: IntakeServices = {}, linkOnly = false) {
  const expected = new URL(origin);
  const local = expected.protocol === 'http:' && expected.hostname === '127.0.0.1';
  if (origin !== expected.origin || (!local && expected.protocol !== 'https:')) throw new Error('Use an exact HTTPS origin or the loopback preview address.');
  const cookieName = local ? 'auditor-preview-session' : '__Host-auditor-session';
  const refreshName = local ? 'auditor-preview-refresh' : '__Host-auditor-refresh';
  const cookie = (token: string, maxAge: number, name = cookieName) => `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${local ? '' : '; Secure'}`;
  const intake = intakeHandler(process.cwd(), services);
  return createServer({ requestTimeout: 35_000, headersTimeout: 10_000 }, async (request, response) => {
    const html = (status: number, body: string) => { response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(body); };
    const json = (status: number, error: string) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error })); };
    const redirect = (location: string) => { response.writeHead(303, { Location: location }); response.end(); };
    response.setHeader('Cache-Control', 'no-store');
    // Keep same-origin form POSTs identifiable without sending referrers off-site.
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Robots-Tag', 'noindex');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(request.url ?? '/', origin);
      const path = url.pathname;
      if (linkOnly && request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        return response.end('ok');
      }
      if (request.headers.host !== expected.host || url.origin !== origin) return json(403, 'Use the workspace address.');
      if (request.method !== 'GET' && (request.method !== 'POST' || request.headers.origin !== origin)) return json(403, 'Use the workspace to submit this action.');
      const cookies = request.headers.cookie?.split(';').map(value => value.trim()) ?? [];
      const readCookie = (name: string) => cookies.find(value => value.startsWith(name + '='))?.slice(name.length + 1) ?? '';
      const token = readCookie(cookieName);
      const refreshToken = linkOnly ? readCookie(refreshName) : '';
      const setSession = (session: { member: { token: string }; refreshToken: string }) => {
        response.setHeader('Set-Cookie', [cookie(session.member.token, linkSessionAge), cookie(session.refreshToken, linkSessionAge, refreshName)]);
      };
      const clearSession = () => response.setHeader('Set-Cookie', linkOnly ? [cookie('', 0), cookie('', 0, refreshName)] : cookie('', 0));
      if (linkOnly && path === '/sign-in') return html(request.method === 'GET' ? 200 : 405, linkPage());
      if (path === '/sign-in' && request.method === 'GET') return html(200, signInPage());
      if (path === '/sign-in') {
        const data = await form(request);
        const email = data?.get('email')?.trim() ?? '';
        const password = data?.get('password') ?? '';
        const session = email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) && password.length > 0 && password.length <= 128
          ? await supabase.signIn(email, password) : undefined;
        if (!session) return html(401, signInPage('Sign-in failed. Check your email, password and invitation.'));
        response.setHeader('Set-Cookie', cookie(session.token, session.maxAge));
        return redirect('/');
      }
      if (path === '/activate' && request.method === 'GET') return html(200, linkOnly ? redeemPage() : activatePage());
      if (path === '/beta-activate.js' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' });
        return response.end(await readFile(new URL('./beta-activate.js', import.meta.url)));
      }
      if (path === '/activate') {
        const data = await form(request);
        const token = data?.get('token') ?? '';
        const type = data?.get('type');
        if (linkOnly) {
          const session = (type === 'invite' || type === 'magiclink') && /^[A-Za-z0-9_-]{16,256}$/.test(token)
            ? await supabase.redeemLink(token, type) : undefined;
          if (!session) return html(400, redeemPage('This link has expired or was already used. Ask for a fresh link.'));
          setSession(session);
          return redirect('/');
        }
        const password = data?.get('password') ?? '';
        let saved = false;
        if ((type === 'invite' || type === 'recovery') && password.length >= 12 && Buffer.byteLength(password) <= 72) {
          if (/^[A-Za-z0-9_-]{16,256}$/.test(token)) saved = await supabase.finishPassword(token, type, password);
          else if (token.length <= 3500 && accessToken.test(token)) saved = await supabase.changePassword(token, password);
        }
        if (!saved) {
          return html(400, activatePage('This link could not set your password. Ask for a fresh link.'));
        }
        return html(200, signInPage('Password saved. You can sign in now.'));
      }
      if (path === '/sign-out' && request.method === 'POST') {
        clearSession();
        if (token.length <= 3500 && accessToken.test(token)) await supabase.signOut(token).catch(() => {});
        return redirect('/sign-in');
      }
      let member = await supabase.member(token);
      if (!member && refreshPattern.test(refreshToken)) {
        const session = await supabase.refreshLink(refreshToken);
        if (session) {
          member = session.member;
          setSession(session);
        }
      }
      if (!member) {
        if (token || refreshToken) clearSession();
        if (path.includes('/api/') || path.endsWith('.js') || request.method === 'POST') return json(401, 'Sign in to open this workspace.');
        return redirect('/sign-in');
      }
      if (path === '/projects' && request.method === 'POST') {
        const name = (await form(request))?.get('name')?.trim() ?? '';
        if (!name || name.length > 120) return html(400, page('Project name needed', '<p>Use a name between 1 and 120 characters.</p><p><a href="/">Back to projects</a></p>'));
        if ((await supabase.projects(member)).length >= 20) return html(409, page('Project limit reached', '<p>You can keep up to 20 projects in this preview.</p><p><a href="/">Back to projects</a></p>'));
        return redirect(`/projects/${await supabase.createProject(member, name)}`);
      }
      if (path === '/' && request.method === 'GET') {
        const projects = await supabase.projects(member);
        const list = projects.map(project => `<li><a href="/projects/${escape(project.id)}">${escape(project.name)}</a></li>`).join('');
        return html(200, page('Your projects', `${list ? `<ul>${list}</ul>` : '<p>Create a project to save your rules and audits.</p>'}<form method="post" action="/projects"><div class="field"><label for="name">Project name</label><input id="name" name="name" required maxlength="120"></div><div class="actions"><button class="primary" type="submit">Create project</button></div></form><div class="actions">${signOutForm}</div>`));
      }
      if (request.method === 'GET' && ['/intake-client.js', '/web-audit-client.js'].includes(path)) {
        response.writeHead(200, { 'Content-Type': 'text/javascript' });
        return response.end(await readFile(new URL('.' + path, import.meta.url)));
      }
      const match = /^\/projects\/([^/]+)(\/api\/.*)?$/.exec(path);
      if (!match || !uuid.test(match[1]!)) return json(404, 'Project not found.');
      const project = await supabase.project(member, match[1]!);
      if (!project) return json(404, 'Project not found.');
      if (!match[2] && request.method === 'GET') {
        return html(200, intakeHTML
          .replace('<span>Local design-system audit</span>', () => `<div class="actions"><a href="/">Your projects</a>${signOutForm}</div>`)
          .replace('<main id="main">', () => `<main id="main"><section class="panel" style="margin-bottom:24px"><h2>${escape(project.name)}</h2><div id="private-library"></div></section>`)
          .replace('Sources and evidence stay in local files. AI interpretation sends extracted source text or page text to OpenRouter when you request it. This local workspace is not a hosted multi-user service.', 'Saved rules and audit evidence are private to your account.'));
      }
      if (!match[2]) return json(404, 'Project action not found.');
      await intake(request, response, { origin, path: match[2], store: supabase.store(member, project.id) });
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof SupabaseUnavailable) return json(503, error.message);
      return json(500, 'The workspace could not complete this request.');
    }
  });
}
