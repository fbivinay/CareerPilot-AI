import test from 'node:test';
import assert from 'node:assert/strict';
import { all, one, openDb, run } from '../lib/db.mjs';
import { describeMissing, expireMissing, reevaluateAll, touchKnown, upsertJob } from '../lib/jobs.mjs';
import { boardFromPostingUrl, placesFilter } from '../lib/discover.mjs';
import { locationNarrowing } from '../../providers/workday.mjs';
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

test('a job qualified without a description is judged again once the description is read', async () => {
  const db = await openDb({ url: ':memory:' });
  const url = 'https://acme.wd1.myworkdayjobs.com/External/job/Bengaluru/Data-Scientist_R1';
  const job = await upsertJob(db, posting({ url, title: 'Data Scientist', description: '' }), { source: 'workday', boardId: 'b1', settings });
  assert.equal(job.status, 'qualified');
  const fetchJd = async (u) => (u === url ? { text: 'Data Scientist, Bengaluru. Requires 4+ years of experience in machine learning.' } : null);
  assert.deepEqual(await describeMissing(db, settings, { fetchJd }), { missing: 1, described: 1 });
  const row = await one(db, 'SELECT status, exclusion_reason, description FROM jobs WHERE id = ?', [job.id]);
  assert.equal(row.status, 'excluded');
  assert.match(row.exclusion_reason, /4\+ years/);
});

test('re-evaluation reaches every live job, a page at a time', async () => {
  const db = await openDb({ url: ':memory:' });
  for (let i = 0; i < 5; i++) await upsertJob(db, posting({ url: `https://jobs.lever.co/acme/${i}`, title: `Junior Data Scientist ${i}` }), { source: 'lever', boardId: 'b1', settings });
  await run(db, `UPDATE jobs SET status = 'new'`);
  assert.equal(await reevaluateAll(db, settings, 2), 5);
  assert.equal(Number((await one(db, `SELECT count(*) n FROM jobs WHERE status = 'new'`)).n), 0);
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

test('Workday boards are narrowed to Indian places through their own location facet', () => {
  const india = placesFilter(settings);
  const v = (descriptor, id, count) => ({ descriptor, id, count });
  // A country facet nested under an id-less group header wins over city values.
  const nested = [{ facetParameter: 'locationMainGroup', values: [
    { facetParameter: 'locationCountry', descriptor: 'Country', values: [v('United States of America', 'us', 900), v('India', 'in', 40)] },
    { facetParameter: 'locations', descriptor: 'Locations', values: [v('Bengaluru, Karnataka', 'blr', 30), v('Pune', 'pnq', 10), v('Austin, TX', 'aus', 900)] }] },
  { facetParameter: 'jobFamilyGroup', descriptor: 'Job Family', values: [v('Engineering', 'eng', 940)] }];
  assert.deepEqual(locationNarrowing(nested, india, 940), { appliedFacets: { locationCountry: ['in'] } });
  // Only a city list: every Indian city is applied.
  const cities = [{ facetParameter: 'locations', descriptor: 'Locations', values: [v('IND KA Bangalore - Campus', 'b', 5), v('Hyderabad, India', 'h', 3), v('London', 'l', 50)] }];
  assert.deepEqual(locationNarrowing(cities, india, 58), { appliedFacets: { locations: ['b', 'h'] } });
  // A location facet covering the whole board with nothing Indian: no Indian postings, no crawl.
  const usOnly = [{ facetParameter: 'Location_Country', descriptor: 'Country', values: [v('United States of America', 'us', 81)] }];
  assert.deepEqual(locationNarrowing(usOnly, india, 81), { none: true });
  // A facet that misses part of the board, or no location facet at all: crawl the whole board.
  assert.equal(locationNarrowing(usOnly, india, 120), null);
  assert.equal(locationNarrowing([{ facetParameter: 'jobFamilyGroup', values: [v('Sales', 's', 10)] }], india, 10), null);
});

test('a location-filtered scan only expires jobs located in the filtered places', async () => {
  const db = await openDb({ url: ':memory:' });
  const blr = await upsertJob(db, posting({ url: 'https://acme.wd5.myworkdayjobs.com/ext/job/1' }), { source: 'workday', boardId: 'b1', settings });
  const remote = await upsertJob(db, posting({ url: 'https://acme.wd5.myworkdayjobs.com/ext/job/2', title: 'Data Analyst', location: 'Remote' }), { source: 'workday', boardId: 'b1', settings });
  assert.equal(await expireMissing(db, 'b1', new Set(), { places: placesFilter(settings) }), 1);
  assert.equal((await one(db, 'SELECT status FROM jobs WHERE id = ?', [blr.id])).status, 'expired');
  assert.notEqual((await one(db, 'SELECT status FROM jobs WHERE id = ?', [remote.id])).status, 'expired');
});
