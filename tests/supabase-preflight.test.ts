import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSupabase } from '../src/supabase-preflight.js';
const url = 'https://abcdefghijklmnopqrst.supabase.co';
const key = 'sb_publishable_fixture_not_a_real_key';
test('Supabase preflight requires signup disabled and rejects successful anonymous reads', async () => {
  for (const signup of [true, false, undefined]) for (const readStatus of [200, 401, 403]) for (const sessionStatus of [200, 401, 403]) {
    const fake = (async (input: string | URL | Request) => String(input).endsWith('/settings') ? Response.json({ disable_signup: signup }) : new Response('', { status: String(input).endsWith('/user') ? sessionStatus : readStatus })) as typeof fetch;
    const result = await checkSupabase(url, key, fake);
    assert.equal(result.ready, signup === true && readStatus !== 200 && sessionStatus !== 200);
    assert.equal(result.signupDisabled, signup === true);
  }
});
test('Supabase preflight validates destination and key before sending requests', async () => {
  let calls = 0;
  const fake = (async () => { calls++; return Response.json({}); }) as typeof fetch;
  for (const bad of ['http://abcdefghijklmnopqrst.supabase.co', url + '.evil.example', url + '/', url + ':443', 'https://user:password@abcdefghijklmnopqrst.supabase.co', url + '?key=example']) await assert.rejects(checkSupabase(bad, key, fake), /project URL/);
  for (const bad of ['', 'sb_secret_fixture_not_a_real_key', 'legacy-token']) await assert.rejects(checkSupabase(url, bad, fake), /publishable key/);
  assert.equal(calls, 0);
});
test('Supabase preflight keeps transport errors and provider data out of output', async () => {
  const fake = (async () => { throw new Error('Provider error with sensitive session text'); }) as typeof fetch;
  await assert.rejects(checkSupabase(url, key, fake), error => error instanceof Error && /could not complete/.test(error.message) && !error.message.includes('sensitive'));
  const calls: { authorization: string | null; redirect: RequestRedirect | undefined }[] = [];
  const guarded = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ authorization: new Headers(init?.headers).get('Authorization'), redirect: init?.redirect });
    return String(input).endsWith('/settings') ? Response.json({ disable_signup: true }) : new Response('', { status: 401 });
  }) as typeof fetch;
  assert.equal((await checkSupabase(url, key, guarded)).ready, true);
  assert.ok(calls.every(call => call.redirect === 'error'));
  assert.ok(calls.slice(0, 4).every(call => call.authorization === null));
  assert.equal(calls[4]!.authorization, 'Bearer invalid-preflight-token');
});
