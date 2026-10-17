// Dashboard password hashing (scrypt). Stored as "scrypt:<salt>:<hash>" with ':' separators, never '$':
// Next.js expands $NAME inside .env values and would silently corrupt a '$'-separated hash.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('base64')}:${scryptSync(password, salt, 32).toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [scheme, salt, hash] = String(stored).split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return expected.length > 0 && timingSafeEqual(expected, actual);
}
