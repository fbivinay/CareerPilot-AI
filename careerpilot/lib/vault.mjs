// AES-256-GCM encryption for personal data kept in the hosted database
// (candidate profile, master resume PDF). The key lives only in local .env,
// GitHub Actions secrets and Vercel env — never in the database or repository.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { now, one, run } from './db.mjs';

function key(env = process.env) {
  const raw = env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error('APP_ENCRYPTION_KEY is not set');
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return k;
}

export function encrypt(plain, env) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(env), iv);
  const data = Buffer.concat([c.update(Buffer.isBuffer(plain) ? plain : Buffer.from(plain, 'utf8')), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(token, env) {
  const [iv, tag, data] = token.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key(env), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}

export async function vaultPut(db, name, plain, env) {
  await run(db, `INSERT INTO vault (name, ciphertext, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
  [name, encrypt(plain, env), now()]);
}

export async function vaultGet(db, name, env) {
  const row = await one(db, 'SELECT ciphertext FROM vault WHERE name = ?', [name]);
  return row ? decrypt(row.ciphertext, env) : null;
}
