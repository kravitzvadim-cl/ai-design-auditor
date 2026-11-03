/** Read-only hosted readiness checks. Never creates users or requests admin keys. */
export type SupabasePreflight = {
  ready: boolean;
  signupDisabled: boolean;
  checks: { name: string; status: number; passed: boolean }[];
};
export async function checkSupabase(url: string, publishableKey: string, fetcher: typeof fetch = fetch): Promise<SupabasePreflight> {
  // This project uses hosted Supabase. Reject credentials, paths, alternate ports
  // and lookalike hosts before sending even a low-privilege configuration key.
  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)) throw new Error('Use the hosted Supabase project URL, without a path or credentials.');
  if (!/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(publishableKey)) throw new Error('Use a modern Supabase publishable key. Privileged keys are not accepted by this check.');
  const checks: SupabasePreflight['checks'] = [];
  let signupDisabled = false;
  const paths = [
    ['signup', '/auth/v1/settings'],
    ['anonymous membership read', '/rest/v1/app_members?select=user_id'],
    ['anonymous project read', '/rest/v1/audit_projects?select=id'],
    ['anonymous record read', '/rest/v1/audit_records?select=id'],
    ['invalid session', '/auth/v1/user'],
  ] as const;
  for (const [name, path] of paths) {
    const headers: Record<string, string> = { apikey: publishableKey };
    if (name === 'invalid session') headers.Authorization = 'Bearer invalid-preflight-token';
    let response: Response;
    try { response = await fetcher(url + path, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error(`Supabase ${name} check could not complete. No readiness result is asserted.`); }
    if (name === 'signup') {
      try { const data: unknown = await response.json(); signupDisabled = response.status === 200 && !!data && typeof data === 'object' && (data as Record<string, unknown>).disable_signup === true; }
      catch { signupDisabled = false; }
      checks.push({ name, status: response.status, passed: signupDisabled });
    } else {
      // A successful empty read is not evidence of denied authorization.
      checks.push({ name, status: response.status, passed: [401, 403].includes(response.status) });
      await response.body?.cancel();
    }
  }
  return { ready: checks.every(check => check.passed), signupDisabled, checks };
}
