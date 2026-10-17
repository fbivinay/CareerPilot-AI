// Structured JSON logs. Secrets and personal data are masked before anything is printed,
// because GitHub Actions logs are retained and visible to anyone with repo access.
const SECRET_KEYS = /token|secret|password|authorization|api[_-]?key|cookie|refresh|ciphertext|body|resume|answers/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g;

export function redact(value, key = '') {
  if (value == null) return value;
  if (SECRET_KEYS.test(key)) return '[redacted]';
  if (typeof value === 'string') return value.replace(EMAIL, (m) => m.replace(/^[^@]+/, '***')).replace(PHONE, '[phone]');
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}

const write = (level) => (msg, fields = {}) => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...redact(fields) });
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
};

export const log = { info: write('info'), warn: write('warn'), error: write('error') };
