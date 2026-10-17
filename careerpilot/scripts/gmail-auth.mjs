#!/usr/bin/env node
// One-time Gmail authorization (OAuth 2.0 installed-app flow with PKCE and a loopback redirect).
//   npm run gmail:auth            -> saves the refresh token to careerpilot/.env (gitignored)
//   npm run gmail:auth -- --github -> also stores it as the GitHub Actions secret GMAIL_REFRESH_TOKEN
// The token is never printed. Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in careerpilot/.env.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GMAIL_SCOPES } from '../lib/gmail.mjs';

const ENV_FILE = path.resolve(import.meta.dirname, '..', '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in careerpilot/.env first (see SETUP.md).');
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
const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', authUrl.replace(/&/g, '^&')]]
  : process.platform === 'darwin' ? ['open', [authUrl]] : ['xdg-open', [authUrl]];
spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref();

const code = await new Promise((resolve, reject) => {
  server.on('request', (req, res) => {
    const u = new URL(req.url, redirectUri);
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' })
      .end(ok ? 'CareerPilot: Gmail authorized. You can close this tab.' : 'Authorization failed or was cancelled.');
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
  console.error(`Token exchange failed: ${tokens.error ?? res.status}. Remove the app at myaccount.google.com/permissions and retry.`);
  process.exit(1);
}
const granted = (tokens.scope ?? '').split(' ');
const missing = GMAIL_SCOPES.filter((s) => !granted.includes(s));
if (missing.length) console.warn('Warning: not all scopes were granted:', missing.join(', '));

let env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
env = /^GMAIL_REFRESH_TOKEN=.*$/m.test(env)
  ? env.replace(/^GMAIL_REFRESH_TOKEN=.*$/m, `GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`)
  : env.replace(/\n?$/, `\nGMAIL_REFRESH_TOKEN=${tokens.refresh_token}\n`);
writeFileSync(ENV_FILE, env);
console.log('Saved GMAIL_REFRESH_TOKEN to careerpilot/.env (gitignored).');

if (process.argv.includes('--github')) {
  execFileSync('gh', ['secret', 'set', 'GMAIL_REFRESH_TOKEN'], { input: tokens.refresh_token, stdio: ['pipe', 'inherit', 'inherit'] });
  console.log('Stored GMAIL_REFRESH_TOKEN as a GitHub Actions secret.');
}
