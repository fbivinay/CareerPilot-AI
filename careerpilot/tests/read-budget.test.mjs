// Automation pauses near Turso's free monthly read limit, and never because the check itself failed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_LIMIT, READ_STOP, readBudgetPause } from '../lib/db.mjs';

const turso = (rowsRead) => async (url) => ({
  ok: true,
  json: async () => (url.endsWith('/organizations') ? [{ slug: 'me' }] : { organization: { usage: { rows_read: rowsRead } } }),
});
const env = { TURSO_API_TOKEN: 't' };

test('runs below the stop line, pauses at it', async () => {
  assert.equal(await readBudgetPause(env, turso(READ_LIMIT * READ_STOP - 1)), null);
  assert.match(await readBudgetPause(env, turso(READ_LIMIT * READ_STOP)), /^Paused: database reads at 400M of the free 500M/);
});

test('no API token: no check', async () => {
  assert.equal(await readBudgetPause({}, () => assert.fail('must not call the API')), null);
});

test('a failing API throws (callers treat that as "keep running")', async () => {
  await assert.rejects(readBudgetPause(env, async () => ({ ok: false, status: 503 })), /Turso API 503/);
});
