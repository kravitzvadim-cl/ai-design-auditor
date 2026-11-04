// Run locally after approving the request in the Supabase Table Editor.
try { process.loadEnvFile(); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('Local configuration could not be loaded.'); }

const { SUPABASE_URL: url, SUPABASE_ADMIN_KEY: key } = process.env;
const email = process.argv[2]?.trim().toLowerCase() ?? '';
const origin = 'https://ai-design-auditor-beta.onrender.com';

async function request(path, options = {}) {
  return fetch(url + path, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { apikey: key, 'Content-Type': 'application/json', ...options.headers },
  });
}

async function generate(type) {
  return request('/auth/v1/admin/generate_link', { method: 'POST', body: JSON.stringify({ type, email }) });
}

async function approvedLink() {
  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url ?? '') || !/^sb_secret_[A-Za-z0-9_-]+$/.test(key ?? '')) {
    throw new Error('Set SUPABASE_URL and SUPABASE_ADMIN_KEY in the ignored local .env.');
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Provide the approved tester’s email address.');
  const approval = await request('/rest/v1/beta_access_requests?' + new URLSearchParams({
    email: 'eq.' + email, status: 'eq.approved', select: 'id', limit: '1',
  }));
  if (!approval.ok) throw new Error('Could not check the approved requests.');
  if (!(await approval.json()).length) throw new Error('Approve this email in the beta_access_requests table first.');

  let response = await generate('invite');
  let link = await response.json();
  if (response.status === 422 && link.error_code === 'email_exists') {
    response = await generate('magiclink');
    link = await response.json();
  }
  const type = link.verification_type;
  if (!response.ok || link.email?.toLowerCase() !== email ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(link.id ?? '') ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(link.hashed_token ?? '') ||
      !['invite', 'magiclink'].includes(type)) throw new Error('Supabase could not create a sign-in link for this request.');

  if (type === 'invite') {
    // Admin generateLink can set invited_at after INSERT. Grant membership explicitly
    // for an approved request and preserve any existing decision to revoke access.
    const result = await request('/rest/v1/app_members?on_conflict=user_id', {
      method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: link.id }),
    });
    if (!result.ok) throw new Error('Could not provision membership for this invitation.');
  }
  const members = await request('/rest/v1/app_members?' + new URLSearchParams({
    user_id: 'eq.' + link.id, active: 'eq.true', select: 'user_id', limit: '1',
  }));
  if (!members.ok || !(await members.json()).length) throw new Error('This account does not have active beta access.');
  return origin + '/activate#' + new URLSearchParams({ token_hash: link.hashed_token, type });
}

try {
  process.stdout.write(await approvedLink() + '\n');
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Link generation failed.') + '\n');
  process.exitCode = 1;
}
