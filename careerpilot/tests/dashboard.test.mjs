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

// A mixed dataset: qualified/excluded/duplicate/expired jobs and CareerPilot's applications (on Workday)
// in every state, plus applications the candidate made themselves, which the dashboard never shows.
const statuses = ['ready', 'ready', 'blocked', 'failed', 'expired', 'submitted', 'confirmed', 'assessment', 'interview', 'offer', 'rejected', 'rejected', 'withdrawn'];
for (let i = 0; i < 30; i++) {
  await upsertJob(db, {
    url: `https://co${i % 7}.wd1.myworkdayjobs.com/External/job/Bengaluru/Role_${i}`, company: `Co${i % 7}`, location: i % 5 ? 'Bengaluru' : 'London, UK',
    title: i % 4 === 0 ? 'Senior Data Scientist' : ['Junior Data Scientist', 'Data Analyst Intern', 'Analytics Engineer'][i % 3],
    description: i % 6 === 0 ? 'Freshers. CTC 9 LPA' : 'Freshers welcome',
  }, { source: i % 3 ? 'workday' : 'alert:linkedin', settings });
}
await upsertJob(db, { url: 'https://www.linkedin.com/jobs/view/1', company: 'Co1', title: 'Junior Data Scientist', location: 'Bangalore' }, { source: 'alert:linkedin', settings });
const jobIds = (await db.execute(`SELECT id FROM jobs WHERE status = 'qualified' ORDER BY id`)).rows.map((r) => r.id);
for (const [i, status] of statuses.entries()) {
  await run(db, `INSERT INTO applications (id, job_id, status, method, resume_version, evidence, created_at, updated_at) VALUES (?, ?, ?, 'portal', 'v1', ?, ?, ?)`,
    [`a${i}`, jobIds[i], status, ['ready', 'blocked', 'failed', 'expired', 'withdrawn'].includes(status) ? null : '[{"type":"workday"}]', now, now]);
}
// The candidate's own: a job-site application found in their mail, and a queued posting they sent themselves.
const own = await upsertJob(db, { url: 'https://www.foundit.in/seeker/job-details?id=1', company: 'Mine', title: 'Data Analyst', location: 'Bengaluru' }, { source: 'email:foundit', settings });
await run(db, `INSERT INTO applications (id, job_id, status, method, created_at, updated_at) VALUES ('own1', ?, 'confirmed', 'platform:foundit', ?, ?)`, [own.id, now, now]);
assert.ok(jobIds.length > statuses.length, 'a spare qualified job for own2');
await run(db, `INSERT INTO applications (id, job_id, status, method, evidence, created_at, updated_at) VALUES ('own2', ?, 'confirmed', 'portal', '[{"type":"email"}]', ?, ?)`,
  [jobIds[statuses.length], now, now]);
await run(db, `INSERT INTO emails (id, category, needs_review, application_id, processed_at, received_at) VALUES ('own-mail', 'interview', 1, 'own1', ?, ?)`, [now, now]);
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
// The candidate's own job emails (the Email page): rejected, unanswered, answered.
for (const [i, reply] of ['rejection', null, 'recruiter_reply'].entries()) {
  await run(db, `INSERT INTO sent_mail (id, thread_id, to_addr, subject, sent_at, reply_category, reply_at, created_at) VALUES (?, ?, 'hr@x.in', 'Application', ?, ?, ?, ?)`,
    [`sm${i}`, `smt${i}`, now, reply, reply && now, now]);
}

test('overview tiles equal their drill-down lists', async () => {
  const o = await q.overview();
  const jobs = async (f) => (await q.listJobs(f)).total;
  const apps = async (f) => (await q.listApplications(f)).total;
  assert.equal(o.discovered, await jobs({ status: 'all' }));
  assert.equal(o.qualified, await jobs({ status: 'qualified' }));
  for (const s of ['ready', 'blocked', 'acknowledged', 'assessment', 'interview', 'offer', 'rejected']) assert.equal(o[s], await apps({ status: s }), s);
  assert.equal(o.applied, await apps({ status: 'applied' }));
  assert.equal(o.outreachSent, (await q.listOutreach({ status: 'sent' })).total);
  assert.equal(o.replies, (await q.listOutreach({ replied: '1' })).total);
  assert.equal(o.review, (await q.listEmails({ review: '1' })).total);
  assert.equal(o.pending, o.ready + o.blocked + o.failed + o.review + o.unknownSends);
  assert.ok(o.discovered > 0 && o.applied > 0 && o.interview > 0);
});

test('email page tiles equal their drill-down lists', async () => {
  const { counts: c, total } = await q.sentEmails({});
  assert.equal(total, c.all);
  for (const by of ['you', 'careerpilot']) assert.equal(c[by], (await q.sentEmails({ by })).total, by);
  for (const reply of ['replied', 'none', 'bounce', 'assessment', 'interview', 'offer', 'rejection', 'other']) {
    assert.equal(c[reply], (await q.sentEmails({ reply })).total, reply);
  }
  assert.equal(c.you + c.careerpilot, c.all);
  assert.equal(c.replied + c.none + c.bounce, c.all);
  // Outreach that failed or was interrupted was never sent; the bounced one was.
  assert.deepEqual([c.you, c.careerpilot, c.rejection, c.bounce, c.replied], [3, 3, 1, 1, 3]);
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

test('the candidate’s own applications, their jobs and their mail are not shown anywhere', async () => {
  const listed = (await q.listApplications({})).rows.map((a) => a.id);
  assert.ok(!listed.includes('own1') && !listed.includes('own2'));
  assert.ok(!(await q.listJobs({ status: 'all' })).rows.some((j) => j.company === 'Mine'));
  assert.ok(!(await q.listEmails({})).rows.some((e) => e.id === 'own-mail'));
  assert.equal((await q.applicationPlaces()).total, statuses.filter((s) => !['withdrawn', 'expired'].includes(s)).length);
});

test('job detail and application detail load for every listed row', async () => {
  for (const j of (await q.listJobs({ status: 'all' })).rows) assert.ok(await q.getJob(j.id), j.id);
  for (const a of (await q.listApplications({})).rows) assert.ok(await q.getApplication(a.id), a.id);
});

test('a read retries once on a passing server error; a write never retries', async () => {
  const { all, one } = await import('../lib/db.mjs');
  const flaky = (failures) => {
    let calls = 0;
    return { calls: () => calls, execute: async () => { calls++; if (calls <= failures) throw Object.assign(new Error('SERVER_ERROR'), { cause: { status: 502 } }); return { rows: [{ n: 1 }] }; } };
  };
  const db1 = flaky(1);
  assert.deepEqual(await all(db1, 'SELECT 1 n'), [{ n: 1 }]);
  assert.equal(db1.calls(), 2);
  const db2 = flaky(1);
  await assert.rejects(() => one(db2, 'UPDATE jobs SET status = ? RETURNING id', ['x']), /SERVER_ERROR/);
  assert.equal(db2.calls(), 1);
  await assert.rejects(() => all(flaky(2), 'SELECT 1'), /SERVER_ERROR/); // only once
});
