// Free-tier LLM providers behind one OpenAI-compatible adapter, with fallback, quota cooldowns,
// response caching, structured (JSON) output validation and a data-class policy that decides
// which provider may see which kind of personal data.
//
// Nothing here can incur charges: each provider is called only with an API key from an account
// that has no billing attached, using models the provider offers at $0. If every provider is
// unavailable the caller gets AiUnavailable and leaves the work queued for the next run.
import { createHash } from 'node:crypto';
import { kvGet, kvSet, now, one, run } from './db.mjs';
import { log } from './log.mjs';

// Data classes, from least to most sensitive.
//   public  – job postings and company info (already public)
//   profile – resume facts without contact details
//   email   – Gmail message content
// `trainsOnData` reflects each provider's published free-tier terms; providers that may use
// prompts for training are limited to public data unless the user widens it in Settings.
export const PROVIDERS = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    trainsOnData: false,
    allow: ['public', 'profile', 'email'],
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    trainsOnData: true,
    allow: ['public'],
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    // Only ":free" model ids are accepted (enforced below), so a paid model can never be selected.
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    trainsOnData: true,
    allow: ['public'],
  },
};

export class AiUnavailable extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nextUtcMidnight() {
  const d = new Date();
  d.setUTCHours(24, 5, 0, 0);
  return d.toISOString();
}

async function providerState(db, id) {
  return kvGet(db, `ai:${id}`, { cooldownUntil: null, failures: 0, calls: 0, lastError: null });
}

async function setProviderState(db, id, patch) {
  await kvSet(db, `ai:${id}`, { ...(await providerState(db, id)), ...patch, updatedAt: now() });
}

// Minimal structural validation: shape is {key: 'string'|'number'|'boolean'|'array'|'object'}.
export function validateShape(obj, shape) {
  if (!obj || typeof obj !== 'object') return 'response is not a JSON object';
  for (const [k, type] of Object.entries(shape)) {
    const v = obj[k];
    const ok = type === 'array' ? Array.isArray(v) : type === 'object' ? v && typeof v === 'object' && !Array.isArray(v) : typeof v === type;
    if (!ok) return `field "${k}" should be ${type}`;
  }
  return null;
}

function parseJson(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  return JSON.parse(t);
}

async function callProvider(p, key, { system, user, maxTokens }, fetchImpl) {
  const res = await fetchImpl(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: p.model,
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    err.retryAfter = Number(res.headers.get('retry-after')) || null;
    err.daily = /per.?day|daily|RPD|quota/i.test(body);
    throw err;
  }
  const data = JSON.parse(body);
  return data.choices?.[0]?.message?.content ?? '';
}

// task: {name, dataClass, system, user, shape, maxTokens?, cacheKey?}
// opts: {env, fetchImpl, settings}
export async function aiJson(db, task, { env = process.env, fetchImpl = fetch, settings } = {}) {
  const cacheKey = 'v1:' + createHash('sha256').update(JSON.stringify([task.name, task.system, task.user])).digest('hex');
  const cached = await one(db, 'SELECT value FROM ai_cache WHERE key = ?', [cacheKey]);
  if (cached) return JSON.parse(cached.value);

  const budget = (await kvGet(db, `ai:budget:${now().slice(0, 13)}`, 0));
  if (settings && budget >= settings.ai.maxCallsPerHour) throw new AiUnavailable('hourly AI call budget reached');

  const order = settings?.ai.order ?? Object.keys(PROVIDERS);
  const attempts = [];
  for (const id of order) {
    const p = PROVIDERS[id];
    const key = env[p?.keyEnv];
    if (!p || !key) { attempts.push(`${id}: not configured`); continue; }
    const allowed = settings?.ai.dataPolicy?.[id] ?? p.allow;
    if (!allowed.includes(task.dataClass)) { attempts.push(`${id}: not allowed for ${task.dataClass} data`); continue; }
    if (id === 'openrouter' && !p.model.endsWith(':free')) { attempts.push(`${id}: model is not a free model`); continue; }
    const state = await providerState(db, id);
    if (state.cooldownUntil && new Date(state.cooldownUntil) > new Date()) { attempts.push(`${id}: cooling down until ${state.cooldownUntil}`); continue; }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const text = await callProvider(p, key, { system: task.system, user: task.user, maxTokens: task.maxTokens ?? 800 }, fetchImpl);
        const obj = parseJson(text);
        const problem = task.shape ? validateShape(obj, task.shape) : null;
        if (problem) throw Object.assign(new Error(`invalid structured output: ${problem}`), { invalid: true });
        await run(db, 'INSERT OR REPLACE INTO ai_cache (key, value, created_at) VALUES (?, ?, ?)', [cacheKey, JSON.stringify(obj), now()]);
        await setProviderState(db, id, { failures: 0, calls: state.calls + 1, lastError: null });
        await kvSet(db, `ai:budget:${now().slice(0, 13)}`, budget + 1);
        return { ...obj, _provider: id, _model: p.model };
      } catch (err) {
        if (err.status === 401 || err.status === 403 || err.status === 402) {
          // Bad key, or the provider wants payment: never retry, park for a day.
          await setProviderState(db, id, { cooldownUntil: nextUtcMidnight(), lastError: err.message.slice(0, 200) });
          attempts.push(`${id}: ${err.status} (parked)`);
          break;
        }
        if (err.status === 429) {
          const until = err.daily || !err.retryAfter ? nextUtcMidnight() : new Date(Date.now() + err.retryAfter * 1000).toISOString();
          if (!err.daily && err.retryAfter && err.retryAfter <= 20 && attempt < 2) { await sleep(err.retryAfter * 1000); continue; }
          await setProviderState(db, id, { cooldownUntil: until, lastError: 'rate limited' });
          attempts.push(`${id}: rate limited until ${until}`);
          break;
        }
        if (attempt < 2 && (err.invalid || !err.status || err.status >= 500)) { await sleep(1000 * 2 ** attempt); continue; }
        await setProviderState(db, id, { failures: state.failures + 1, lastError: err.message.slice(0, 200),
          cooldownUntil: state.failures + 1 >= 3 ? new Date(Date.now() + 36e5).toISOString() : null });
        attempts.push(`${id}: ${err.message.slice(0, 80)}`);
        break;
      }
    }
  }
  log.warn('no AI provider available', { task: task.name, attempts });
  throw new AiUnavailable(attempts.join('; ') || 'no providers configured');
}

export async function providerHealth(db, env = process.env) {
  const out = {};
  for (const [id, p] of Object.entries(PROVIDERS)) {
    out[id] = { configured: Boolean(env[p.keyEnv]), model: p.model, trainsOnData: p.trainsOnData, ...(await providerState(db, id)) };
  }
  return out;
}
