// Every Overview / Analytics number must equal the size of the list its link opens.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TURSO_DATABASE_URL = ':memory:';
const { getDb, run } = await import('../lib/db.mjs');
const { upsertJob } = await import('../lib/jobs.mjs');
const { DEFAULT_SETTINGS: settings } = await import('../lib/settings.mjs');
const q = await import('../lib/queries.mjs');

const db = await getDb();
const now = new Date().toISOString();

// A mixed dataset: qualified/excluded/duplicate/expired jobs and applications in every state.
const statuses = ['ready', 'ready', 'blocked', 'failed', 'expired', 'submitted', 'confirmed', 'assessment', 'interview', 'offer', 'rejected', 'rejected', 'withdrawn'];
for (let i = 0; i < 30; i++) {
  await upsertJob(db, {
    url: `https://jobs.lever.co/co${i % 7}/${i}`, company: `Co${i % 7}`, location: i % 5 ? 'Bengaluru' : 'London, UK',
    title: i % 4 === 0 ? 'Senior Data Scientist' : ['Junior Data Scientist', 'Data Analyst Intern', 'Analytics Engineer'][i % 3],
    description: i % 6 === 0 ? 'Freshers. CTC 9 LPA' : 'Freshers welcome',
  }, { source: i % 3 ? 'lever' : 'alert:linkedin', settings });
}
await upsertJob(db, { url: 'https://www.linkedin.com/jobs/view/1', company: 'Co1', title: 'Junior Data Scientist', location: 'Bangalore' }, { source: 'alert:linkedin', settings });
const jobIds = (await db.execute(`SELECT id FROM jobs WHERE status = 'qualified' ORDER BY id`)).rows.map((r) => r.id);
for (const [i, status] of statuses.entries()) {
  await run(db, `INSERT INTO applications (id, job_id, status, method, resume_version, created_at, updated_at) VALUES (?, ?, ?, 'portal', 'v1', ?, ?)`,
    [`a${i}`, jobIds[i], status, now, now]);
}
// One rejected application had reached interview first.
await run(db, `INSERT INTO events (entity, entity_id, action, from_status, to_status, at) VALUES ('application', 'a10', 'status', 'confirmed', 'interview', ?)`, [now]);
await run(db, `INSERT INTO contacts (id, email, source_type, created_at) VALUES ('c1', 'hr@co1.in', 'jd', ?)`, [now]);
for (const [i, s] of ['sent', 'sent', 'failed', 'unknown', 'bounced'].entries()) {
  await run(db, `INSERT INTO outreach (id, contact_id, kind, subject, body, status, sent_at, replied_at, created_at) VALUES (?, 'c1', 'initial', 's', 'b', ?, ?, ?, ?)`,
    [`o${i}`, s, now, i === 0 ? now : null, now]);
}
for (const [i, [cat, review]] of [['interview', 0], ['rejection', 1], ['other', 1], ['ignored', 0]].entries()) {
  await run(db, `INSERT INTO emails (id, category, needs_review, processed_at, received_at) VALUES (?, ?, ?, ?, ?)`, [`e${i}`, cat, review, now, now]);
}

test('overview tiles equal their drill-down lists', async () => {
  const o = await q.overview();
  const jobs = async (f) => (await q.listJobs(f)).total;
  const apps = async (f) => (await q.listApplications(f)).total;
  assert.equal(o.discovered, await jobs({ status: 'all' }));
  assert.equal(o.qualified, await jobs({ status: 'qualified' }));
  for (const s of ['ready', 'blocked', 'confirmed', 'assessment', 'interview', 'offer', 'rejected']) assert.equal(o[s], await apps({ status: s }), s);
  assert.equal(o.applied, await apps({ status: 'applied' }));
  assert.equal(o.outreachSent, (await q.listOutreach({ status: 'sent' })).total);
  assert.equal(o.replies, (await q.listOutreach({ replied: '1' })).total);
  assert.equal(o.review, (await q.listEmails({ review: '1' })).total);
  assert.equal(o.pending, o.ready + o.blocked + o.failed + o.review + o.unknownSends);
  assert.ok(o.discovered > 0 && o.applied > 0 && o.interview > 0);
});

test('analytics funnel numbers equal their drill-down lists', async () => {
  const { funnel: f, bySource, byRole } = await q.analytics();
  const apps = async (p) => (await q.listApplications(p)).total;
  assert.equal(Number(f.discovered), (await q.listJobs({ status: 'all' })).total);
  assert.equal(Number(f.qualified), (await q.listJobs({ status: 'qualified' })).total);
  assert.equal(Number(f.prepared), await apps({}));
  assert.equal(Number(f.applied), await apps({ status: 'applied' }));
  assert.equal(Number(f.responded), await apps({ status: 'responded' }));
  assert.equal(Number(f.interviewed), await apps({ status: 'interviewed' }));
  assert.equal(Number(f.offers), await apps({ status: 'offer' }));
  for (const r of bySource) assert.equal(Number(r.applied), await apps({ source: r.k, status: 'applied' }), `source ${r.k}`);
  for (const r of byRole) assert.equal(Number(r.applied), await apps({ category: r.k, status: 'applied' }), `role ${r.k}`);
});

test('job detail and application detail load for every listed row', async () => {
  for (const j of (await q.listJobs({ status: 'all' })).rows) assert.ok(await q.getJob(j.id), j.id);
  for (const a of (await q.listApplications({})).rows) assert.ok(await q.getApplication(a.id), a.id);
});
