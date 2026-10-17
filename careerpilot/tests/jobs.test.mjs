import test from 'node:test';
import assert from 'node:assert/strict';
import { all, one, openDb, run } from '../lib/db.mjs';
import { expireMissing, touchKnown, upsertJob } from '../lib/jobs.mjs';
import { boardFromPostingUrl } from '../lib/discover.mjs';
import { createApplication } from '../lib/applications.mjs';
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

test('same role from another source becomes a duplicate; the canonical row gets the richer JD and is re-judged', async () => {
  const db = await openDb({ url: ':memory:' });
  const first = await upsertJob(db, posting({ description: '' }), { source: 'aggregator', boardId: 'b1', settings });
  assert.equal((await one(db, 'SELECT confidence FROM jobs WHERE id = ?', [first.id])).confidence, 'low');
  const dup = await upsertJob(db, posting({ url: 'https://www.linkedin.com/jobs/view/123', location: 'Bangalore, Karnataka',
    description: 'Freshers welcome. CTC 9 LPA.' }), { source: 'alert:linkedin', settings });
  assert.equal(dup.status, 'duplicate');
  assert.equal(dup.duplicateOf, first.id);
  const canonical = await one(db, 'SELECT * FROM jobs WHERE id = ?', [first.id]);
  assert.match(canonical.description, /CTC 9 LPA/);
  assert.equal(canonical.comp_min, 900000); // re-evaluated with the new description
});

test('expiry by set difference, no aggregator revival, repost detection, and pending applications expire too', async () => {
  const db = await openDb({ url: ':memory:' });
  const j = await upsertJob(db, posting(), { source: 'lever', boardId: 'b1', settings });
  const app = await createApplication(db, j.id, { status: 'ready', method: 'portal' });
  assert.equal(await expireMissing(db, 'b1', new Set()), 1);
  assert.equal((await one(db, 'SELECT status FROM jobs WHERE id = ?', [j.id])).status, 'expired');
  assert.equal((await one(db, 'SELECT status FROM applications WHERE id = ?', [app.id])).status, 'expired');
  // Stale aggregator data must not reopen a job the employer's board closed.
  assert.equal((await upsertJob(db, posting(), { source: 'aggregator', boardId: 'b1', settings })).status, 'expired');
  // The board listing it again does reopen it.
  assert.equal((await upsertJob(db, posting({ description: 'Freshers welcome. Python, SQL. More text.' }), { source: 'lever', boardId: 'b1', settings })).status, 'qualified');
  // A seen posting is not expired.
  assert.equal(await expireMissing(db, 'b1', new Set([j.id])), 0);
  // A new URL for the same role after closure is a repost, evaluated normally.
  await expireMissing(db, 'b1', new Set());
  const repost = await upsertJob(db, posting({ url: 'https://jobs.lever.co/acme/2222' }), { source: 'lever', boardId: 'b1', settings });
  assert.equal(repost.status, 'qualified');
  assert.equal((await one(db, 'SELECT repost_of FROM jobs WHERE id = ?', [repost.id])).repost_of, j.id);
});

test('aggregator expiry only covers rows no working board vouches for', async () => {
  const db = await openDb({ url: ':memory:' });
  await run(db, `INSERT INTO boards (id, name, careers_url, origin, last_ok) VALUES ('good', 'G', 'x', 'discovered', '2026-10-01'),
    ('never', 'N', 'y', 'discovered', NULL)`);
  const onGood = await upsertJob(db, posting({ url: 'https://jobs.lever.co/g/1' }), { source: 'aggregator', boardId: 'good', settings });
  const onNever = await upsertJob(db, posting({ url: 'https://jobs.lever.co/n/1', title: 'Data Analyst Intern' }), { source: 'aggregator', boardId: 'never', settings });
  const boardless = await upsertJob(db, posting({ url: 'https://acme.icims.com/jobs/1', title: 'Analytics Engineer' }), { source: 'aggregator', settings });
  assert.equal(await expireMissing(db, null, new Set()), 2);
  assert.equal((await one(db, 'SELECT status FROM jobs WHERE id = ?', [onGood.id])).status, 'qualified');
  assert.equal((await one(db, 'SELECT status FROM jobs WHERE id = ?', [onNever.id])).status, 'expired');
  assert.equal((await one(db, 'SELECT status FROM jobs WHERE id = ?', [boardless.id])).status, 'expired');
});

test('touchKnown proves known postings live, skips per-row work, and refreshes last_seen at most daily', async () => {
  const db = await openDb({ url: ':memory:' });
  const a = await upsertJob(db, posting(), { source: 'lever', boardId: 'b1', settings });
  let r = await touchKnown(db, [posting(), posting({ url: 'https://jobs.lever.co/acme/9999' })]);
  assert.equal(r.rest.length, 1);
  assert.ok(r.seen.has(a.id));
  assert.equal(r.touched, 0); // seen moments ago: no write
  await run(db, 'UPDATE jobs SET last_seen = ? WHERE id = ?', ['2026-01-01T00:00:00.000Z', a.id]);
  r = await touchKnown(db, [posting()]);
  assert.equal(r.touched, 1);
});

test('aggregator posting URLs map to scannable boards', () => {
  assert.equal(boardFromPostingUrl('https://boards.greenhouse.io/6sense/jobs/5636812?gh_jid=5636812'), 'https://job-boards.greenhouse.io/6sense');
  assert.equal(boardFromPostingUrl('https://jobs.lever.co/meesho/abc'), 'https://jobs.lever.co/meesho');
  assert.equal(boardFromPostingUrl('https://acme.wd3.myworkdayjobs.com/en-US/careers/job/x'), 'https://acme.wd3.myworkdayjobs.com/careers');
  assert.equal(boardFromPostingUrl('https://example.com/x'), null);
});
