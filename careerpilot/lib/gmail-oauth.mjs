// Gmail connection through the dashboard's "Connect Gmail" button (OAuth 2.0 web-server flow with
// PKCE and state). The refresh token is encrypted with APP_ENCRYPTION_KEY and kept in the database
// vault, so GitHub Actions can read mail and send while the candidate's PC is off. Nothing secret is
// ever logged, printed, or put in a URL.
//
// Two stages, as required: first only gmail.readonly is requested; sending (gmail.send) can be added
// later through incremental authorization, and only after a read-only test has passed.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { kvGet, kvSet, now, run } from './db.mjs';
import { decrypt, encrypt, vaultGet, vaultPut } from './vault.mjs';
import { READ_SCOPE, SEND_SCOPE, createGmail } from './gmail.mjs';
import { classifyEmail } from './email-intel.mjs';

const VAULT_NAME = 'gmail.oauth';
const STATE_TTL_MS = 10 * 60_000;
export const OAUTH_COOKIE = 'cp_gmail_oauth';

export function oauthClient(env = process.env) {
  return env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : null;
}

// The origin the browser is actually using (Host header; Vercel's forwarded host), so Google sends
// the candidate back to the same site where their session cookie lives. APP_BASE_URL overrides it.
// A spoofed Host cannot redirect anywhere useful: Google only accepts registered redirect URIs.
export function originFor(request, env = process.env) {
  if (env.APP_BASE_URL) return env.APP_BASE_URL.replace(/\/+$/, '');
  const h = request.headers;
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = (h.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '')).split(',')[0].trim();
  return host ? `${proto}://${host}` : new URL(request.url).origin;
}

// The callback URL must exactly match one registered on the Google OAuth client.
export function redirectUriFor(request, env = process.env) {
  return `${originFor(request, env)}/api/gmail/callback`;
}

// Builds the Google consent URL plus the encrypted cookie that carries state and the PKCE verifier.
export function startAuthorization({ mode, redirectUri, loginHint = null, env = process.env }) {
  const client = oauthClient(env);
  if (!client) throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not configured');
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const scopes = mode === 'send' ? [READ_SCOPE, SEND_SCOPE] : [READ_SCOPE];
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',               // guarantees a refresh token is issued
    include_granted_scopes: 'true',  // adding send keeps the read permission
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  const cookie = encrypt(JSON.stringify({ state, verifier, mode, redirectUri, exp: Date.now() + STATE_TTL_MS }), env);
  return { url, cookie };
}

const sameString = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

// Failures are reported as fixed codes; only these built-in messages are ever shown, so nothing from
// a URL is reflected into the page.
export const CONNECT_ERRORS = {
  declined: 'You declined the permission request.',
  google_error: 'Google returned an error. Please try again.',
  expired: 'The sign-in session expired. Click Connect again.',
  state_mismatch: 'Security check failed. Click Connect again.',
  no_code: 'Google did not return an authorization code. Please try again.',
  exchange_failed: 'Google rejected the authorization. Try again; if it repeats, check the OAuth client settings in SETUP.md.',
  no_read_scope: 'Read access was not granted. Tick the "read your email" box on the consent screen.',
  no_refresh_token: 'Google did not issue a long-lived token. Remove CareerPilot at myaccount.google.com/permissions and connect again.',
};
const fail = (code) => ({ ok: false, code, error: CONNECT_ERRORS[code] });

// Handles Google's redirect back. Returns {ok, code?, error?, email?, scopes?}.
export async function completeAuthorization(db, { query, cookie, env = process.env, fetchImpl = fetch }) {
  if (query.error) return fail(query.error === 'access_denied' ? 'declined' : 'google_error');
  let saved;
  try { saved = JSON.parse(decrypt(cookie, env).toString('utf8')); } catch { return fail('expired'); }
  if (!saved || saved.exp < Date.now()) return fail('expired');
  if (!sameString(saved.state, query.state)) return fail('state_mismatch');
  if (!query.code) return fail('no_code');
  const client = oauthClient(env);
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: query.code, client_id: client.clientId, client_secret: client.clientSecret,
      redirect_uri: saved.redirectUri, grant_type: 'authorization_code', code_verifier: saved.verifier }),
  });
  const tokens = await res.json();
  if (!res.ok) return fail('exchange_failed');
  const scopes = String(tokens.scope ?? '').split(' ').filter(Boolean);
  if (!scopes.includes(READ_SCOPE)) return fail('no_read_scope');
  if (!tokens.refresh_token) return fail('no_refresh_token');
  const profile = await (await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  })).json();
  await saveConnection(db, { refreshToken: tokens.refresh_token, scopes, email: profile.emailAddress ?? null }, env);
  return { ok: true, email: profile.emailAddress ?? null, scopes, sendRequested: saved.mode === 'send', sendGranted: scopes.includes(SEND_SCOPE) };
}

async function saveConnection(db, { refreshToken, scopes, email }, env) {
  await vaultPut(db, VAULT_NAME, JSON.stringify({ refreshToken, scopes, email, connectedAt: now() }), env);
  const prev = await kvGet(db, 'gmail:connection');
  // A different mailbox invalidates the earlier read-only test.
  if (prev?.email && prev.email !== email) await kvSet(db, 'gmail:read_test', null);
  await kvSet(db, 'gmail:connection', { email, scopes, connectedAt: now() });
  await kvSet(db, 'gmail:status', { ok: true, at: now() });
}

export async function loadConnection(db, env = process.env) {
  if (!env.APP_ENCRYPTION_KEY) return null;
  const blob = await vaultGet(db, VAULT_NAME, env).catch(() => null);
  return blob ? JSON.parse(blob.toString('utf8')) : null;
}

// What the dashboard and the pipeline may do right now.
export async function connectionStatus(db, env = process.env) {
  const meta = await kvGet(db, 'gmail:connection');
  const readTest = await kvGet(db, 'gmail:read_test');
  const health = await kvGet(db, 'gmail:status');
  const scopes = meta?.scopes ?? [];
  const connected = Boolean(meta) && health?.ok !== false;
  return {
    configured: Boolean(oauthClient(env)) && Boolean(env.APP_ENCRYPTION_KEY),
    connected,
    email: meta?.email ?? null,
    canRead: connected && scopes.includes(READ_SCOPE),
    sendGranted: scopes.includes(SEND_SCOPE),
    readTest,
    // Sending needs both the send permission and a passed read-only test with this mailbox.
    canSend: connected && scopes.includes(SEND_SCOPE) && readTest?.ok === true && readTest.email === meta?.email,
    error: health?.ok === false ? health.error : null,
  };
}

export async function gmailClient(db, env = process.env, fetchImpl = fetch) {
  const conn = await loadConnection(db, env);
  const client = oauthClient(env);
  if (!conn || !client) return null;
  return createGmail({ ...client, refreshToken: conn.refreshToken, fetchImpl,
    onRefreshToken: (token) => saveConnection(db, { ...conn, refreshToken: token }, env) });
}

// Read-only check: refresh the token, read the profile, list and parse recent mail, classify it in
// memory. Only counts are stored; no message content is kept.
export async function runReadTest(db, env = process.env, fetchImpl = fetch) {
  const gmail = await gmailClient(db, env, fetchImpl);
  if (!gmail) return { ok: false, error: 'Gmail is not connected.' };
  try {
    const profile = await gmail.profile();
    const ids = await gmail.listIds('newer_than:14d -in:chats', 25);
    const categories = {};
    const samples = [];
    for (const id of ids) {
      const msg = await gmail.get(id);
      const { category } = classifyEmail(msg);
      categories[category] = (categories[category] ?? 0) + 1;
      if (category !== 'other' && samples.length < 10) samples.push({ date: msg.date, from: msg.fromAddr.split('@')[1] ?? '', subject: String(msg.subject).slice(0, 90), category });
    }
    const summary = { ok: true, at: now(), email: profile.emailAddress, messagesInMailbox: profile.messagesTotal, fetched: ids.length, categories };
    await kvSet(db, 'gmail:read_test', summary);
    return { ...summary, samples };
  } catch (err) {
    await kvSet(db, 'gmail:read_test', { ok: false, at: now(), error: String(err.message).slice(0, 200) });
    return { ok: false, error: err.message };
  }
}

// Revoke at Google, then forget the token. Revocation failure (already revoked) still disconnects.
export async function disconnect(db, env = process.env, fetchImpl = fetch) {
  const conn = await loadConnection(db, env);
  if (conn?.refreshToken) {
    await fetchImpl('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: conn.refreshToken }),
    }).catch(() => null);
  }
  await run(db, 'DELETE FROM vault WHERE name = ?', [VAULT_NAME]);
  for (const key of ['gmail:connection', 'gmail:read_test', 'gmail:status']) await kvSet(db, key, null);
}

export async function markAuthFailure(db, message) {
  await kvSet(db, 'gmail:status', { ok: false, at: now(), error: message });
}

// Gmail push → Pub/Sub → /api/gmail/push: start the Gmail-only sync on GitHub (careerpilot-gmail.yml). The
// dashboard holds no Gmail key, only a token that can start this repository's workflows. Returns the HTTP
// status; Pub/Sub delivers again after any non-2xx one. A repeat within 30 seconds of a started run is
// dropped: that run reads Gmail later than the mail it was told about.
const DISPATCH_URL = 'https://api.github.com/repos/fbivinay/CareerPilot-AI/actions/workflows/careerpilot-gmail.yml/dispatches';
export async function handleGmailPush(db, { token, env = process.env, fetchImpl = fetch }) {
  if (!env.GMAIL_PUSH_TOKEN || !env.GITHUB_DISPATCH_TOKEN) return 503;
  const [got, want] = [Buffer.from(String(token ?? '')), Buffer.from(env.GMAIL_PUSH_TOKEN)];
  if (got.length !== want.length || !timingSafeEqual(got, want)) return 403;
  const last = await kvGet(db, 'gmail:push');
  if (last?.ok && Date.now() - Date.parse(last.at) < 30_000) return 204;
  const res = await fetchImpl(DISPATCH_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main' }),
  });
  await kvSet(db, 'gmail:push', { ok: res.ok, at: now(), ...(res.ok ? {} : { status: res.status }) });
  return res.ok ? 204 : 502;
}
