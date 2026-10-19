import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { all, kvGet, openDb } from '../lib/db.mjs';
import { decrypt } from '../lib/vault.mjs';
import { READ_SCOPE, SEND_SCOPE, GmailAuthError } from '../lib/gmail.mjs';
import { completeAuthorization, connectionStatus, disconnect, gmailClient, markAuthFailure, runReadTest, startAuthorization } from '../lib/gmail-oauth.mjs';

const env = { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'csecret', APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
const redirectUri = 'http://127.0.0.1:3000/api/gmail/callback';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const b64 = (s) => Buffer.from(s).toString('base64url');

// A fake Google: token endpoint, Gmail profile/list/get/send, and revoke.
function fakeGoogle({ grantedScope = READ_SCOPE, refreshToken = 'rt-1', email = 'me@example.org' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? String(init.body) : '' });
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(String(init.body));
      if (p.get('grant_type') === 'authorization_code') {
        return json({ access_token: 'at-1', expires_in: 3600, scope: grantedScope, ...(refreshToken ? { refresh_token: refreshToken } : {}) });
      }
      return p.get('refresh_token') === 'revoked' ? json({ error: 'invalid_grant' }, 400) : json({ access_token: 'at-2', expires_in: 3600 });
    }
    if (u.endsWith('/users/me/profile')) return json({ emailAddress: email, messagesTotal: 1234 });
    if (u.includes('/users/me/messages?')) return json({ messages: [{ id: 'm1' }, { id: 'm2' }] });
    if (u.includes('/users/me/messages/m1')) {
      return json({ id: 'm1', threadId: 't1', internalDate: '1792219583000', payload: { mimeType: 'text/plain',
        headers: [{ name: 'From', value: 'Hiring <no-reply@hire.lever.co>' }, { name: 'Subject', value: 'Thank you for applying to Acme' }],
        body: { data: b64('We have received your application.') } } });
    }
    if (u.includes('/users/me/messages/m2')) {
      return json({ id: 'm2', threadId: 't2', internalDate: '1792219583000', payload: { mimeType: 'text/plain',
        headers: [{ name: 'From', value: 'a@b.com' }, { name: 'Subject', value: 'lunch?' }], body: { data: b64('hi') } } });
    }
    if (u.endsWith('/messages/send')) return json({ id: 'sent-1', threadId: 'ts' });
    if (u.startsWith('https://oauth2.googleapis.com/revoke')) return new Response('', { status: 200 });
    return json({ error: 'unexpected ' + u }, 500);
  };
  return { fetchImpl, calls };
}

async function connect(db, google, mode = 'read') {
  const { url, cookie } = startAuthorization({ mode, redirectUri, env });
  const state = new URL(url).searchParams.get('state');
  return completeAuthorization(db, { query: { code: 'auth-code', state }, cookie, env, fetchImpl: google.fetchImpl });
}

test('consent URL asks only for read access first, with PKCE, state and offline access', () => {
  const { url, cookie } = startAuthorization({ mode: 'read', redirectUri, env, loginHint: 'me@example.org' });
  const q = new URL(url).searchParams;
  assert.equal(new URL(url).origin + new URL(url).pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(q.get('scope'), READ_SCOPE);
  assert.equal(q.get('access_type'), 'offline');
  assert.equal(q.get('prompt'), 'consent');
  assert.equal(q.get('include_granted_scopes'), 'true');
  assert.equal(q.get('redirect_uri'), redirectUri);
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('login_hint'), 'me@example.org');
  assert.ok(!url.includes('csecret'), 'client secret never appears in the URL');
  const saved = JSON.parse(decrypt(cookie, env).toString());
  assert.equal(saved.state, q.get('state'));
  assert.equal(createHash('sha256').update(saved.verifier).digest('base64url'), q.get('code_challenge'));
  assert.equal(new URL(startAuthorization({ mode: 'send', redirectUri, env }).url).searchParams.get('scope'), `${READ_SCOPE} ${SEND_SCOPE}`);
});

test('connecting stores the refresh token encrypted; sending stays off until the read test passes', async () => {
  const db = await openDb({ url: ':memory:' });
  const google = fakeGoogle();
  const r = await connect(db, google);
  assert.equal(r.ok, true);
  assert.equal(r.email, 'me@example.org');
  // Exchanged with the PKCE verifier and the exact redirect URI.
  const exchange = new URLSearchParams(google.calls.find((c) => c.body.includes('authorization_code')).body);
  assert.equal(exchange.get('redirect_uri'), redirectUri);
  assert.ok(exchange.get('code_verifier'));
  // Encrypted at rest: the raw token is not in the database.
  const vault = await all(db, 'SELECT ciphertext FROM vault');
  assert.equal(vault.length, 1);
  assert.ok(!vault[0].ciphertext.includes('rt-1'));
  let s = await connectionStatus(db, env);
  assert.deepEqual([s.connected, s.canRead, s.sendGranted, s.canSend], [true, true, false, false]);

  const testResult = await runReadTest(db, env, google.fetchImpl);
  assert.equal(testResult.ok, true);
  assert.equal(testResult.fetched, 2);
  assert.deepEqual(testResult.categories, { application_confirmation: 1, other: 1 });
  // Only counts are persisted, never subjects or bodies.
  const stored = JSON.stringify(await kvGet(db, 'gmail:read_test'));
  assert.ok(!stored.includes('Acme') && !stored.includes('lunch'));
  s = await connectionStatus(db, env);
  assert.equal(s.canSend, false, 'read test alone does not enable sending');

  // Incremental authorization adds send; now sending is enabled.
  const r2 = await connect(db, fakeGoogle({ grantedScope: `${READ_SCOPE} ${SEND_SCOPE}`, refreshToken: 'rt-2' }), 'send');
  assert.equal(r2.sendGranted, true);
  s = await connectionStatus(db, env);
  assert.equal(s.canSend, true);
  // Connecting a different mailbox invalidates the earlier read test.
  await connect(db, fakeGoogle({ grantedScope: `${READ_SCOPE} ${SEND_SCOPE}`, email: 'other@example.org' }), 'send');
  assert.equal((await connectionStatus(db, env)).canSend, false);
});

test('callback rejects forged state, expired sessions, declined consent, missing read scope and missing refresh token', async () => {
  const db = await openDb({ url: ':memory:' });
  const google = fakeGoogle();
  const { cookie } = startAuthorization({ mode: 'read', redirectUri, env });
  assert.equal((await completeAuthorization(db, { query: { code: 'c', state: 'forged' }, cookie, env, fetchImpl: google.fetchImpl })).code, 'state_mismatch');
  assert.match((await completeAuthorization(db, { query: { code: 'c', state: 'x' }, cookie: 'garbage', env, fetchImpl: google.fetchImpl })).error, /expired/);
  assert.match((await completeAuthorization(db, { query: { error: 'access_denied' }, cookie, env })).error, /declined/);
  assert.match((await connect(db, fakeGoogle({ grantedScope: 'openid' }))).error, /Read access was not granted/);
  assert.match((await connect(db, fakeGoogle({ refreshToken: null }))).error, /long-lived token/);
  assert.equal((await connectionStatus(db, env)).connected, false);
});

test('revoked access is detected and disconnect revokes at Google and forgets the token', async () => {
  const db = await openDb({ url: ':memory:' });
  await connect(db, fakeGoogle({ refreshToken: 'revoked' }));
  const gmail = await gmailClient(db, env, fakeGoogle().fetchImpl);
  await assert.rejects(gmail.profile(), GmailAuthError);
  await markAuthFailure(db, 'Gmail authorization failed (invalid_grant). Reconnect Gmail in Settings.');
  assert.equal((await connectionStatus(db, env)).canRead, false);

  const google = fakeGoogle();
  await connect(db, google);
  await disconnect(db, env, google.fetchImpl);
  assert.ok(google.calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/revoke')));
  assert.equal((await all(db, 'SELECT * FROM vault')).length, 0);
  assert.equal((await connectionStatus(db, env)).connected, false);
});

test('a Gmail push starts the Gmail sync on GitHub, once per burst, only with the push token', async () => {
  const { handleGmailPush } = await import('../lib/gmail-oauth.mjs');
  const db = await openDb({ url: ':memory:' });
  const calls = [];
  let status = 204;
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), auth: init.headers.authorization, ref: JSON.parse(init.body).ref }); return new Response(null, { status }); };
  const env = { GMAIL_PUSH_TOKEN: 'push-token-123', GITHUB_DISPATCH_TOKEN: 'gh-token' };
  const push = (token, e = env) => handleGmailPush(db, { token, env: e, fetchImpl });
  assert.equal(await push('push-token-123', {}), 503, 'not set up');
  assert.equal(await push('wrong-token-12'), 403);
  assert.equal(await push(null), 403);
  assert.equal(calls.length, 0);
  assert.equal(await push('push-token-123'), 204);
  assert.deepEqual(calls.map((c) => [c.url.endsWith('/actions/workflows/careerpilot-gmail.yml/dispatches'), c.auth, c.ref]), [[true, 'Bearer gh-token', 'main']]);
  assert.equal(await push('push-token-123'), 204, 'a repeat within 30 seconds');
  assert.equal(calls.length, 1);
  // GitHub refusing (an expired token): Pub/Sub delivers again, and the Overview says so.
  await db.execute(`DELETE FROM kv WHERE key = 'gmail:push'`);
  status = 401;
  assert.equal(await push('push-token-123'), 502);
  assert.deepEqual([(await kvGet(db, 'gmail:push')).ok, (await kvGet(db, 'gmail:push')).status], [false, 401]);
  assert.equal(await push('push-token-123'), 502, 'a failed start is tried again at once');
  assert.equal(calls.length, 3);
});
