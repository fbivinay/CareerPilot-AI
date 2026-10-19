// Classification against realistic hiring-email wording, including the traps that cause wrong
// automatic status changes: conditional phrasing, quoted replies, and polite rejections.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEmail, extractDetails, isJobEmail, laterReply, stripQuoted } from '../lib/email-intel.mjs';
import { createGmail, fromAuthenticated, parseMessage } from '../lib/gmail.mjs';

const c = (subject, text, fromAddr = 'no-reply@us.greenhouse-mail.io', opts) => classifyEmail({ subject, text, fromAddr, threadId: 't1' }, opts);

test('confirmations, including ones that mention interviews conditionally', () => {
  assert.deepEqual(c('Thank you for applying to Acme', 'Hi Vinay,\nThank you for your interest in Acme! We have received your application for Data Analyst. Our team will review it and, if your background is a match, we will reach out to schedule an interview.\nBest, Acme Recruiting'),
    { category: 'application_confirmation', confidence: 0.9 });
  assert.equal(c('Application received', 'Your application has been received. If you are shortlisted, our team will invite you for an interview.').category, 'application_confirmation');
  assert.equal(c('Your application was sent to Foo Labs', 'Your application was sent to Foo Labs. Data Scientist · Bengaluru', 'jobs-noreply@linkedin.com').category, 'application_confirmation');
  assert.equal(c('Once again, thank you for applying', 'Once again, thank you for applying to Acme.').category, 'application_confirmation');
});

test('rejections, including polite ones that also thank the candidate', () => {
  assert.equal(c('Your application to Acme', 'Thank you for applying. Unfortunately, we have decided to move forward with other candidates whose experience more closely matches our needs.').category, 'rejection');
  assert.equal(c('Update on your application', 'After careful consideration, we will not be moving forward with your application at this time, but should another role match your profile we will reach out.').category, 'rejection');
  assert.equal(c('Acme application', 'We regret to inform you that you have not been shortlisted.').category, 'rejection');
  // "Unfortunately" alone is only a hint: low confidence, so it goes to review.
  assert.deepEqual(c('Delay', 'Unfortunately our hiring team is travelling this week, so reviews will take longer.'), { category: 'rejection', confidence: 0.6 });
});

test('interviews and assessments', () => {
  assert.equal(c('Interview invitation - Data Analyst', 'We would like to invite you to an interview for the Data Analyst role. Please share your availability for next week.').category, 'interview');
  assert.equal(c('Invitation: Technical Interview @ Mon Oct 26, 2026 11am - 12pm (IST)', 'Join with Google Meet: https://meet.google.com/abc-defg-hij', 'calendar-notification@google.com').category, 'interview');
  assert.equal(c('Next steps', 'Please book a time with our recruiter here: https://calendly.com/acme/30min').category, 'interview');
  assert.equal(c('Coding challenge', 'Please complete the online assessment within 3 days using the link below.\nhttps://www.hackerrank.com/test/abc123').category, 'assessment');
  assert.equal(c('Acme assessment', 'Your HackerRank test is ready: https://hackerrank.com/tests/xyz').category, 'assessment');
});

test('offers, and "offer you an interview" is not an offer', () => {
  assert.equal(c('Offer letter - Acme', 'We are pleased to extend an offer for the position of Data Analyst. Please find the offer letter attached.').category, 'offer');
  assert.equal(c('Great news', 'We are pleased to offer you an interview with our team on Monday. Please share your availability.').category, 'interview');
});

test('job alerts and platform notices', () => {
  assert.equal(c('15 new jobs for "Data Scientist" in Bengaluru', 'Junior Data Scientist · Acme · Bengaluru', 'jobalerts-noreply@linkedin.com').category, 'job_alert');
  assert.equal(c('Recommended jobs for you', 'Data Analyst - Foo Pvt Ltd', 'naukrialerts@naukri.com').category, 'job_alert');
  assert.equal(c('Your application was viewed by Acme', 'Acme viewed your application.', 'jobs-noreply@linkedin.com').category, 'ats_update');
});

test('a reply quoting our outreach is judged on the reply, not on our opt-out line', () => {
  const ours = new Set(['t1']);
  const reply = 'Hi Vinay, thanks for reaching out. Can you share your availability for a quick call on Tuesday?\n\nOn Mon, 19 Oct 2026 at 10:00, R Vinay Kumar <candidate@example.com> wrote:\n> Hello,\n> I came across the Data Analyst role...\n> If you would prefer not to hear from me again, just reply "unsubscribe".';
  assert.equal(c('Re: Data Analyst at Acme', reply, 'priya@acme.in', { ourThreadIds: ours }).category, 'interview');
  assert.equal(c('Re: Data Analyst at Acme', 'Thanks, we will keep your profile on file.\n\nOn Mon, 19 Oct 2026, R Vinay Kumar wrote:\n> ... reply "unsubscribe" ...', 'priya@acme.in', { ourThreadIds: ours }).category, 'recruiter_reply');
  assert.equal(c('Re: Data Analyst at Acme', 'Please unsubscribe me from these emails.', 'priya@acme.in', { ourThreadIds: ours }).category, 'opt_out');
  assert.equal(stripQuoted('new text\n-----Original Message-----\nold'), 'new text\n');
});

test('extracts dates, deadlines and assessment/meeting links', () => {
  const d = extractDetails({ text: 'Your interview is on 26 Oct 2026 at 11:00 am IST. Complete the test by 24 Oct. Link: https://www.hackerrank.com/test/abc https://meet.google.com/x-y-z' });
  assert.ok(d.dates.some((x) => x.startsWith('26 Oct 2026')));
  assert.match(d.deadline, /by 24 Oct/);
  assert.deepEqual(d.assessmentLinks, ['https://www.hackerrank.com/test/abc']);
  assert.deepEqual(d.meetingLinks, ['https://meet.google.com/x-y-z']);
});

test('sender authentication uses DMARC or aligned DKIM from Gmail’s own header only', () => {
  const msg = (auth) => parseMessage({ id: '1', threadId: 't', payload: { headers: [
    { name: 'From', value: 'Acme Hiring <no-reply@hire.lever.co>' },
    { name: 'Authentication-Results', value: 'attacker.example; dmarc=pass' },
    ...(auth ? [{ name: 'Authentication-Results', value: auth }] : []),
    { name: 'Subject', value: 'x' }] } });
  assert.equal(msg(null).authenticated, false); // forged header from the sender is ignored
  assert.equal(msg('mx.google.com; dkim=pass header.i=@hire.lever.co; spf=pass; dmarc=pass (p=NONE)').authenticated, true);
  assert.equal(msg('mx.google.com; dkim=pass header.i=@evil.com; spf=pass').authenticated, false);
  assert.equal(fromAuthenticated('mx.google.com; spf=pass smtp.mailfrom=x@acme.in', 'x@acme.in'), false);
});

test('HTML-only replies drop the quoted history', () => {
  const html = '<div>Sure, let us talk Tuesday.</div><div class="gmail_quote"><div>On Mon wrote:</div><blockquote>reply "unsubscribe"</blockquote></div>';
  const m = parseMessage({ id: '1', threadId: 't', payload: { mimeType: 'text/html', headers: [], body: { data: Buffer.from(html).toString('base64url') } } });
  assert.match(m.text, /Tuesday/);
  assert.doesNotMatch(m.text, /unsubscribe/);
});

test('a display name cannot smuggle in a trusted sender address', async () => {
  const { parseFrom } = await import('../lib/gmail.mjs');
  assert.deepEqual(parseFrom('Acme Hiring <no-reply@hire.lever.co>'), { addr: 'no-reply@hire.lever.co', name: 'Acme Hiring', valid: true });
  assert.equal(parseFrom('hr@acme.in').addr, 'hr@acme.in');
  // The quoted display name contains a fake angle address; the real address is the attacker's.
  assert.equal(parseFrom('"<hr@acme.com>" <attacker@evil.com>').addr, 'attacker@evil.com');
  assert.equal(parseFrom('<hr@acme.com> <attacker@evil.com>').valid, false);
  assert.equal(parseFrom('Acme <hr@acme.com>, Other <x@y.com>').valid, false);
  const msg = (from, auth) => parseMessage({ id: '1', threadId: 't', payload: { headers: [
    { name: 'From', value: from }, { name: 'Authentication-Results', value: auth }, { name: 'Subject', value: 'x' }] } });
  // DMARC passed for evil.com; the message must not be treated as authenticated mail from acme.com.
  const spoof = msg('"<hr@acme.com>" <attacker@evil.com>', 'mx.google.com; dkim=pass header.i=@evil.com; dmarc=pass (p=NONE) header.from=evil.com');
  assert.equal(spoof.fromAddr, 'attacker@evil.com');
  assert.ok(!(spoof.fromAddr.endsWith('acme.com') && spoof.authenticated));
  assert.equal(msg('HR <hr@acme.com>', 'mx.google.com; dmarc=pass (p=REJECT) header.from=evil.com').authenticated, false);
  assert.equal(msg('HR <hr@acme.com>', 'mx.google.com; dmarc=pass (p=REJECT) header.from=acme.com').authenticated, true);
});

test('Gmail calls stay under the per-user quota and rate-limit replies are retried', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  let limited = 1;
  const fetchImpl = async (url) => {
    if (url.includes('oauth2')) return Response.json({ access_token: 't', expires_in: 3600 });
    calls.push(Date.now());
    if (limited-- > 0) return new Response(`{"error":{"code":403,"message":"Quota exceeded for quota metric 'Total Query Cost'"}}`, { status: 403 });
    return Response.json({ id: 'm', payload: { headers: [{ name: 'From', value: 'a@b.com' }, { name: 'Subject', value: 'x' }] } });
  };
  const gmail = createGmail({ clientId: 'c', clientSecret: 's', refreshToken: 'r', fetchImpl, quotaPerMinute: 120 });
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  const a = gmail.get('a');
  await flush();
  t.mock.timers.tick(2_000); // the 403 quota reply is retried after a pause
  await a;
  const b = gmail.get('b'); // two full reads (60 units each) used the 120-unit minute
  await flush();
  assert.equal(calls.length, 2, 'waits for the quota window instead of calling');
  t.mock.timers.tick(58_050);
  await b;
  assert.deepEqual(calls, [0, 2_000, 60_050]);
});

test('Gmail sync reads every message since the checkpoint from every tab, not just the newest 300', async () => {
  const { openDb } = await import('../lib/db.mjs');
  const { syncGmail } = await import('../lib/gmail-sync.mjs');
  const { DEFAULT_SETTINGS } = await import('../lib/settings.mjs');
  const db = await openDb({ url: ':memory:' });
  const ids = Array.from({ length: 450 }, (_, i) => `m${449 - i}`); // Gmail order: newest first
  const queries = [];
  const gmail = {
    listIds: async (q, max) => { queries.push(q); return q.includes('in:sent') && !q.includes('-in:sent') ? [] : ids.slice(0, max); },
    get: async (id) => ({ id, threadId: id, fromAddr: 'news@example.org', fromName: 'News', subject: 'Weekly digest', text: 'Hello',
      snippet: '', date: new Date(Date.UTC(2026, 9, 1) + Number(id.slice(1)) * 60_000).toISOString() }),
  };
  const r = await syncGmail(db, gmail, { ...DEFAULT_SETTINGS, timeline: null });
  assert.equal(r.processed, 450);
  assert.ok(queries.every((q) => !q.includes('category:')));
  assert.ok(queries.every((q) => q.includes('-in:sent')), 'without the candidate\'s address the sent folder is not read');
});

test('the candidate’s job emails are told from their other sent mail by the subject', () => {
  // Their real sent mail of 2026-10-18 and the weeks before: two job emails, then paper and conference mail.
  for (const s of ['Reaching Out Regarding Job Opportunities', 'Application for MIS & Data Analytics Position', 'Resume - R Vinay Kumar',
    'Data Scientist – R Vinay Kumar']) assert.ok(isJobEmail(s), s);
  for (const s of ['Full Paper Submission – CONFLUENCE-2026 – Theme 5', 'Follow-up Regarding Abstract Acceptance – CONFLUENCE-2026 | Theme 5',
    'Fwd: Registration Confirmed - 2nd International Conference 2026', 'Inquiry Regarding Manuscript EB-26-00661',
    'Application of deep learning to crop yields – camera-ready paper', '']) assert.ok(!isJobEmail(s), s);
  // A plain reply never hides an earlier decision; a later decision replaces it.
  assert.equal(laterReply({ category: 'interview', at: '1' }, { category: 'recruiter_reply', at: '2' }).category, 'interview');
  assert.equal(laterReply({ category: 'interview', at: '1' }, { category: 'rejection', at: '2' }).category, 'rejection');
  assert.equal(laterReply(null, { category: 'recruiter_reply', at: '2' }).category, 'recruiter_reply');
});

test('the candidate’s own job emails are kept with their replies; CareerPilot’s sends and other sent mail are not', async () => {
  const { openDb, all, run } = await import('../lib/db.mjs');
  const { syncGmail } = await import('../lib/gmail-sync.mjs');
  const { DEFAULT_SETTINGS } = await import('../lib/settings.mjs');
  const db = await openDb({ url: ':memory:' });
  const me = 'candidate@example.com';
  const at = (h) => new Date(Date.UTC(2026, 9, 18, h)).toISOString();
  await run(db, `INSERT INTO contacts (id, email, source_type, created_at) VALUES ('c1', 'hr@acme.in', 'jd', ?)`, [at(0)]);
  await run(db, `INSERT INTO outreach (id, contact_id, kind, subject, body, status, gmail_message_id, gmail_thread_id, sent_at, created_at)
    VALUES ('o1', 'c1', 'initial', 'Application for Data Analyst', 'b', 'sent', 'cp1', 'tcp', ?, ?)`, [at(1), at(1)]);
  // A send interrupted before its Gmail id was kept: still CareerPilot's, known by subject and recipient.
  await run(db, `INSERT INTO outreach (id, contact_id, kind, subject, body, status, created_at) VALUES ('o2', 'c1', 'application', 'Application for Data Engineer – R Vinay Kumar', 'b', 'unknown', ?)`, [at(1)]);
  const subject = 'Application for MIS & Data Analytics Position';
  const mail = {
    cp1: { threadId: 'tcp', to: 'hr@acme.in', subject: 'Application for Data Analyst – R Vinay Kumar', date: at(1) }, // CareerPilot's
    cp2: { threadId: 'tcp2', to: 'HR <hr@acme.in>', subject: 'Application for Data Engineer – R Vinay Kumar', date: at(1) }, // CareerPilot's, interrupted
    s1: { threadId: 't1', to: '"Priya Rao" <priya@beta.io>', subject, date: at(2) },
    s2: { threadId: 't2', to: 'editor@journal.org', subject: 'Inquiry Regarding Manuscript EB-26-00661', date: at(3) },
    s3: { threadId: 't3', to: me, subject: 'CareerPilot: 2 blocked applications need you', date: at(4) }, // an alert to themselves
    s4: { threadId: 't1', to: 'priya@beta.io', subject: `Re: ${subject}`, date: at(7) }, // their own follow-up in the conversation
    r0: { threadId: 't1', fromAddr: 'priya@beta.io', fromName: 'Priya Rao', subject: `Re: ${subject}`, date: at(5),
      text: 'We would like to invite you to an interview for the role. Please share your availability for next week.' },
    r1: { threadId: 't1', fromAddr: 'priya@beta.io', fromName: 'Priya Rao', subject: `Re: ${subject}`, date: at(8), text: 'Thanks, noted.' },
  };
  // s1 was recorded by the version that logged the candidate's own applications from their sent mail (Oct 17).
  await run(db, `INSERT INTO emails (id, category, processed_at) VALUES ('s1', 'sent_application', ?)`, [at(2)]);
  // r0 arrived before the conversation was tracked and was set aside as unrelated mail; r1 is new.
  await run(db, `INSERT INTO emails (id, category, processed_at) VALUES ('r0', 'ignored', ?)`, [at(6)]);
  const gmail = {
    listIds: async (q) => (q.includes('-in:sent') ? ['r1'] : ['s4', 's3', 's2', 's1', 'cp2', 'cp1']), // newest first
    get: async (id) => ({ id, fromAddr: me, fromName: 'R Vinay Kumar', text: '', snippet: '', labelIds: [], ...mail[id] }),
    thread: async (t) => Object.keys(mail).filter((id) => mail[id].threadId === t).map((id) => ({ id, labelIds: id.startsWith('r') ? ['INBOX'] : ['SENT'] })),
  };
  const r = await syncGmail(db, gmail, { ...DEFAULT_SETTINGS, timeline: null }, { me });
  assert.equal(r.sentTracked, 1);
  // The interview invitation is kept over the later plain reply.
  assert.deepEqual((await all(db, 'SELECT * FROM sent_mail')).map((x) => [x.id, x.to_addr, x.to_name, x.reply_category, x.reply_from]),
    [['s1', 'priya@beta.io', 'Priya Rao', 'interview', 'Priya Rao']]);
  // Everything else is remembered by id only, and the reply is linked to nothing.
  assert.deepEqual((await all(db, `SELECT id FROM emails WHERE category = 'ignored' AND subject IS NULL ORDER BY id`)).map((x) => x.id), ['cp2', 'r0', 'r1', 's2', 's3', 's4']);
  assert.equal((await all(db, 'SELECT id FROM emails')).length, 7);
});
