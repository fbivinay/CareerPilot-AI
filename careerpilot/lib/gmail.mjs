// Gmail REST API client (official API, OAuth 2.0). Authorization comes from the dashboard's
// Connect Gmail button (lib/gmail-oauth.mjs), which grants, in two separate steps:
//   gmail.readonly – read and classify messages and threads (restricted scope)
//   gmail.send     – send applications, outreach and replies (sensitive scope), only after the
//                    read-only test has passed
// No modify/compose/full-mail scope is used.

export const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Google allows 6,000 quota units per user per minute (projects created since May 2026); a full
// message read costs 60, a list 5, a send 100. Calls are paced to stay under 5,400 per rolling minute.
export const QUOTA_PER_MINUTE = 5400;
const RETRY_MS = [2_000, 15_000, 60_000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GmailAuthError extends Error {}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (NAMED[e.toLowerCase()]) return NAMED[e.toLowerCase()];
    const code = e[0] === '#' ? (e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : NaN;
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
  });
}

// creds: {clientId, clientSecret, refreshToken}. onRefreshToken is called if Google ever rotates the token.
export function createGmail({ clientId, clientSecret, refreshToken, fetchImpl = fetch, onRefreshToken = null, quotaPerMinute = QUOTA_PER_MINUTE }) {
  let token = null;
  let expires = 0;
  const spent = []; // [time, units] of calls in the last minute

  async function pace(units) {
    for (;;) {
      while (spent.length && spent[0][0] <= Date.now() - 60_000) spent.shift();
      if (spent.reduce((n, [, u]) => n + u, 0) + units <= quotaPerMinute) { spent.push([Date.now(), units]); return; }
      await sleep(spent[0][0] + 60_000 - Date.now() + 50);
    }
  }

  async function accessToken() {
    if (token && Date.now() < expires - 60_000) return token;
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    const data = await res.json();
    // invalid_grant = access revoked, Google password changed, or the 7-day expiry of an app left in Testing mode.
    if (!res.ok) throw new GmailAuthError(`Gmail authorization failed (${data.error ?? res.status}). Reconnect Gmail in Settings.`);
    if (data.refresh_token && data.refresh_token !== refreshToken && onRefreshToken) await onRefreshToken(data.refresh_token);
    token = data.access_token;
    expires = Date.now() + data.expires_in * 1000;
    return token;
  }

  async function api(path, units, init = {}) {
    for (let attempt = 0; ; attempt++) {
      await pace(units);
      const res = await fetchImpl(`${API}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', ...init.headers },
      });
      if (res.ok) return res.json();
      const body = await res.text();
      // Gmail reports per-user rate limits as 429 or as 403 "rate limit" / "Quota exceeded".
      const limited = res.status === 429 || (res.status === 403 && /rate ?limit|quota exceeded/i.test(body));
      if ((limited || res.status >= 500) && attempt < RETRY_MS.length) {
        await sleep(RETRY_MS[attempt]);
        continue;
      }
      if (res.status === 401) throw new GmailAuthError('Gmail rejected the access token. Reconnect Gmail in Settings.');
      throw new Error(`Gmail API ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  return {
    async listIds(q, max = 200) {
      const ids = [];
      let pageToken;
      do {
        const params = new URLSearchParams({ q, maxResults: '100', ...(pageToken ? { pageToken } : {}) });
        const page = await api(`/messages?${params}`, 5);
        ids.push(...(page.messages ?? []).map((m) => m.id));
        pageToken = page.nextPageToken;
      } while (pageToken && ids.length < max);
      return ids.slice(0, max);
    },
    async get(id) {
      return parseMessage(await api(`/messages/${id}?format=full`, 60));
    },
    // The ids and labels of a conversation's messages, oldest first.
    async thread(id) {
      return (await api(`/threads/${id}?format=minimal`, 10)).messages ?? [];
    },
    async send(message) {
      const raw = Buffer.from(buildMime(message)).toString('base64url');
      return api('/messages/send', 100, { method: 'POST', body: JSON.stringify({ raw, ...(message.threadId ? { threadId: message.threadId } : {}) }) });
    },
    async profile() {
      return api('/profile', 5);
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
    if (part.filename) attachments.push({ filename: part.filename, mimeType: part.mimeType, size: part.body?.size ?? null });
    else if (part.mimeType === 'text/plain' && part.body?.data) text += b64(part.body.data);
    else if (part.mimeType === 'text/html' && part.body?.data) html += b64(part.body.data);
    for (const p of part.parts ?? []) walk(p);
  })(m.payload);
  // Trust only the Authentication-Results header Gmail's own MX added; a sender can forge others.
  const authResults = (m.payload?.headers ?? []).find((h) => h.name.toLowerCase() === 'authentication-results' && /^\s*mx\.google\.com/i.test(h.value))?.value ?? '';
  const { addr, name, valid: fromValid } = parseFrom(headers.from);
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
    authenticated: fromValid && fromAuthenticated(authResults, addr),
    date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null,
    snippet: decodeEntities(m.snippet ?? ''),
    // Quoted history (Gmail's gmail_quote div, <blockquote>) is dropped so replies are judged on new text only.
    text: text || htmlToPlain(html.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ').replace(/<div[^>]+class="[^"]*gmail_quote[\s\S]*$/i, ' ')),
    html,
    attachments,
  };
}

// The visible From domain is proven only by DMARC alignment, or by a passing DKIM signature whose
// signing domain is the From domain (or its parent). Plain SPF checks the envelope sender, not From.
// Every result is bound to the domain of the parsed From address, so a pass for some other domain
// (e.g. the attacker's own, behind a display name that imitates a company) never counts.
export function fromAuthenticated(authResults, fromAddr) {
  const domain = (String(fromAddr).split('@')[1] ?? '').toLowerCase();
  if (!domain) return false;
  const dmarc = String(authResults).match(/\bdmarc=pass\b[^;]*?header\.from=([a-z0-9.-]+)/i);
  if (dmarc && dmarc[1].toLowerCase() === domain) return true;
  return [...String(authResults).matchAll(/\bdkim=pass\b[^;]*?header\.(?:i=[^@\s;]*@|d=)([a-z0-9.-]+)/gi)]
    .some(([, d]) => domain === d.toLowerCase() || domain.endsWith('.' + d.toLowerCase()));
}

// RFC 5322 From parsing that a display name cannot fool: quoted strings and comments are removed
// before looking for the angle address, and anything with more than one address is rejected.
export function parseFrom(header) {
  const raw = String(header ?? '');
  const bare = raw.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\((?:[^()\\]|\\.)*\)/g, '');
  const angles = [...bare.matchAll(/<([^<>]*)>/g)];
  const addr = (angles.length === 1 ? angles[0][1] : angles.length ? '' : bare).trim().toLowerCase();
  if ((bare.match(/</g) ?? []).length > 1 || !/^[^\s@<>",;]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(addr)) {
    return { addr: '', name: raw.replace(/["<>]/g, '').trim().slice(0, 120), valid: false };
  }
  const name = angles.length ? raw.slice(0, raw.lastIndexOf('<')).replace(/"/g, '').trim() : '';
  return { addr, name, valid: true };
}

const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

// RFC 2822 message with optional HTML (the candidate's own formatted email: bold, lists) beside the plain
// text, optional PDF attachment, and reply threading headers.
export function buildMime({ to, from, subject, text, html = null, attachments = [], inReplyTo, references }) {
  const boundary = `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const head = [
    `To: ${to}`,
    ...(from ? [`From: ${from}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${references ? references + ' ' : ''}${inReplyTo}`] : []),
  ];
  const textPart = ['Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(text).toString('base64')];
  const alt = `${boundary}_alt`;
  const bodyPart = html ? [`Content-Type: multipart/alternative; boundary="${alt}"`, '', `--${alt}`, ...textPart, `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', Buffer.from(html).toString('base64').replace(/.{76}/g, '$&\r\n'), `--${alt}--`]
    : textPart;
  if (!attachments.length) return [...head, ...bodyPart].join('\r\n');
  const parts = [`--${boundary}`, ...bodyPart];
  for (const a of attachments) {
    parts.push(`--${boundary}`, `Content-Type: ${a.mimeType}; name="${a.filename}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.filename}"`, '', a.content.toString('base64').replace(/.{76}/g, '$&\r\n'));
  }
  parts.push(`--${boundary}--`);
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join('\r\n');
}
