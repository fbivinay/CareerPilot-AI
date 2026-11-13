import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessmentOf } from '../lib/email-intel.mjs';
import { openDb, kvGet } from '../lib/db.mjs';
import { scanAssessments } from '../lib/gmail-sync.mjs';

// Shapes of the candidate's real mail (2026-10/11), reworded.
const mail = (o) => ({ id: 'm', threadId: 't', fromName: '', text: '', html: '', subject: '', labelIds: [], ...o });
const shl = mail({ fromAddr: 'talentcentral@shl.com', fromName: 'Sutherland Global', subject: 'Your assessment invitation',
  text: 'Dear Candidate, As part of the recruitment process Sutherland Global Services, Inc invites you to complete one or more assessments. Please use a laptop.' });
const adaface = mail({ fromAddr: 'shreya.k@puffy.com', fromName: 'Shreya K', subject: 'Your Next Steps with Puffy for the Data Analyst position!',
  text: 'Your next stage: Phase 1. Phase 1 consists of two parts, both completed on Adaface. Please complete both within *2 business days of receiving this email*. This part is proctored. You do not need to wait for your Phase 1A result.',
  html: '<a href="https://app.adaface.com/start/abc">Start</a>' });
const emailedPaper = mail({ fromAddr: 'hr@anklesaria.com', fromName: 'HR Ops', subject: 'ANKLESARIA Test Questions',
  text: 'Dear Candidate, Please find the assessment questions attached. Read the instructions before you begin.' });
const teamsTest = mail({ fromAddr: 'hr@anklesaria.com', fromName: 'HR Ops', subject: 'ANKLESARIA Product Support Analyst - Aptitude Test Instructions',
  text: 'Microsoft Teams meeting. Join: https://teams.microsoft.com/meet/1' });
const shortlisted = mail({ fromAddr: 'india.recruitment@yottaflex.ai', fromName: 'YottaFlex AI Careers',
  subject: "Good news! You're shortlisted. Please take your online test within 24 hours",
  text: 'Congratulations! You have been shortlisted for the AI Forward Deployed Engineer role. Take the test within 24 hours of receiving this email.' });

test('assessment and test emails are found, with company, platform and deadline', () => {
  assert.deepEqual(assessmentOf(shl), { tier: 'sure', kind: 'invitation', vendor: 'SHL', company: 'Sutherland Global Services, Inc', deadline: null });
  const a = assessmentOf(adaface);
  assert.equal(a.tier, 'sure');
  assert.equal(a.kind, 'invitation'); // "your Phase 1A result" is not a result
  assert.equal(a.vendor, 'Adaface');
  assert.match(a.deadline, /within 2 business days/);
  assert.equal(assessmentOf(emailedPaper).company, 'Anklesaria');
  assert.equal(assessmentOf(teamsTest).tier, 'sure'); // no hiring words, but "aptitude test" says it
  assert.match(assessmentOf(shortlisted).deadline, /within 24 hours/);
  assert.equal(assessmentOf(mail({ fromAddr: 'contact@internshipstudio.com', subject: 'The Internship Common Test (iCAT) Result is LIVE',
    text: 'Your iCAT (Internship Common Aptitude Test) results are now available.' })).kind, 'result');
});

test('newsletters, practice-test promos, quizzes, auto-replies and school work are not assessments', () => {
  const no = [
    mail({ fromAddr: 'highlearningrate@substack.com', subject: 'Agents and benchmarks', text: 'How to take the online assessment of a model for a job role.' }),
    mail({ fromAddr: 'informationnc@naukri.com', subject: 'Become a pro at your aptitude skills', text: 'Aptitude Test helps excel in the aptitude tests used by companies during placements. Practice now.' }),
    mail({ fromAddr: 'eventnc@naukri.com', subject: 'naukri campus : Quiz is open for registration !!', text: 'AI Skill Assessment - Test your AI knowledge. Job seekers welcome.' }),
    mail({ fromAddr: 'ask.recruiting@shl.com', subject: 'Automatic reply: Reaching Out Regarding Job Opportunities', text: 'We will respond within 72 hours.' }),
    mail({ fromAddr: 'no-reply@classroom.google.com', subject: 'New assignment: "Github Repo Submission"', text: 'Submit the assignment within 2 days.' }),
    mail({ fromAddr: 'jd-rti@esic.nic.in', subject: 'RTI reply', text: 'Reply to your RTI application.', html: '<a href="https://rtionline.gov.in/x">x</a>' }),
  ];
  for (const m of no) assert.equal(assessmentOf(m), null, m.subject);
});

test('the whole mailbox is searched once, Spam and Trash too, then only new mail', async () => {
  const db = await openDb({ url: ':memory:' });
  const box = { a: { ...shl, id: 'a', threadId: 'ta', date: '2026-11-12T04:46:00.000Z', labelIds: ['SPAM'] },
    b: { ...mail({ fromAddr: 'x@substack.com', subject: 'Weekly' }), id: 'b', threadId: 'tb', date: '2026-11-11T00:00:00.000Z' } };
  const queries = [];
  const gets = [];
  const gmail = { listIds: async (q, max, o) => { queries.push([q, o]); return Object.keys(box); }, get: async (id) => { gets.push(id); return box[id]; } };
  const r = await scanAssessments(db, gmail);
  assert.deepEqual(r, { listed: 2, checked: 2, found: 1, cut: false });
  assert.doesNotMatch(queries[0][0], /after:/);
  assert.deepEqual(queries[0][1], { spamTrash: true });
  const list = await kvGet(db, 'assessments');
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].folder, 'spam');
  assert.equal(list.items[0].company, 'Sutherland Global Services, Inc');
  // Next time: only mail since the last full pass, and nothing read twice.
  await scanAssessments(db, gmail);
  assert.match(queries[1][0], /after:\d+/);
  assert.deepEqual(gets, ['a', 'b']);
});
