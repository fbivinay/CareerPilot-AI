#!/usr/bin/env node
// One-time Gmail authorization (OAuth 2.0 installed-app flow with PKCE and a loopback redirect).
//   npm run gmail:auth             -> saves the refresh token to careerpilot/.env (gitignored)
//   npm run gmail:auth -- --github -> also stores it as the GitHub Actions secret GMAIL_REFRESH_TOKEN
// The token is never printed. Client credentials come from careerpilot/.env, or from the OAuth client
// JSON downloaded from Google Cloud and saved as careerpilot/private/google-oauth-client.json (gitignored).
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GMAIL_SCOPES } from '../lib/gmail.mjs';

const ENV_FILE = path.resolve(import.meta.dirname, '..', '.env');
const CLIENT_JSON = path.resolve(import.meta.dirname, '..', 'private', 'google-oauth-client.json');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function setEnv(name, value) {
  const lines = (existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '').split(/\r?\n/).filter(Boolean);
  const i = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (i >= 0) lines[i] = `${name}=${value}`; else lines.push(`${name}=${value}`);
  writeFileSync(ENV_FILE, lines.join('\n') + '\n');
  process.env[name] = value;
}

if ((!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) && existsSync(CLIENT_JSON)) {
  const json = JSON.parse(readFileSync(CLIENT_JSON, 'utf8'));
  const c = json.installed ?? json.web;
  if (!json.installed) console.warn('Warning: this is not a "Desktop app" OAuth client; create a Desktop app client if consent fails.');
  if (!c?.client_id || !c?.client_secret) throw new Error('private/google-oauth-client.json has no client_id/client_secret');
  setEnv('GOOGLE_CLIENT_ID', c.client_id);
  setEnv('GOOGLE_CLIENT_SECRET', c.client_secret);
  console.log('Loaded the OAuth client from private/google-oauth-client.json into careerpilot/.env.');
}
const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId || !clientSecret) {
  console.error('No OAuth client found. Save the downloaded Desktop-app JSON as careerpilot/private/google-oauth-client.json (see SETUP.md).');
  process.exit(1);
}

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('hex');

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: GMAIL_SCOPES.join(' '),
  access_type: 'offline',
  prompt: 'consent',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
  ...(process.env.GMAIL_ADDRESS ? { login_hint: process.env.GMAIL_ADDRESS } : {}),
});

console.log('Opening your browser for Google consent. If it does not open, visit:\n' + authUrl + '\n');
const opener = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', authUrl]]
  : process.platform === 'darwin' ? ['open', [authUrl]] : ['xdg-open', [authUrl]];
spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();

const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { server.close(); reject(new Error('timed out waiting for consent (10 min)')); }, 10 * 60_000);
  server.on('request', (req, res) => {
    const u = new URL(req.url, redirectUri);
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' })
      .end(ok ? 'CareerPilot: Gmail authorized. You can close this tab.' : 'Authorization failed or was cancelled.');
    clearTimeout(timer);
    server.close();
    ok ? resolve(u.searchParams.get('code')) : reject(new Error(u.searchParams.get('error') ?? 'state mismatch'));
  });
});

const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
    grant_type: 'authorization_code', code_verifier: verifier }),
});
const tokens = await res.json();
if (!res.ok || !tokens.refresh_token) {
  console.error(`Token exchange failed: ${tokens.error ?? res.status}. Remove CareerPilot at https://myaccount.google.com/permissions and retry.`);
  process.exit(1);
}
const granted = (tokens.scope ?? '').split(' ');
const missing = GMAIL_SCOPES.filter((s) => !granted.includes(s));
if (missing.length) console.warn('Warning: these scopes were not granted (tick every box on the consent screen):', missing.join(', '));

setEnv('GMAIL_REFRESH_TOKEN', tokens.refresh_token);
console.log('Saved GMAIL_REFRESH_TOKEN to careerpilot/.env (gitignored).');

// Record which mailbox was authorized, so the pipeline and the digest use the candidate's own address.
const me = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
  headers: { authorization: `Bearer ${tokens.access_token}` },
})).json();
if (me.emailAddress) {
  setEnv('GMAIL_ADDRESS', me.emailAddress);
  console.log(`Authorized mailbox: ${me.emailAddress}`);
}

if (process.argv.includes('--github')) {
  execFileSync('gh', ['secret', 'set', 'GMAIL_REFRESH_TOKEN', '--repo', 'fbivinay/CareerPilot-AI'], { input: tokens.refresh_token, stdio: ['pipe', 'inherit', 'inherit'] });
  console.log('Stored GMAIL_REFRESH_TOKEN as a GitHub Actions secret.');
}
