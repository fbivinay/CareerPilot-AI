// Messages in the exact shapes seen in a real job-search inbox (foundit, SHL, LinkedIn, newsletters).
// All names, ids and addresses here are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { all, one, openDb } from '../lib/db.mjs';
import { applicationDetails, classifyEmail, extractDetails } from '../lib/email-intel.mjs';
import { processMessage } from '../lib/gmail-sync.mjs';
import { upsertJob } from '../lib/jobs.mjs';
import { createApplication } from '../lib/applications.mjs';
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
  // Platform fraud warnings mention "job offer" in every footer.
  assert.equal(c('noreply@monsterindia.com', 'foundit (Monster): Verify your email address', 'Please verify your email address. '
    + 'foundit also advises users to beware of any fraudulent communication asking for personal /banking information or seeking money for any job offer.'), 'other');
});

test('the candidate’s own applications (job-site confirmations, assessment invites) are not tracked or kept', async () => {
  const db = await openDb({ url: ':memory:' });
  const base = { snippet: '', date: '2026-10-17T06:46:23.000Z', html: '', fromName: 'x', authenticated: true };
  await processMessage(db, { ...base, ...foundit, id: 'c1' }, settings, { ourThreadIds: new Set() });
  await processMessage(db, { ...base, ...shl, id: 'c2', threadId: 't2' }, settings, { ourThreadIds: new Set() });
  assert.deepEqual(await all(db, 'SELECT * FROM applications'), []);
  assert.deepEqual(await all(db, 'SELECT * FROM jobs'), []);
  assert.deepEqual((await all(db, 'SELECT category, subject FROM emails ORDER BY id')).map((e) => [e.category, e.subject]), [['ignored', null], ['ignored', null]]);
});

test('foundit role text split across lines', () => {
  const mail = (id, jobId) => ({ ...foundit, id, threadId: `t${id}`, snippet: '', date: '2026-10-17T06:46:23.000Z', fromName: 'foundit', authenticated: true,
    subject: 'Examplecorp Application Successful | Ace your interview',
    text: "Get the app \r\n Hi Test Candidate,📨 you've\r\n applied\r\n to Analyst I\r\n job\r\n at Examplecorp.\n Recruiter will call you on \r\n"
      + ' Jobs you may like: Data Analyst at Othercorp.',
    html: `<a href="https://www.foundit.in/x?jobId%3D${jobId}">x</a>` });
  assert.deepEqual(applicationDetails(mail('a', '111111')), { company: 'Examplecorp', title: 'Analyst I', url: 'https://www.foundit.in/seeker/job-details?id=111111' });
});

test('an offer letter mentioned in a promotion is not an offer; one that is attached is', () => {
  const c = (subject, text) => classifyEmail({ fromAddr: 'team@mailer.example-edtech.com', subject, text }).category;
  assert.equal(c('Final Batch Allocation Notice', 'Benefits:\n• Offer letter upon batch confirmation\n• Certificate'), 'other');
  assert.equal(c('Result is LIVE', 'Your offer letter will be available to download from the portal.'), 'other');
  assert.equal(classifyEmail({ fromAddr: 'hr@acme.com', subject: 'Welcome', text: 'Please find attached your offer letter for the Data Analyst role.' }).category, 'offer');
});

test('Wellfound confirmations: the upsell is not an interview, and companies named in the blurb are not linked', async () => {
  const wf = { id: 'w1', threadId: 'tw1', fromAddr: 'team@hi.wellfound.com', fromName: 'Wellfound', snippet: '', html: '', authenticated: true,
    date: '2026-10-17T12:09:17.000Z', subject: 'Application to Exampleschool successfully submitted',
    text: "Your application has been submitted! \r\n\r\n If there's a match, we will make an email introduction. \r\n\r\n * Data Analyst Intern \r\n"
      + '<https://wellfound.com/jobs/4823693-data-analyst-intern?utm=x> \r\n Schedule your first interview \r\n'
      + 'Founded by alumni of companies like Othercorp, Microsoft and Zomato among others.' };
  assert.equal(classifyEmail(wf).category, 'application_confirmation');
  assert.deepEqual(applicationDetails(wf), { company: 'Exampleschool', title: 'Data Analyst Intern', url: 'https://wellfound.com/jobs/4823693' });
  // With a real meeting link the same subject can still carry an interview invite.
  assert.equal(classifyEmail({ ...wf, text: `${wf.text}\nSchedule your first interview: https://calendly.com/acme/30min` }).category, 'interview');
  assert.equal(classifyEmail({ fromAddr: 'alerts@monsterindia.com', subject: 'Beware of fraudsters impersonating foundit partners',
    text: 'But unfortunately, some unscrupulous individuals claim to be our associates.' }).category, 'other');

  // CareerPilot's queued application at a company the blurb names is not touched by someone else's confirmation.
  const db = await openDb({ url: ':memory:' });
  const other = await upsertJob(db, { url: 'https://jobs.example.com/othercorp/1', title: 'Product Analyst', company: 'Othercorp', location: 'Bengaluru' }, { source: 'test', settings });
  await createApplication(db, other.id, { status: 'ready', method: 'portal' });
  await processMessage(db, wf, settings, { ourThreadIds: new Set() });
  const apps = await all(db, 'SELECT a.status, j.company, j.title FROM applications a JOIN jobs j ON j.id = a.job_id ORDER BY j.company');
  assert.deepEqual(apps.map((a) => [a.company, a.title, a.status]), [['Othercorp', 'Product Analyst', 'ready']]);
});

test('non-job mail: a failed KYC check is no rejection, and newsletters naming a company are not linked to it', async () => {
  assert.notEqual(classifyEmail({ fromAddr: 'noreply@digilocker.gov.in', subject: 'Aadhaar KYC Verification Failed - DigiLocker',
    text: 'Dear User, we regret to inform you that your Aadhaar KYC verification attempt has failed.' }).category, 'rejection');
  assert.equal(classifyEmail({ fromAddr: 'jobs@acme.com', subject: 'Your application',
    text: 'We regret to inform you that your application was not successful.' }).category, 'rejection');

  const db = await openDb({ url: ':memory:' });
  const job = await upsertJob(db, { url: 'https://jobs.example.com/target/1', title: 'Data Analyst', company: 'Target', location: 'Bengaluru' }, { source: 'test', settings });
  await createApplication(db, job.id, { status: 'assessment' });
  const letter = { id: 'n1', threadId: 'tn1', fromAddr: 'writer@substack.com', fromName: 'AI Weekly', snippet: '', html: '',
    date: '2026-10-10T08:00:00.000Z', subject: 'When Agents Cross the Boundary', listUnsubscribe: '<https://substack.com/unsubscribe>',
    text: 'This week: what is a good target for agent reliability? Target and Walmart both shipped new assistants.' };
  await processMessage(db, letter, settings, { ourThreadIds: new Set() });
  assert.equal((await one(db, 'SELECT application_id FROM emails WHERE id = ?', ['n1'])).application_id, null);
});
