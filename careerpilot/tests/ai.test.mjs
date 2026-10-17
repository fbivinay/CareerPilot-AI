import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/db.mjs';
import { aiJson, AiUnavailable } from '../lib/ai.mjs';
import { DEFAULT_SETTINGS } from '../lib/settings.mjs';

const env = { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'm' };
const ok = (content) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
const task = (over = {}) => ({ name: 't', dataClass: 'public', system: 's', user: 'u' + Math.random(), shape: { score: 'number' }, ...over });

test('falls back to the next provider on a daily quota 429 and parks the first', async () => {
  const db = await openDb({ url: ':memory:' });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('groq')) return new Response('Rate limit reached: requests per day (RPD)', { status: 429 });
    return ok({ score: 7 });
  };
  const r = await aiJson(db, task(), { env, fetchImpl, settings: DEFAULT_SETTINGS });
  assert.equal(r.score, 7);
  assert.equal(r._provider, 'gemini');
  // Groq is now cooling down, so the next call skips it without a request.
  calls.length = 0;
  await aiJson(db, task(), { env, fetchImpl, settings: DEFAULT_SETTINGS });
  assert.ok(calls.every((u) => !u.includes('groq')));
});

test('email data never goes to providers that may train on it', async () => {
  const db = await openDb({ url: ':memory:' });
  const fetchImpl = async () => ok({ score: 1 });
  await assert.rejects(aiJson(db, task({ dataClass: 'email' }), { env: { GEMINI_API_KEY: 'm' }, fetchImpl, settings: DEFAULT_SETTINGS }), AiUnavailable);
});

test('invalid structured output is retried, then cached results are reused', async () => {
  const db = await openDb({ url: ':memory:' });
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? ok({ wrong: true }) : ok({ score: 3 }));
  const t = task();
  assert.equal((await aiJson(db, t, { env, fetchImpl, settings: DEFAULT_SETTINGS })).score, 3);
  assert.equal(n, 2);
  assert.equal((await aiJson(db, t, { env, fetchImpl, settings: DEFAULT_SETTINGS })).score, 3);
  assert.equal(n, 2);
});

test('payment-required responses park the provider and nothing is retried', async () => {
  const db = await openDb({ url: ':memory:' });
  let n = 0;
  const fetchImpl = async () => { n++; return new Response('insufficient credits', { status: 402 }); };
  await assert.rejects(aiJson(db, task(), { env: { GROQ_API_KEY: 'g' }, fetchImpl, settings: DEFAULT_SETTINGS }), AiUnavailable);
  assert.equal(n, 1);
});

test('gpt-oss calls ask for low reasoning effort, other models get no reasoning field', async () => {
  const db = await openDb({ url: ':memory:' });
  const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return ok({ score: 1 }); };
  await aiJson(db, task({ tier: 'fast' }), { env: { GROQ_API_KEY: 'g' }, fetchImpl, settings: DEFAULT_SETTINGS });
  await aiJson(db, task(), { env: { GEMINI_API_KEY: 'm' }, fetchImpl, settings: DEFAULT_SETTINGS });
  assert.deepEqual(bodies.map((b) => [b.model, b.reasoning_effort]), [['openai/gpt-oss-20b', 'low'], ['gemini-2.5-flash', undefined]]);
});
