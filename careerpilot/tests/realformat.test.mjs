// Messages in the exact shapes seen in a real job-search inbox (foundit, SHL, LinkedIn, newsletters,
// the candidate's own sent applications). All names, ids and addresses here are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { all, one, openDb } from '../lib/db.mjs';
import { applicationDetails, classifyEmail, extractDetails, sentApplication } from '../lib/email-intel.mjs';
import { processMessage, processSentMessage } from '../lib/gmail-sync.mjs';
import { DEFAULT_SETTINGS as settings } from '../lib/settings.mjs';

const foundit = {
  fromAddr: 'job@monsterindia.com', threadId: 'f1',
  subject: 'Examplecorp Application Successful | Ace your interview using PrepAI’s personalised Q&A⚡',
  text: "Hi Test Candidate,📨 you've applied to Analyst I job at Examplecorp. Recruiter will call you on +91 90000 00000 Prep for your upcoming interview",
  html: '<a href="https://www.foundit.in/rio/autoLogin/seeker/SECRET?return_url=https%3A%2F%2Fwww.foundit.in%2Fcareer-services%2Fprep-ai%3FjobId%3D34840156">x</a>',
};
const shl = {
  fromAddr: 'talentcentral@shl.com', subject: 'Assessment Invitation',
  text: 'Dear Candidate,\n\nAs part of the recruitment process *Example Retail India Limited* invites you to complete one or more assessments.\n'
    + 'Please note that below autologin link is valid from 17 October 2026 at 19:00 till 17 October 2026 at 23:00 only.\n'
    + '[ start ](https://amcatglobal.aspiringminds.com/?autoLoginVersion=3&token=SECRETTOKEN)',
};

test('foundit confirmations: category, company, role and a token-free job link', () => {
  assert.equal(classifyEmail(foundit).category, 'application_confirmation');
  assert.deepEqual(applicationDetails(foundit), { company: 'Examplecorp', title: 'Analyst I', url: 'https://www.foundit.in/seeker/job-details?id=34840156' });
  const hidden = { ...foundit, subject: '** Application Successful | Ace your interview', text: "you've applied to Data Analyst job at **. Recruiter will call you" };
  assert.equal(applicationDetails(hidden).company, null);
  assert.equal(applicationDetails(hidden).title, 'Data Analyst');
});

test('vendor assessment invites: employer, window, and links without session tokens', () => {
  assert.equal(classifyEmail(shl).category, 'assessment');
  assert.equal(applicationDetails(shl).company, 'Example Retail India Limited');
  const d = extractDetails(shl);
  assert.deepEqual(d.assessmentLinks, ['https://amcatglobal.aspiringminds.com/']);
  assert.match(d.deadline, /valid from 17 October 2026 at 19:00/);
  assert.ok(d.dates.some((x) => /17 October 2026 at 19:00/.test(x)));
});

test('newsletters, social notices and promos are not hiring events', () => {
  const c = (fromAddr, subject, text) => classifyEmail({ fromAddr, subject, text }).category;
  assert.equal(c('someone@substack.com', 'Are LLMs Enough?', 'An interview with Prof. X on causal intelligence'), 'other');
  assert.equal(c('contact@mailer.internshipstudio.com', 'Following your exam submission', '1 Skill Assessment Evaluate your skills'), 'other');
  assert.equal(c('notifications-noreply@linkedin.com', 'You have 1 new message', 'See who reached out'), 'other');
  assert.equal(c('updates-noreply@linkedin.com', 'Someone and others just posted', 'Hiring for Fund Accounting'), 'other');
  assert.equal(c('jobalerts-noreply@linkedin.com', 'Data Scientist: 12 new jobs in Bengaluru', 'x'), 'job_alert');
});

test('sent application detection', () => {
  assert.deepEqual(sentApplication({ subject: 'Application for MIS & Data Analytics Position', attachments: [{ filename: 'cv.pdf' }] }), { title: 'MIS & Data Analytics' });
  assert.equal(sentApplication({ subject: 'Re: Application for Data Analyst' }), null);
  assert.equal(sentApplication({ subject: 'Full Paper Submission – Conference' }), null);
});

test('trusted platform confirmations and assessment invites create tracked applications; untrusted ones do not', async () => {
  const db = await openDb({ url: ':memory:' });
  const base = { snippet: '', date: '2026-10-17T06:46:23.000Z', html: '', fromName: 'x', authenticated: true };
  await processMessage(db, { ...base, ...foundit, id: 'c1' }, settings, { ourThreadIds: new Set() });
  await processMessage(db, { ...base, ...shl, id: 'c2', threadId: 't2' }, settings, { ourThreadIds: new Set() });
  await processMessage(db, { ...base, id: 'c3', threadId: 't3', fromAddr: 'job@monsterindia.com', authenticated: false,
    subject: 'Evilcorp Application Successful', text: "you've applied to Boss job at Evilcorp." }, settings, { ourThreadIds: new Set() });
  const apps = await all(db, 'SELECT a.status, j.company, j.title, j.url FROM applications a JOIN jobs j ON j.id = a.job_id ORDER BY j.company');
  assert.deepEqual(apps.map((a) => [a.company, a.title, a.status]), [
    ['Example Retail India Limited', 'Assessment (from email)', 'assessment'],
    ['Examplecorp', 'Analyst I', 'confirmed'],
  ]);
  assert.equal(apps[1].url, 'https://www.foundit.in/seeker/job-details?id=34840156');
});

test('the candidate’s own sent application is recorded as submitted and replies in its thread update it', async () => {
  const db = await openDb({ url: ':memory:' });
  const msg = { id: 's1', threadId: 'ts1', subject: 'Application for MIS & Data Analytics Position', to: 'hr.coordinator@gmail.com',
    attachments: [{ filename: 'Resume.pdf' }], date: '2026-10-17T07:03:59.000Z', text: 'Dear Hiring Team', snippet: '', fromAddr: 'me@example.org' };
  assert.equal((await processSentMessage(db, msg, settings, { selfAddress: 'me@example.org' })).recorded, true);
  const app = await one(db, 'SELECT a.*, j.company, j.title FROM applications a JOIN jobs j ON j.id = a.job_id');
  assert.equal(app.status, 'submitted');
  assert.equal(app.company, 'via hr.coordinator@gmail.com');
  assert.equal(app.title, 'MIS & Data Analytics');
  const reply = await processMessage(db, { id: 's2', threadId: 'ts1', fromAddr: 'hr.coordinator@gmail.com', fromName: 'HR', subject: 'Re: Application',
    text: 'We would like to invite you for an interview on Monday. Please share your availability.', snippet: '', date: '2026-10-18T07:00:00.000Z', html: '' },
  settings, { ourThreadIds: new Set(['ts1']) });
  assert.equal(reply.transitioned, true);
  assert.equal((await one(db, 'SELECT status FROM applications')).status, 'interview');
  // Mail to yourself (the daily digest) is not an application.
  assert.equal((await processSentMessage(db, { ...msg, id: 's3', to: 'me@example.org' }, settings, { selfAddress: 'me@example.org' })).recorded, false);
});
