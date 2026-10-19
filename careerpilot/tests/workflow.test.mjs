import test from 'node:test';
import assert from 'node:assert/strict';
import { all, one, openDb } from '../lib/db.mjs';
import { SHOWN_APP, canTransition, createApplication, markDone, transition } from '../lib/applications.mjs';
import { classifyEmail, parseJobAlert, stripQuoted } from '../lib/email-intel.mjs';
import { processMessage } from '../lib/gmail-sync.mjs';
import { applicationEmail, domainMatchesCompany, emailsInText, forRecruiting } from '../lib/contacts.mjs';
import { blockReason, inSendWindow, runOutreach } from '../lib/outreach.mjs';
import { buildMime } from '../lib/gmail.mjs';
import { relevantHighlights, templateEmail } from '../lib/compose.mjs';
import { unverifiedNumbers, factCorpus } from '../lib/profile.mjs';
import { vaultPut } from '../lib/vault.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('an address a posting prints for accommodations, fraud or posting errors is not a recruiting contact', () => {
  // The sentences that printed them (2026-10-19); the first four were sent outreach that day.
  const other = [
    ['For accommodations, contact hr@karya.in.', 'hr@karya.in'],
    ['If you need special assistance or an accommodation to use our website, apply for a position, or to perform a job, please contact us by emailing accommodationrequests@maersk.com .', 'accommodationrequests@maersk.com'],
    ['Applicants needing an accommodation for disability or religious purposes in connection with the application process should contact Candidateaccommodation@icf.com for assistance.', 'candidateaccommodation@icf.com'],
    ['Should a reasonable accommodation be necessary to aid a disability, requests should be sent to Dexcom Talent Acquisition at talentacquisition@dexcom.com .', 'talentacquisition@dexcom.com'],
    ['Any impersonation of Airbus to do so should be reported to emsom@airbus.com .', 'emsom@airbus.com'],
    ['If this posting is missing required information required by local law or incorrect, contact BMS at TAEnablement@bms.com with the Job Title and Requisition number.', 'taenablement@bms.com'],
    ['If you need any extra support throughout the interview process, then please email us at recruitment@collinson.com', 'recruitment@collinson.com'],
    ['Questions? hr@acme.in', 'hr@acme.in'], // no stated purpose
  ];
  for (const [text, email] of other) assert.equal(forRecruiting(text, email), false, email);
  assert.ok(forRecruiting('Freshers welcome. Interested candidates can share their resume at careers@acme.in', 'careers@acme.in'));
  assert.ok(forRecruiting('For accommodations, contact hr@acme.in. Send your CV to hr@acme.in.', 'hr@acme.in'));
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

test('Workday mail changes a status only from @myworkday.com; a domain merely named like the tenant is reviewed', async () => {
  const db = await openDb({ url: ':memory:' });
  // The tenant ("lnwx") is not the company's name, as with Light & Wonder's lnw portal.
  const { id } = await upsertJob(db, { url: 'https://lnwx.wd5.myworkdayjobs.com/jobs/job/B/Data-Analyst_R100001', title: 'Data Analyst', company: 'Light & Wonderex',
    location: 'Bengaluru', description: 'Freshers' }, { source: 'workday', settings });
  const app = await createApplication(db, id, { method: 'portal' });
  await transition(db, app, 'submitted', { evidence: { type: 'workday' }, at: '2026-10-20T10:00:00.000Z' });
  const base = { threadId: 't', fromName: 'x', snippet: '', html: '', authenticated: true, date: '2026-10-20T10:00:05.000Z' };
  const status = async () => (await one(db, 'SELECT status FROM applications WHERE id = ?', [app.id])).status;
  // Anyone can register lnwx.xyz and authenticate mail from it: linked for review, never acted on.
  const fake = await processMessage(db, { ...base, id: 'f1', fromAddr: 'workday@lnwx.xyz', subject: 'Update',
    text: 'We will not be moving forward with your application for Data Analyst.' }, settings, { ourThreadIds: new Set() });
  assert.equal(fake.transitioned, false);
  assert.equal(fake.review, true);
  assert.equal(await status(), 'submitted');
  const real = await processMessage(db, { ...base, id: 'r1', fromAddr: 'lnwx@myworkday.com', subject: 'Thank you for applying',
    text: 'Thank you for applying for the Data Analyst position.' }, settings, { ourThreadIds: new Set() });
  assert.equal(real.transitioned, true);
  assert.equal(await status(), 'confirmed');
});

test('a confirmation for an application CareerPilot did not make is not tracked, even at a company where it applied', async () => {
  const db = await openDb({ url: ':memory:' });
  const { id } = await upsertJob(db, { url: 'https://jobs.lever.co/foo/1', title: 'Junior Data Analyst', company: 'Foo Labs', location: 'Bengaluru', description: 'Freshers' },
    { source: 'lever', settings });
  const ours = await createApplication(db, id, { method: 'portal' });
  const r = await processMessage(db, { id: 'm9', threadId: 't9', fromAddr: 'jobs-noreply@linkedin.com', fromName: 'LinkedIn',
    subject: 'Your application was sent to Foo Labs', text: 'Your application was sent to Foo Labs for Senior Data Engineer', snippet: '',
    date: '2026-10-20T10:00:00.000Z', html: '', authenticated: true }, settings, { ourThreadIds: new Set() });
  assert.equal(r.transitioned, false);
  assert.deepEqual((await all(db, 'SELECT id, status FROM applications')).map((a) => [a.id, a.status]), [[ours.id, 'ready']]);
  assert.equal((await one(db, 'SELECT category FROM emails WHERE id = ?', ['m9'])).category, 'ignored');
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
  assert.equal(await blockReason(db, { job, contact: { ...contact, opted_out: 1 }, kind: 'initial' }, settings), 'contact opted out or address bounced');
  assert.match(await blockReason(db, { job, contact: { ...contact, domain_match: 0 }, kind: 'initial' }, settings), /domain does not match/);
  assert.match(await blockReason(db, { job, contact: { ...contact, domain_match: 0 }, kind: 'application' }, settings), /domain does not match/);
  // No score threshold by default: every qualified job is acted on (the candidate's choice, 2026-10-19).
  assert.equal(await blockReason(db, { job: { ...job, score: 50 }, contact, kind: 'initial' }, settings), null);
  const gated = structuredClone(settings);
  gated.matching.autoActionScore = 70;
  assert.match(await blockReason(db, { job: { ...job, score: 50 }, contact, kind: 'initial' }, gated), /below auto-action/);
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

test('the candidate’s own email is sent unchanged to every recipient, as HTML with its text and the resume', async () => {
  const { kvSet } = await import('../lib/db.mjs');
  const db = await openDb({ url: ':memory:' });
  const messages = [];
  const gmail = { send: async (m) => { messages.push(m); return { id: `g${messages.length}`, threadId: `t${messages.length}` }; } };
  await kvSet(db, 'outreach:template', { subject: 'Reaching Out Regarding Job Opportunities', text: 'Hello,\n\nI am a candidate.\n\nBest regards,\nTest',
    html: '<div>Hello,<br><b>I am a candidate.</b></div>' });
  // Outside the sending window the stage holds everything back, so the window is opened for the test.
  const open = { ...settings, limits: { ...settings.limits, sendWindow: { ...settings.limits.sendWindow, days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' } } };
  await upsertJob(db, { url: 'https://jobs.lever.co/acme/10', title: 'Junior Data Scientist', company: 'Acme', location: 'Bengaluru',
    description: 'Freshers welcome. Send your resume to careers@acme.in' }, { source: 'lever', settings });
  const env = { APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
  await vaultPut(db, 'profile', JSON.stringify(profile), env);
  await vaultPut(db, 'resume.pdf', Buffer.from('%PDF-1.7 test'), env);
  await runOutreach(db, gmail, open, { env });
  assert.equal(messages.length, 1);
  const [m] = messages;
  assert.equal(m.to, 'careers@acme.in');
  assert.equal(m.subject, 'Reaching Out Regarding Job Opportunities');
  assert.equal(m.text, 'Hello,\n\nI am a candidate.\n\nBest regards,\nTest'); // nothing appended
  assert.equal(m.html, '<div>Hello,<br><b>I am a candidate.</b></div>');
  assert.deepEqual(m.attachments.map((a) => a.filename), ['Test_Candidate_Resume.pdf']);
  const mime = buildMime({ ...m, attachments: m.attachments });
  assert.match(mime, /multipart\/mixed[\s\S]*multipart\/alternative[\s\S]*text\/plain[\s\S]*text\/html[\s\S]*application\/pdf/);
});

test('dry run previews emails without sending or recording anything', async () => {
  const db = await openDb({ url: ':memory:' });
  let sent = 0;
  const gmail = { send: async () => { sent++; return { id: 'g', threadId: 't' }; } };
  await upsertJob(db, { url: 'https://jobs.lever.co/acme/8', title: 'Junior Data Scientist', company: 'Acme', location: 'Bengaluru',
    description: 'Freshers welcome. Send your resume to careers@acme.in' }, { source: 'lever', settings });
  const env = { APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), CAREERPILOT_DRY_RUN: '1',
    CAREERPILOT_PREVIEW_FILE: path.join(tmpdir(), `cp-preview-${process.pid}.md`) };
  await vaultPut(db, 'profile', JSON.stringify(profile), env);
  await vaultPut(db, 'resume.pdf', Buffer.from('%PDF-1.7 test'), env);
  const stats = await runOutreach(db, gmail, settings, { env });
  assert.equal(stats.previews, 1);
  assert.equal(sent, 0);
  assert.equal((await all(db, 'SELECT * FROM outreach')).length, 0);
  assert.equal((await all(db, 'SELECT * FROM applications')).length, 0);
});

test('a bounce marks the email application failed and blocks the address', async () => {
  const db = await openDb({ url: ':memory:' });
  const gmail = { send: async () => ({ id: 'g1', threadId: 'thr1' }) };
  const { id } = await upsertJob(db, { url: 'https://jobs.lever.co/acme/9', title: 'Junior Data Scientist', company: 'Acme', location: 'Bengaluru',
    description: 'Freshers welcome. Send your resume to careers@acme.in' }, { source: 'lever', settings });
  await runWithProfile(db, gmail);
  assert.equal((await one(db, 'SELECT status FROM applications WHERE job_id = ?', [id])).status, 'submitted');
  const r = await processMessage(db, { id: 'b1', threadId: 'thr1', fromAddr: 'mailer-daemon@googlemail.com', fromName: 'Mail Delivery Subsystem',
    subject: 'Delivery Status Notification (Failure)', text: "Address not found. Your message wasn't delivered to careers@acme.in", snippet: '',
    date: '2026-10-20T10:00:00.000Z', html: '', authenticated: true }, settings, { ourThreadIds: new Set(['thr1']) });
  assert.equal(r.category, 'bounce');
  assert.equal((await one(db, 'SELECT status FROM applications WHERE job_id = ?', [id])).status, 'failed');
  assert.equal((await one(db, `SELECT status FROM outreach WHERE gmail_thread_id = 'thr1'`)).status, 'bounced');
  assert.equal((await one(db, `SELECT opted_out FROM contacts WHERE email = 'careers@acme.in'`)).opted_out, 1);
});

test('a failed send can be retried, but not endlessly', async () => {
  const db = await openDb({ url: ':memory:' });
  let calls = 0;
  const gmail = { send: async () => { calls++; throw new Error('Gmail API 500'); } };
  await upsertJob(db, { url: 'https://jobs.lever.co/acme/10', title: 'Junior Data Scientist', company: 'Acme', location: 'Bengaluru',
    description: 'Freshers welcome. Send your resume to careers@acme.in' }, { source: 'lever', settings });
  for (let i = 0; i < 5; i++) await runWithProfile(db, gmail);
  assert.equal(calls, 3);
  assert.equal((await one(db, `SELECT status FROM applications`)).status, 'failed');
});

test('dashboard password hashes survive .env loading (no $ expansion) and verify', async () => {
  const { hashPassword, verifyPassword } = await import('../lib/password.mjs');
  const hash = hashPassword('correct horse battery');
  assert.ok(!hash.includes('$'));
  assert.ok(verifyPassword('correct horse battery', hash));
  assert.ok(!verifyPassword('wrong password here', hash));
  assert.ok(!verifyPassword('correct horse battery', 'scrypt$old$format'));
  assert.ok(!verifyPassword('x', undefined));
});

test('a forged bounce (not Google, or unauthenticated) changes nothing and goes to review', async () => {
  const db = await openDb({ url: ':memory:' });
  const gmail = { send: async () => ({ id: 'g1', threadId: 'thr9' }) };
  const { id } = await upsertJob(db, { url: 'https://jobs.lever.co/acme/11', title: 'Junior Data Scientist', company: 'Acme', location: 'Bengaluru',
    description: 'Freshers welcome. Send your resume to careers@acme.in' }, { source: 'lever', settings });
  await runWithProfile(db, gmail);
  const fake = { threadId: 'thr9', fromName: 'Mail Delivery', subject: 'Delivery Status Notification (Failure)', text: 'Address not found', snippet: '',
    date: '2026-10-20T10:00:00.000Z', html: '' };
  const r1 = await processMessage(db, { ...fake, id: 'f1', fromAddr: 'mailer-daemon@evil.example', authenticated: true }, settings, { ourThreadIds: new Set(['thr9']) });
  const r2 = await processMessage(db, { ...fake, id: 'f2', fromAddr: 'mailer-daemon@googlemail.com', authenticated: false }, settings, { ourThreadIds: new Set(['thr9']) });
  assert.equal(r1.review, true);
  assert.equal(r2.review, true);
  assert.equal((await one(db, 'SELECT status FROM applications WHERE job_id = ?', [id])).status, 'submitted');
  assert.equal((await one(db, "SELECT opted_out FROM contacts WHERE email = 'careers@acme.in'")).opted_out, 0);
});

test('quote stripping stays fast on hostile input', () => {
  const hostile = `${'on '}${'x'.repeat(300)}\n`.repeat(5000);
  const t0 = Date.now();
  stripQuoted(hostile);
  assert.ok(Date.now() - t0 < 500);
});

test('email highlights match real skills, not filler words, and come from different roles first', () => {
  const profile = {
    experience: [{ title: 'Data Analyst Intern', company: 'Acme, Bengaluru', points: [
      'Built the sales dashboard with the team for the region and the stores.',
      'Wrote SQL queries for the weekly report.'] }],
    projects: [{ name: 'Forecaster — demand model', stack: 'Python, Pandas', points: ['Forecasts weekly demand for the shop.'] }],
  };
  const picks = relevantHighlights(profile, 'Data Analyst Intern. Must know Python. SQL a plus.', 2);
  assert.match(picks[0], /^Wrote SQL queries/); // SQL beats a bullet full of "the/for/with"
  assert.match(picks[1], /^Forecaster/); // "Python." matches the stack, and the second pick is another source
});

test('Ready is what CareerPilot submits (Workday); a CAPTCHA form is blocked for the candidate, who is emailed once per reason', async () => {
  const { nextStep, sendBlockedAlert, CAPTCHA_FORM } = await import('../lib/prepare.mjs');
  const pack = { missing: [] };
  assert.equal(nextStep({ url: 'https://acme.wd5.myworkdayjobs.com/External/job/Bengaluru/Data-Analyst_R1' }, pack).status, 'ready');
  const gh = nextStep({ url: 'https://job-boards.greenhouse.io/acme/jobs/1' }, pack);
  assert.equal(gh.status, 'blocked');
  assert.ok(gh.reason.startsWith(CAPTCHA_FORM));
  assert.equal(nextStep({ url: 'https://acme.wd5.myworkdayjobs.com/x/job/A_1' }, { missing: ['date_of_birth'] }).status, 'blocked');

  const db = await openDb({ url: ':memory:' });
  const { upsertJob } = await import('../lib/jobs.mjs');
  const { DEFAULT_SETTINGS } = await import('../lib/settings.mjs');
  const job = await upsertJob(db, { url: 'https://job-boards.greenhouse.io/acme/jobs/2', title: 'Data Analyst', company: 'Acme', location: 'Bengaluru',
    description: 'Freshers welcome. Python, SQL.' }, { source: 'greenhouse', boardId: 'b1', settings: DEFAULT_SETTINGS });
  const app = await createApplication(db, job.id, { method: 'portal', status: 'blocked', blockedReason: gh.reason });
  const sent = [];
  const gmail = { send: async (m) => { sent.push(m); return { id: 'm' }; } };
  assert.deepEqual(await sendBlockedAlert(db, gmail, { to: 'me@example.com' }), { sent: 1 });
  assert.match(sent[0].subject, /1 blocked application needs you/);
  assert.match(sent[0].text, /Data Analyst at Acme[\s\S]*CAPTCHA form[\s\S]*greenhouse\.io\/acme\/jobs\/2/);
  assert.deepEqual(await sendBlockedAlert(db, gmail, { to: 'me@example.com' }), { skipped: 'nothing new' }); // told once
  await db.execute({ sql: 'UPDATE applications SET blocked_reason = ? WHERE id = ?', args: ['Needs you: a new question', app.id] });
  assert.deepEqual(await sendBlockedAlert(db, gmail, { to: 'me@example.com' }), { sent: 1 }); // a new reason is news
});

test('a role is applied to once: a repost of one applied to or dropped is a duplicate; a dropped role stays dropped', async () => {
  const { sameRole, markDuplicate } = await import('../lib/applications.mjs');
  const { upsertJob } = await import('../lib/jobs.mjs');
  const { DEFAULT_SETTINGS } = await import('../lib/settings.mjs');
  const db = await openDb({ url: ':memory:' });
  const add = (url, title, location = 'Bengaluru') => upsertJob(db, { url, title, company: 'Acme', location, description: 'Freshers welcome. Python, SQL.' },
    { source: 'greenhouse', boardId: 'b1', settings: DEFAULT_SETTINGS });
  const first = await add('https://job-boards.greenhouse.io/acme/jobs/1', 'Data Analyst');
  const a1 = await createApplication(db, first.id, { method: 'portal' });
  await transition(db, a1, 'submitted', { evidence: { type: 'workday' } });
  // The same role under another link and another spelling of the city.
  const repost = await add('https://job-boards.greenhouse.io/acme/jobs/2', 'Data  Analyst', 'Bangalore');
  const prior = await sameRole(db, { id: repost.id, company: 'Acme', title: 'Data  Analyst' });
  assert.equal(prior?.job_id, first.id);
  await markDuplicate(db, { id: repost.id, status: 'qualified' }, prior);
  assert.equal((await one(db, 'SELECT status, duplicate_of FROM jobs WHERE id = ?', [repost.id])).duplicate_of, first.id);
  // Dropped by the candidate: its repost is a duplicate too. Withdrawn by the system: not (it may come back).
  const dropped = await add('https://job-boards.greenhouse.io/acme/jobs/3', 'Data Engineer');
  const a3 = await createApplication(db, dropped.id, { method: 'portal' });
  await transition(db, a3, 'withdrawn', { reason: 'candidate dropped it', by: 'candidate' });
  assert.ok(await sameRole(db, { id: 'other', company: 'acme', title: 'Data Engineer' }));
  const auto = await add('https://job-boards.greenhouse.io/acme/jobs/4', 'ML Engineer');
  const a4 = await createApplication(db, auto.id, { method: 'portal' });
  await transition(db, a4, 'withdrawn', { reason: 'no longer matches', by: 'system' });
  assert.equal(await sameRole(db, { id: 'other', company: 'Acme', title: 'ML Engineer' }), null);
  // Another role at the same company is not a duplicate.
  assert.equal(await sameRole(db, { id: 'other', company: 'Acme', title: 'Data Scientist' }), null);
  // The role posted again after the application (a later posting date) is applied to afresh; an earlier
  // date is the same posting cycle. Undated, it is a repost only once the first posting has closed.
  assert.equal(await sameRole(db, { id: 'n1', company: 'Acme', title: 'Data Analyst', posted_at: '2099-01-01T00:00:00Z' }), null);
  assert.ok(await sameRole(db, { id: 'n2', company: 'Acme', title: 'Data Analyst', posted_at: '2000-01-01T00:00:00Z' }));
  await db.execute({ sql: "UPDATE jobs SET status = 'expired' WHERE id = ?", args: [first.id] });
  assert.equal(await sameRole(db, { id: 'n3', company: 'Acme', title: 'Data Analyst' }), null);
  // A dropped role stays dropped even when posted again.
  assert.ok(await sameRole(db, { id: 'n4', company: 'Acme', title: 'Data Engineer', posted_at: '2099-01-01T00:00:00Z' }));
});

test('dropping a job from the dashboard is permanent, with or without an application', async () => {
  const { dropJob, sameRole } = await import('../lib/applications.mjs');
  const { upsertJob } = await import('../lib/jobs.mjs');
  const { DEFAULT_SETTINGS } = await import('../lib/settings.mjs');
  const db = await openDb({ url: ':memory:' });
  const add = (n) => upsertJob(db, { url: `https://job-boards.greenhouse.io/acme/jobs/${n}`, title: `Role ${n}`, company: 'Acme', location: 'Bengaluru',
    description: 'Freshers welcome. Python, SQL.' }, { source: 'greenhouse', boardId: 'b1', settings: DEFAULT_SETTINGS });
  const bare = await add(1); // no application yet
  assert.equal(await dropJob(db, bare.id), true);
  assert.equal((await one(db, 'SELECT status FROM applications WHERE job_id = ?', [bare.id])).status, 'withdrawn');
  const queued = await add(2);
  await createApplication(db, queued.id, { method: 'portal' });
  assert.equal(await dropJob(db, queued.id), true);
  assert.equal(await dropJob(db, queued.id), true); // dropping twice is harmless
  // A repost of a dropped role, even dated later, is a duplicate.
  assert.ok(await sameRole(db, { id: 'x', company: 'Acme', title: 'Role 2', posted_at: '2099-01-01T00:00:00Z' }));
  await assert.rejects(() => dropJob(db, 'nope'), /Unknown job/);
});

test('a blocked application the candidate marks done counts as applied, and its acknowledgement confirms it', async () => {
  const db = await openDb({ url: ':memory:' });
  const job = async (company) => (await upsertJob(db, { url: `https://boards.greenhouse.io/${company.toLowerCase()}/jobs/1`, company, title: 'Data Analyst',
    location: 'Bengaluru', description: 'Freshers welcome' }, { source: 'greenhouse', settings })).id;
  const shown = async () => (await all(db, `SELECT a.id, a.status FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${SHOWN_APP} ORDER BY j.company`))
    .map((r) => `${r.id}:${r.status}`);
  const get = (id) => one(db, 'SELECT * FROM applications WHERE id = ?', [id]);
  const ack = async (id) => transition(db, await get(id), 'confirmed', { evidence: { type: 'email', emailId: `e-${id}` }, reason: 'application_confirmation email' });
  const done = await createApplication(db, await job('Acme'), { status: 'blocked', method: 'portal', blockedReason: 'CAPTCHA form: Greenhouse' });
  const early = await createApplication(db, await job('Beta'), { status: 'blocked', method: 'portal', blockedReason: 'CAPTCHA form: Greenhouse' });
  const own = await createApplication(db, await job('Gamma'), { status: 'ready', method: 'portal' });

  assert.equal(await markDone(db, own.id), false, 'only a blocked application is marked done');
  assert.equal(await markDone(db, done.id), true);
  assert.equal((await get(done.id)).status, 'submitted');
  assert.ok((await get(done.id)).submitted_at);
  assert.ok(await ack(done.id)); // the employer's acknowledgement, later
  assert.ok(await ack(early.id)); // acknowledged before the candidate marked it done
  assert.equal(await markDone(db, early.id), true, 'a late Done changes nothing');
  assert.ok(await ack(own.id)); // a ready one the candidate sent on their own stays theirs
  assert.deepEqual(await shown(), [`${done.id}:confirmed`, `${early.id}:confirmed`]);
});
