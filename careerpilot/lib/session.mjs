// Single-user dashboard session: an HMAC-signed, expiring cookie (Web Crypto, so it works in
// proxy.js and server code alike). The password itself is checked with scrypt in app/login.
export const COOKIE = 'cp_session';
export const MAX_AGE = 7 * 24 * 3600;

const enc = new TextEncoder();
const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

function secret(env = process.env) {
  const s = env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (32+ chars)');
  return s;
}

export async function createSession(env) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  return `${exp}.${await hmac(secret(env), `v1.${exp}`)}`;
}

export async function verifySession(token, env) {
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  let expected;
  try { expected = await hmac(secret(env), `v1.${exp}`); } catch { return false; }
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
