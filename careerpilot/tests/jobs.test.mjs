import test from 'node:test';
import assert from 'node:assert/strict';
import { all, one, openDb } from '../lib/db.mjs';
import { expireMissing, touchKnown, upsertJob } from '../lib/jobs.mjs';
import { boardFromPostingUrl } from '../lib/discover.mjs';
import { DEFAULT_SETTINGS as settings } from '../lib/settings.mjs';

const posting = (over = {}) => ({
  url: 'https://jobs.lever.co/acme/1111', title: 'Junior Data Scientist', company: 'Acme',
  location: 'Bengaluru', description: 'Freshers welcome. Python, SQL.', ...over,
});

test('upsert is idempotent and keys on the canonical URL', async () => {
  const db = await openDb({ url: ':memory:' });
  const a = await upsertJob(db, posting(), { source: 'lever', boardId: 'b1', settings });
  const b = await upsertJob(db, posting({ url: 'https://jobs.lever.co/acme/1111/?utm_source=x' }), { source: 'lever', boardId: 'b1', settings });
  assert.equal(a.id, b.id);
  assert.equal(b.created, false);
  assert.equal((await all(db, 'SELECT * FROM jobs')).length, 1);
  assert.equal(a.status, 'qualified');
});

test('same role from another source becomes a duplicate and keeps the canonical twin alive', async () => {
  const db = await openDb({ url: ':memory:' });
  const first = await upsertJob(db, posting({ description: '' }), { source: 'aggregator', boardId: 'b1', settings });
  const dup = await upsertJob(db, posting({ url: 'https://www.linkedin.com/jobs/view/123', location: 'Bengaluru, Karnataka' }), { source: 'alert:linkedin', settings });
  assert.equal(dup.status, 'duplicate');
  const canonical = await one(db, 'SELECT * FROM jobs WHERE id = ?', [first.id]);
  assert.match(canonical.description, /Freshers/); // richer description moved to the canonical row
});

test('board expiry, no aggregator revival, and repost detection', async () => {
  const db = await openDb({ url: ':memory:' });
  const j = await upsertJob(db, posting(), { source: 'lever', boardId: 'b1', settings });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(await expireMissing(db, 'b1', new Date().toISOString()), 1);
  assert.equal((await one(db, 'SELECT status FROM jobs WHERE id = ?', [j.id])).status, 'expired');
  // Stale aggregator data must not reopen a job the employer's board closed.
  const again = await upsertJob(db, posting(), { source: 'aggregator', boardId: 'b1', settings });
  assert.equal(again.status, 'expired');
  // The board listing it again does reopen it.
  assert.equal((await upsertJob(db, posting({ description: 'Freshers welcome. Python, SQL. More text.' }), { source: 'lever', boardId: 'b1', settings })).status, 'qualified');
  // A new URL for the same role after closure is a repost, evaluated normally.
  await expireMissing(db, 'b1', new Date(Date.now() + 1000).toISOString());
  const repost = await upsertJob(db, posting({ url: 'https://jobs.lever.co/acme/2222' }), { source: 'lever', boardId: 'b1', settings });
  assert.equal(repost.status, 'qualified');
  assert.equal((await one(db, 'SELECT repost_of FROM jobs WHERE id = ?', [repost.id])).repost_of, j.id);
});

test('touchKnown only bumps unchanged postings', async () => {
  const db = await openDb({ url: ':memory:' });
  await upsertJob(db, posting(), { source: 'lever', boardId: 'b1', settings });
  const { rest, touched } = await touchKnown(db, [posting(), posting({ url: 'https://jobs.lever.co/acme/9999' })]);
  assert.equal(touched, 1);
  assert.equal(rest.length, 1);
});

test('aggregator posting URLs map to scannable boards', () => {
  assert.equal(boardFromPostingUrl('https://boards.greenhouse.io/6sense/jobs/5636812?gh_jid=5636812'), 'https://job-boards.greenhouse.io/6sense');
  assert.equal(boardFromPostingUrl('https://jobs.lever.co/meesho/abc'), 'https://jobs.lever.co/meesho');
  assert.equal(boardFromPostingUrl('https://acme.wd3.myworkdayjobs.com/en-US/careers/job/x'), 'https://acme.wd3.myworkdayjobs.com/careers');
  assert.equal(boardFromPostingUrl('https://example.com/x'), null);
});
