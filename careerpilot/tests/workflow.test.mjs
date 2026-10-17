import test from 'node:test';
import assert from 'node:assert/strict';
import { all, one, openDb } from '../lib/db.mjs';
import { canTransition, createApplication, transition } from '../lib/applications.mjs';
import { classifyEmail, parseJobAlert } from '../lib/email-intel.mjs';
import { companyFromSubject, processMessage } from '../lib/gmail-sync.mjs';
import { applicationEmail, domainMatchesCompany, emailsInText } from '../lib/contacts.mjs';
import { blockReason, inSendWindow, runOutreach } from '../lib/outreach.mjs';
import { buildMime } from '../lib/gmail.mjs';
import { templateEmail } from '../lib/compose.mjs';
import { unverifiedNumbers, factCorpus } from '../lib/profile.mjs';
import { vaultPut } from '../lib/vault.mjs';
import { upsertJob } from '../lib/jobs.mjs';
import { DEFAULT_SETTINGS } from '../lib/settings.mjs';

const settings = structuredClone(DEFAULT_SETTINGS);
// Tests must not depend on the wall clock being inside the sending window.
settings.limits.sendWindow = { tz: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 };

const profile = {
  name: 'Test Candidate', email: 'me@example.org', phone: '+91 90000 00000', headline: 'Data science student',
  links: { linkedin: 'https://linkedin.com/in/x' },
  education: [{ degree: 'MSc in Big Data Analytics', institution: 'Test University', dates: 'Aug 2025 - Jun 2027', grade: 'CGPA 8' }],
  experience: [{ title: 'Data Intern', company: 'Co, City', dates: '2026', points: ['Built a Python SQL dashboard'] }],
  projects: [{ name: 'RAG Bot — x', stack: 'Python, FastAPI', points: ['RAG chatbot over 290 pages'] }],
  skills: { core: ['Python', 'SQL'] }, answers: {}, resume: { version: 'v1' },
};

test('application state machine only moves forward and never un-rejects', () => {
  assert.ok(canTransition('ready', 'submitted'));
  assert.ok(canTransition('submitted', 'confirmed'));
  assert.ok(canTransition('ready', 'interview'));        // evidence of a manual application
  assert.ok(!canTransition('interview', 'confirmed'));   // no going backwards
  assert.ok(!canTransition('rejected', 'interview'));
  assert.ok(canTransition('offer', 'withdrawn'));
  assert.ok(!canTransition('submitted', 'ready'));
});

test('email classification rules', () => {
  const c = (subject, text, fromAddr = 'no-reply@greenhouse.io') => classifyEmail({ subject, text, fromAddr, threadId: 't' }).category;
  assert.equal(c('Thank you for applying to Acme', 'We have received your application.'), 'application_confirmation');
  assert.equal(c('Your application', 'Thank you for applying. Unfortunately, we have decided not to move forward.'), 'rejection');
  assert.equal(c('Interview invitation', 'We would like to schedule an interview with you. Please share your availability.'), 'interview');
  assert.equal(c('Next steps', 'Please complete the online assessment on HackerRank: https://hackerrank.com/test/abc'), 'assessment');
  assert.equal(c('Offer', 'We are pleased to offer you the position of Data Analyst.'), 'offer');
  assert.equal(c('15 new jobs for Data Scientist', 'Jobs matching your alert', 'jobalerts-noreply@linkedin.com'), 'job_alert');
  assert.equal(classifyEmail({ subject: 'Re: hi', text: 'Please unsubscribe me', fromAddr: 'a@b.com', threadId: 'x' }, { ourThreadIds: new Set(['x']) }).category, 'opt_out');
});

test('job alert parsing extracts canonical links and titles', () => {
  const html = `<a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc&amp;refId=1">Junior Data Scientist</a>
    <p>Acme Analytics · Bengaluru, Karnataka, India</p>
    <a href="https://www.linkedin.com/comm/jobs/view/4012345678/?x=2">View job</a>
    <a href="https://www.naukri.com/job-listings-data-analyst-foo-bengaluru-0-to-1-years-171025000123?src=alert">Data Analyst</a> <span>Foo Pvt Ltd | Bengaluru</span>`;
  const jobs = parseJobAlert({ html });
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], { url: 'https://www.linkedin.com/jobs/view/4012345678', title: 'Junior Data Scientist', company: 'Acme Analytics', location: 'Bengaluru, Karnataka, India' });
  assert.equal(jobs[1].title, 'Data Analyst');
  assert.equal(jobs[1].company, 'Foo Pvt Ltd');
});

test('contact extraction never includes non-recruiting or placeholder addresses', () => {
  const jd = 'Send your resume to careers@acme.in. Privacy questions: privacy@acme.in. Example: you@example.com';
  assert.deepEqual(emailsInText(jd), ['careers@acme.in']);
  assert.equal(applicationEmail(jd), 'careers@acme.in');
  assert.equal(applicationEmail('Contact hr@acme.in for benefits'), null);
  assert.ok(domainMatchesCompany('careers@acme.in', 'Acme Technologies'));
  assert.ok(!domainMatchesCompany('someone@gmail.com', 'Acme'));
});

test('gmail sync links a confirmation, transitions the application and records evidence', async () => {
  const db = await openDb({ url: ':memory:' });
  const { id } = await upsertJob(db, { url: 'https://jobs.lever.co/acme/1', title: 'Junior Data Analyst', company: 'Acme', location: 'Bengaluru', description: 'Freshers' },
    { source: 'lever', settings });
  const app = await createApplication(db, id, { method: 'portal' });
  const msg = { id: 'm1', threadId: 't1', fromAddr: 'no-reply@hire.lever.co', fromName: 'Acme', subject: 'Thank you for applying to Acme',
    text: 'Hi, we have received your application for Junior Data Analyst.', snippet: '', date: '2026-10-20T10:00:00.000Z', html: '', authenticated: true };
  const r = await processMessage(db, msg, settings, { ourThreadIds: new Set() });
  assert.equal(r.transitioned, true);
  const after = await one(db, 'SELECT * FROM applications WHERE id = ?', [app.id]);
  assert.equal(after.status, 'confirmed');
  assert.equal(JSON.parse(after.evidence)[0].emailId, 'm1');
  // Reprocessing the same message is a no-op.
  assert.equal((await processMessage(db, msg, settings, { ourThreadIds: new Set() })).skipped, true);
  // A rejection that mentions two tracked companies is ambiguous and goes to review instead.
  const { id: id2 } = await upsertJob(db, { url: 'https://jobs.lever.co/beta/2', title: 'Data Analyst Intern', company: 'Betacorp', location: 'Bengaluru', description: 'x' }, { source: 'lever', settings });
  await createApplication(db, id2, { method: 'portal' });
  const r2 = await processMessage(db, { ...msg, id: 'm2', subject: 'Update', text: 'Unfortunately, Acme and Betacorp will not be moving forward.' }, settings, { ourThreadIds: new Set() });
  assert.equal(r2.review, true);
  assert.equal((await one(db, 'SELECT needs_review FROM emails WHERE id = ?', ['m2'])).needs_review, 1);
});

test('a confirmation for a manual application creates a tracked application', async () => {
  assert.deepEqual(companyFromSubject('Your application to Data Analyst at Foo Labs'), { title: 'Data Analyst', company: 'Foo Labs' });
  const db = await openDb({ url: ':memory:' });
  const r = await processMessage(db, { id: 'm9', threadId: 't9', fromAddr: 'jobs-noreply@linkedin.com', fromName: 'LinkedIn',
    subject: 'Your application was sent to Foo Labs', text: 'Your application was sent to Foo Labs', snippet: '', date: '2026-10-20T10:00:00.000Z', html: '', authenticated: true },
  settings, { ourThreadIds: new Set() });
  assert.equal(r.transitioned, true);
  const apps = await all(db, 'SELECT a.status, j.company FROM applications a JOIN jobs j ON j.id = a.job_id');
  assert.deepEqual(apps.map((a) => [a.status, a.company]), [['confirmed', 'Foo Labs']]);
});

test('spoofed or unauthenticated mail never changes status; offers always need the candidate', async () => {
  const db = await openDb({ url: ':memory:' });
  const { id } = await upsertJob(db, { url: 'https://jobs.lever.co/acme/5', title: 'Junior Data Analyst', company: 'Acme', location: 'Bengaluru', description: 'Freshers' }, { source: 'lever', settings });
  const app = await createApplication(db, id, { method: 'portal' });
  const base = { threadId: 'tx', fromName: 'Acme HR', snippet: '', date: '2026-10-21T10:00:00.000Z', html: '' };
  // Claims to be Acme but fails DMARC/DKIM.
  const r1 = await processMessage(db, { ...base, id: 's1', fromAddr: 'hr@acme.com', subject: 'Acme update', text: 'Unfortunately, Acme will not be moving forward.', authenticated: false }, settings, { ourThreadIds: new Set() });
  assert.equal(r1.transitioned, false);
  assert.equal(r1.review, true);
  // Authenticated, but from an unrelated domain that merely mentions Acme.
  const r2 = await processMessage(db, { ...base, id: 's2', fromAddr: 'x@random.org', subject: 'Acme update', text: 'Unfortunately, Acme will not be moving forward.', authenticated: true }, settings, { ourThreadIds: new Set() });
  assert.equal(r2.transitioned, false);
  // Authenticated offer from the company itself still waits for the candidate.
  const r3 = await processMessage(db, { ...base, id: 's3', fromAddr: 'hr@acme.com', subject: 'Offer from Acme', text: 'We are pleased to offer you the role at Acme.', authenticated: true }, settings, { ourThreadIds: new Set() });
  assert.equal(r3.transitioned, false);
  assert.equal((await one(db, 'SELECT status FROM applications WHERE id = ?', [app.id])).status, 'ready');
  // Authenticated rejection from the company's domain is applied.
  const r4 = await processMessage(db, { ...base, id: 's4', fromAddr: 'hr@acme.com', subject: 'Acme update', text: 'Unfortunately, Acme will not be moving forward.', authenticated: true }, settings, { ourThreadIds: new Set() });
  assert.equal(r4.transitioned, true);
});

test('outreach policy gate', async () => {
  const db = await openDb({ url: ':memory:' });
  const job = { id: 'j', status: 'qualified', score: 90, confidence: 'low', company: 'Acme' };
  const contact = { id: 'c', opted_out: 0, domain_match: 1, source_type: 'jd' };
  assert.equal(await blockReason(db, { job, contact, kind: 'initial' }, settings), null);
  assert.equal(await blockReason(db, { job, contact: { ...contact, opted_out: 1 }, kind: 'initial' }, settings), 'contact opted out');
  assert.match(await blockReason(db, { job, contact: { ...contact, domain_match: 0 }, kind: 'initial' }, settings), /domain does not match/);
  assert.match(await blockReason(db, { job, contact: { ...contact, domain_match: 0 }, kind: 'application' }, settings), /domain does not match/);
  assert.match(await blockReason(db, { job: { ...job, score: 50 }, contact, kind: 'initial' }, settings), /below auto-action/);
  const strict = structuredClone(settings);
  strict.automation.actOnUndisclosedComp = false;
  assert.match(await blockReason(db, { job, contact, kind: 'initial' }, strict), /low-confidence/);
  const closed = structuredClone(settings);
  closed.limits.sendWindow = { tz: 'Asia/Kolkata', days: [1], startHour: 10, endHour: 11 };
  assert.ok(!inSendWindow(closed.limits.sendWindow, new Date('2026-10-18T05:00:00Z'))); // Sunday 10:30 IST
  assert.ok(inSendWindow(closed.limits.sendWindow, new Date('2026-10-19T05:00:00Z')));  // Monday 10:30 IST
});

test('outreach sends an email application once, records submission evidence, never duplicates', async () => {
  const db = await openDb({ url: ':memory:' });
  const sent = [];
  const gmail = { send: async (m) => { sent.push(m); return { id: `g${sent.length}`, threadId: `t${sent.length}` }; }, get: async () => ({ messageId: '<x@mail>' }) };
  const { id } = await upsertJob(db, { url: 'https://jobs.lever.co/acme/7', title: 'Junior Data Scientist', company: 'Acme', location: 'Bengaluru',
    description: 'Freshers welcome. Python and SQL. Send your resume to careers@acme.in' }, { source: 'lever', settings });
  const stats = await runWithProfile(db, gmail);
  assert.equal(stats.applications, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'careers@acme.in');
  assert.equal(sent[0].attachments[0].mimeType, 'application/pdf');
  const app = await one(db, 'SELECT * FROM applications WHERE job_id = ?', [id]);
  assert.equal(app.status, 'submitted');
  assert.equal(JSON.parse(app.evidence)[0].gmailId, 'g1');
  const again = await runWithProfile(db, gmail);
  assert.equal(again.applications, 0);
  assert.equal(sent.length, 1);
});

// Profile and resume come from the encrypted vault, exactly as in GitHub Actions.
async function runWithProfile(db, gmail) {
  const env = { APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  await vaultPut(db, 'profile', JSON.stringify(profile), env);
  await vaultPut(db, 'resume.pdf', Buffer.from('%PDF-1.7 test'), env);
  return runOutreach(db, gmail, settings, { env });
}

test('template emails use only profile facts and include an opt-out', () => {
  const e = templateEmail({ profile, job: { title: 'Data Analyst', company: 'Acme', description: 'SQL dashboards' }, kind: 'initial' });
  assert.match(e.body, /graduating Jun 2027/);
  assert.match(e.body, /unsubscribe/);
  assert.deepEqual(unverifiedNumbers(e.body, factCorpus(profile, 'Data Analyst Acme SQL dashboards')), []);
  assert.deepEqual(unverifiedNumbers('I have 5 years of experience', factCorpus(profile)), ['5']);
});

test('MIME message carries threading headers and attachment', () => {
  const raw = buildMime({ to: 'a@b.in', subject: 'Re: Hello', text: 'Hi', inReplyTo: '<m1@mail>', attachments: [{ filename: 'r.pdf', mimeType: 'application/pdf', content: Buffer.from('x') }] });
  assert.match(raw, /In-Reply-To: <m1@mail>/);
  assert.match(raw, /filename="r.pdf"/);
});

test('login redirect target is restricted to this origin', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../app/actions.js', import.meta.url), 'utf8');
  const safeNext = new Function(`${src.match(/function safeNext[\s\S]*?\n}\n/)[0]}; return safeNext;`)();
  assert.equal(safeNext('/jobs?status=all'), '/jobs?status=all');
  assert.equal(safeNext('//evil.com'), '/');
  assert.equal(safeNext(String.raw`/\evil.com`), '/');
  assert.equal(safeNext('https://evil.com/x'), '/');
});
