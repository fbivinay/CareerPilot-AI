// Gmail REST API client (official API, OAuth 2.0). Scopes requested by scripts/gmail-auth.mjs:
//   gmail.readonly – read and classify messages and threads
//   gmail.send     – send applications, outreach and replies (threaded via threadId)
// No modify/compose/full-mail scope is used.
import { decodeEntities } from '../../providers/_html-entities.mjs';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailAuthError extends Error {}

export function gmailConfigured(env = process.env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN);
}

export function createGmail({ env = process.env, fetchImpl = fetch } = {}) {
  let token = null;
  let expires = 0;

  async function accessToken() {
    if (token && Date.now() < expires - 60_000) return token;
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: env.GMAIL_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }),
    });
    const data = await res.json();
    // invalid_grant = token revoked or expired (e.g. 7-day expiry while the OAuth app is in Testing mode).
    if (!res.ok) throw new GmailAuthError(`Gmail authorization failed (${data.error ?? res.status}). Re-run: npm run gmail:auth`);
    token = data.access_token;
    expires = Date.now() + data.expires_in * 1000;
    return token;
  }

  async function api(path, init = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${API}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', ...init.headers },
      });
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (res.status === 401) throw new GmailAuthError('Gmail rejected the access token. Re-run: npm run gmail:auth');
      throw new Error(`Gmail API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  return {
    async listIds(q, max = 200) {
      const ids = [];
      let pageToken;
      do {
        const params = new URLSearchParams({ q, maxResults: '100', ...(pageToken ? { pageToken } : {}) });
        const page = await api(`/messages?${params}`);
        ids.push(...(page.messages ?? []).map((m) => m.id));
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < max);
      return ids.slice(0, max);
    },
    async get(id) {
      return parseMessage(await api(`/messages/${id}?format=full`));
    },
    async send(message) {
      const raw = Buffer.from(buildMime(message)).toString('base64url');
      return api('/messages/send', { method: 'POST', body: JSON.stringify({ raw, ...(message.threadId ? { threadId: message.threadId } : {}) }) });
    },
    async profile() {
      return api('/profile');
    },
  };
}

const b64 = (s) => Buffer.from(s ?? '', 'base64url').toString('utf8');

export function htmlToPlain(html) {
  return decodeEntities(String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export function parseMessage(m) {
  const headers = Object.fromEntries((m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
  let text = '';
  let html = '';
  const attachments = [];
  (function walk(part) {
    if (!part) return;
    if (part.filename) attachments.push({ filename: part.filename, mimeType: part.mimeType });
    else if (part.mimeType === 'text/plain' && part.body?.data) text += b64(part.body.data);
    else if (part.mimeType === 'text/html' && part.body?.data) html += b64(part.body.data);
    for (const p of part.parts ?? []) walk(p);
  })(m.payload);
  // Trust only the Authentication-Results header Gmail's own MX added; a sender can forge others.
  const authResults = (m.payload?.headers ?? []).find((h) => h.name.toLowerCase() === 'authentication-results' && /^\s*mx\.google\.com/i.test(h.value))?.value ?? '';
  const from = headers.from ?? '';
  const addr = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
  const name = from.includes('<') ? from.slice(0, from.indexOf('<')).replace(/"/g, '').trim() : '';
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds ?? [],
    fromAddr: addr,
    fromName: name,
    to: headers.to ?? '',
    subject: headers.subject ?? '',
    messageId: headers['message-id'] ?? null,
    references: headers.references ?? null,
    listUnsubscribe: headers['list-unsubscribe'] ?? null,
    authenticated: fromAuthenticated(authResults, addr),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    snippet: decodeEntities(m.snippet ?? ''),
    text: text || htmlToPlain(html),
    html,
    attachments,
  };
}

// The visible From domain is proven only by DMARC alignment, or by a passing DKIM signature whose
// signing domain is the From domain (or its parent). Plain SPF checks the envelope sender, not From.
export function fromAuthenticated(authResults, fromAddr) {
  if (/\bdmarc=pass\b/i.test(authResults)) return true;
  const domain = String(fromAddr).split('@')[1] ?? '';
  return [...authResults.matchAll(/\bdkim=pass\b[^;]*?header\.(?:i=[^@\s;]*@|d=)([a-z0-9.-]+)/gi)]
    .some(([, d]) => domain && (domain === d.toLowerCase() || domain.endsWith('.' + d.toLowerCase())));
}

const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

// RFC 2822 message with optional PDF attachment and reply threading headers.
export function buildMime({ to, from, subject, text, attachments = [], inReplyTo, references }) {
  const boundary = `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const head = [
    `To: ${to}`,
    ...(from ? [`From: ${from}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${references ? references + ' ' : ''}${inReplyTo}`] : []),
  ];
  const textPart = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(text).toString('base64')];
  if (!attachments.length) return [...head, ...textPart].join('\r\n');
  const parts = [`--${boundary}`, ...textPart];
  for (const a of attachments) {
    parts.push(`--${boundary}`, `Content-Type: ${a.mimeType}; name="${a.filename}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`, '', a.content.toString('base64').replace(/.{76}/g, '$&\r\n'));
  }
  parts.push(`--${boundary}--`);
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
}
