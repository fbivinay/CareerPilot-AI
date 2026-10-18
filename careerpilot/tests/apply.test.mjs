import test from 'node:test';
import assert from 'node:assert/strict';
import { portalHost } from '../lib/apply/workday.mjs';

test('Workday credentials are only ever used on a genuine Workday candidate portal', () => {
  assert.equal(portalHost('https://marvell.wd1.myworkdayjobs.com/marvellcareers2/job/x'), 'marvell.wd1.myworkdayjobs.com');
  for (const bad of ['https://marvell.evil.com/x', 'http://marvell.wd1.myworkdayjobs.com/x',
    'https://marvell.wd1.myworkdayjobs.com.evil.com/x', 'https://evil.com/marvell.wd1.myworkdayjobs.com']) {
    assert.throws(() => portalHost(bad), /not a Workday candidate portal/);
  }
});

test('employer questions are answered only from the profile, in the unit they ask for', async () => {
  const { answerFor, dateRange, fieldWants } = await import('../lib/apply/workday.mjs');
  const profile = { name: 'A Candidate', experience: [{ company: 'Acme Labs, Bengaluru' }] };
  const answers = { indian_work_authorization: true, needs_visa_sponsorship: false, earliest_full_time_start: '2026-11-10',
    internship_available_from: '2026-11-10', graduation_month: '2027-06', expected_ctc: 700000, expected_internship_stipend_monthly: 40000, gender: 'Male' };
  const ask = (label, kind = 'dropdown', job = { company: 'Marvell', employment_type: 'full_time' }, required = true) =>
    answerFor({ label, kind, required }, { profile, answers, job, inIndia: true });
  assert.deepEqual(ask('Do you have legal right to work in this country?'), { yes: true });
  assert.deepEqual(ask('Will you now or in the future require sponsorship?'), { yes: false });
  assert.deepEqual(ask('Have you ever worked for Marvell?'), { yes: false });
  assert.deepEqual(ask('Have you ever worked for Acme Labs?', 'dropdown', { company: 'Acme Labs', employment_type: 'full_time' }), { yes: true });
  // Unknown to the profile: never guessed.
  assert.equal(ask('Are you at least 18 years old or older?'), undefined);
  assert.equal(ask('Do you have a friend or relative employed at Marvell?'), undefined);
  assert.equal(ask('Enter your expected graduation date.', 'date'), undefined); // month known, day not
  assert.equal(ask('Signature and Date', 'textarea'), undefined);
  assert.deepEqual(ask('After graduation and if hired, when would you be able to start in a full-time role?', 'date'), { date: { year: 2026, month: 11, day: 10 } });
  // Pay in the unit the question names.
  assert.deepEqual(ask('Expected CTC (in LPA)', 'text'), { text: '7' });
  assert.deepEqual(ask('Expected CTC (in LPA)', 'text', { company: 'X', employment_type: 'internship' }), { text: '4.8' });
  assert.deepEqual(ask('Expected stipend per month', 'text', { company: 'X', employment_type: 'internship' }), { text: '40000' });
  // Consent yes, marketing never, self-identification declined.
  assert.deepEqual(ask('Yes, I have read and consent to the terms and conditions', 'checkbox'), { yes: true });
  assert.equal(ask('I agree to receive job alerts and marketing emails', 'checkbox'), undefined);
  assert.ok(ask('Veteran Status').option[0].test('I do not wish to self-identify'));
  assert.deepEqual(dateRange('May 2026 - Jun 2026'), [{ month: 5, year: 2026 }, { month: 6, year: 2026 }]);
  assert.ok(fieldWants('Big Data Analytics').test('Data Analytics') && !fieldWants('Big Data Analytics').test('Business Analytics'));
});

test('a statement is signed only when all it says is that the answers are true', async () => {
  const { answerFor } = await import('../lib/apply/workday.mjs');
  const ask = (label, kind, answers) => answerFor({ label, kind, required: true }, { profile: { name: 'A Candidate' }, answers, job: { company: 'Marvell' } });
  const marvell = 'I understand that Marvell reserves the right to inquire further on any matter bearing on the company’s export compliance obligations. I certify that the foregoing answers are true and correct to the best of my knowledge and belief. Signature and Date';
  assert.match(ask(marvell, 'textarea', { may_e_sign: true }).text, /^A Candidate, \d{1,2} \w+ \d{4}$/);
  assert.equal(ask(marvell, 'textarea', {}), undefined);
  assert.equal(ask(marvell, 'checkbox', { may_e_sign: true }), undefined); // never ticked or answered "yes"
  assert.deepEqual(ask('Attestation: I hereby attest that all information I have provided is true and complete.', 'text', { may_e_sign: true }), { text: 'A Candidate' });
  // Anything more than that is the candidate's to approve; so is a bare signature box, which shows nothing to read.
  const promise = 'Attestation and acknowledgement statement By signing below, I hereby: Attest that all information I have provided in conjunction with this employment application is true and complete. Attest that I will not bring confidential information from a former employer.';
  assert.equal(ask(promise, 'text', { may_e_sign: true }), undefined);
  assert.equal(ask('By signing below, I certify that I have never worked for Marvell.', 'text', { may_e_sign: true }), undefined);
  assert.equal(ask('Signature', 'text', { may_e_sign: true }), undefined);
});

test('a past tie to the employer is "no" only when every tie the question names is known to be "no"', async () => {
  const { answerFor } = await import('../lib/apply/workday.mjs');
  const profile = { name: 'A Candidate', experience: [{ company: 'Acme Labs, Bengaluru' }] };
  const ask = (label, answers, company = 'Marvell') => answerFor({ label, kind: 'dropdown', required: true }, { profile, answers, job: { company } });
  const worked = 'Have you ever worked for Marvell (as an Employee, Intern or Contractor)?';
  assert.equal(ask(worked, {}), undefined); // a contract need not be in the work history
  assert.deepEqual(ask(worked, { prior_relationship_with_employer: false }), { yes: false });
  assert.deepEqual(ask('Have you ever worked for Acme Labs as an employee, contractor or consultant?', { prior_relationship_with_employer: false }, 'Acme Labs'), { yes: true });
  assert.deepEqual(ask('Have you held any independent contractor or consultant roles with Marvell?', { prior_relationship_with_employer: true }), { yes: true });
  assert.equal(ask('Have you previously interviewed with or worked for Marvell?', { prior_relationship_with_employer: false }), undefined);
  assert.deepEqual(ask('Have you previously interviewed with or worked for Marvell?', { previously_interviewed: false }), { yes: false });
  assert.deepEqual(ask('Have you previously interviewed with or worked for Acme Labs?', { previously_interviewed: false }, 'Acme Labs'), { yes: true });
  assert.deepEqual(ask('Do you have a relative employed at Marvell?', { relatives_at_employer: false }), { yes: false });
});

test('questions answered by deriving from the profile, and opt-ins declined', async () => {
  const { answerFor } = await import('../lib/apply/workday.mjs');
  const profile = { name: 'A Candidate', education: [{ degree: 'MSc in Data', institution: 'Some University', dates: 'Aug 2025 - Jun 2099' }],
    experience: [{ company: 'Acme', dates: 'May 2026 - Jun 2026' }, { company: 'Beta', dates: 'May 2024 - Jun 2024' }] };
  const answers = { citizenship: 'India', earliest_joining_date: '2026-11-10', relatives_at_employer: false };
  const ask = (label, kind = 'dropdown') => answerFor({ label, kind, required: true }, { profile, answers, job: { company: 'Northern Trust' } });
  assert.deepEqual(ask('Do you hold an OCI/PIO card?'), { yes: false });
  assert.deepEqual(ask('Have you ever been an employee of either Northern Trust or any affiliates of Northern Trust?'), { yes: false });
  assert.deepEqual(ask('Do you currently have a personal relationship (including marital or other committed relationship) with a Northern Trust employee?'), { yes: false });
  assert.deepEqual(ask('Any relation working with Synechron?'), { yes: false });
  assert.deepEqual(answerFor({ label: 'Have you participated in any Airbus interviews before ?', kind: 'radio', required: true },
    { profile, answers: { ...answers, previously_interviewed: false }, job: { company: 'Ag' } }), { yes: false });
  assert.ok(ask('Primary Nationality').option.some((re) => re.test('India')));
  assert.equal(ask('How many years of Relevant Experience do you have?', 'text').text, '0'); // two 2-month internships
  assert.equal(ask('How many years of experience do you have with Python?', 'text'), undefined);
  assert.deepEqual(ask('How soon you can join us?', 'text'), { text: 'From 10 November 2026' });
  assert.deepEqual(ask('What is your highest education and in which stream?', 'text'), { text: 'MSc in Data, Some University (pursuing)' });
  assert.equal(ask('Do you require Northern Trust to make reasonable adjustments in order to participate in the recruiting process?'), undefined);
  const decline = ask('I consent to receive communication, including electronic communication, from entities within the PwC network about job related events');
  assert.ok(decline.option[0].test('No') && !decline.option[0].test('Yes'));
  assert.equal(ask('I agree to have my personal data processed by PwC for the purpose of recruitment for other positions than the one I have initially applied for', 'radio'), undefined);
});

test('restrictions, consents and pay questions follow the standing answers', async () => {
  const { answerFor } = await import('../lib/apply/workday.mjs');
  const answers = { restrictive_covenants: false, employment_restrictions: false, government_official: false, allow_ai_screening: true,
    consider_for_other_roles: true, date_of_birth: '2003-05-14', earliest_joining_date: '2099-01-31', expected_ctc: 700000, industry_specialization: 'Data analytics and AI' };
  const profile = { name: 'A Candidate', experience: [] };
  const ask = (label, kind = 'dropdown', job = { company: 'PwC', description: 'Python and SQL.' }, a = answers) => answerFor({ label, kind, required: true }, { profile, answers: a, job, appliedHere: false });
  assert.deepEqual(ask('Are you subject to a non-competition or other agreement, or aware of other circumstances, that would preclude or restrict your employment with PwC? If yes, describe the conditions.', 'textarea'), { yes: false });
  assert.equal(ask('Are you subject to a non-competition or other agreement, or aware of other circumstances, that would preclude your employment?', 'textarea', undefined, { restrictive_covenants: false }), undefined);
  assert.deepEqual(ask('Do you have any commitments / bond with previous employer?'), { yes: false });
  assert.deepEqual(ask('Are you currently or have you been in the last five years serving as a government official, either domestic or foreign?'), { yes: false });
  assert.equal(ask('Are you related to a government official, either domestic or foreign?'), undefined); // a different fact
  assert.deepEqual(ask('Please select your date of birth:', 'date'), { date: { year: 2003, month: 5, day: 14 } });
  assert.deepEqual(ask('Do you permit Labcorp to process your data to consider you for future job openings using Artificial Intelligence (AI) tools ?'), { yes: true });
  assert.deepEqual(ask('I agree to have my personal data processed by PwC for the purpose of recruitment for other positions than the one I have initially applied for'), { yes: true });
  assert.deepEqual(ask('Have you ever applied, interviewed, received an offer, or been employed with PwC or its predecessor firms? If yes, please provide firm name.', 'textarea', undefined, { ...answers, previously_interviewed: false }), { yes: false });
  assert.deepEqual(ask('Are you currently working, or have you worked, as third party labor or an independent contractor to PwC?', 'dropdown', undefined, { ...answers, prior_relationship_with_employer: false }), { yes: false });
  assert.deepEqual(ask('What are your salary expectations? (Per Annum)', 'text'), { text: '700000' });
  assert.ok(ask('Currency (Salary Expectations)').option[0].test('INR'));
  assert.ok(ask('Do you hold the professional certifications and/or clearance as outlined in the job description?').option.some((re) => re.test('Yes')));
  assert.equal(ask('Do you hold the professional certifications and/or clearance as outlined in the job description?', 'dropdown', { company: 'X', description: 'AWS certification required.' }), undefined);
  assert.ok(ask('What Industry do you specialize in ?').option[0].test('Data & Analytics'));
  const in45days = new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10);
  const soon = ask('How soon you can join us?', 'dropdown', undefined, { earliest_joining_date: in45days }).option[0];
  assert.ok(soon.test('Within 60 days') && soon.test('1-2 months') && !soon.test('Within 30 days') && !soon.test('Immediately'));
});

test('internship questions use the standing answers, with the options the form offers', async () => {
  const { answerFor } = await import('../lib/apply/workday.mjs');
  const answers = { academic_stage_at_internship: 'Final year', can_provide_noc: true, available_in_person: true, higher_education_plans: false,
    active_backlogs: 0, industry_specialization: 'Data analytics and AI' };
  const ask = (label) => answerFor({ label, kind: 'dropdown', required: true }, { profile: { name: 'A' }, answers, job: { company: 'Airbus' } });
  const pick = (label, options) => options.find((o) => ask(label).option.some((re) => re.test(o)));
  assert.equal(pick('At the start of your internship, where will you be in your academic journey?', ['Final year', 'Pre-Final year', 'Already graduated']), 'Final year');
  assert.deepEqual(ask('Can you provide a mandatory NOC [No objection certificate] from your college/university for the entire duration of this internship?'), { yes: true });
  assert.deepEqual(ask('Are you available to complete this internship in-person for the full duration as specified in the Job Description (JD)?'), { yes: true });
  assert.deepEqual(ask('Do you have plans to pursue higher education?'), { yes: false });
  assert.equal(pick('Do you have any active backlogs in your current degree program?', ['1 active backlog', 'No active backlogs']), 'No active backlogs');
  assert.equal(pick('What Industry do you specialize in ?', ['Healthcare', 'Medtech', 'Automotive', 'Manufacturing', 'Others']), 'Others');
});

test('an open question is drafted from the job and profile only; a draft with an unknown number is dropped', async () => {
  const { openDb } = await import('../lib/db.mjs');
  const { draftAnswer } = await import('../lib/compose.mjs');
  const db = await openDb({ url: ':memory:' });
  const reply = (answer) => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer }) } }] }), { status: 200 });
  const profile = { name: 'A', headline: 'MSc student', education: [], experience: [], projects: [], skills: { languages: ['Python'] } };
  const job = { title: 'AI Engineer', company: 'Acme', description: 'Build GenAI systems with Python.' };
  const ask = (answer, question) => draftAnswer(db, { profile, job, question }, undefined, { env: { GROQ_API_KEY: 'g' }, fetchImpl: reply(answer) });
  assert.equal(await ask('Acme builds GenAI systems, and I work in Python.', 'Top 3 reasons to join us.'), 'Acme builds GenAI systems, and I work in Python.');
  assert.equal(await ask('I have 5 years of Python experience.', 'Why Acme?'), null);
  assert.equal(await ask(null, 'Why do you want to join?'), null);
});

test('blocking questions are counted across applications, most blocking first', async () => {
  const { blockingQuestions } = await import('../lib/queries.mjs');
  assert.deepEqual(blockingQuestions([
    'Needs your answer: "Are you at least 18 years old?"; "Do you have a relative at Acme?"',
    'No verified answer for: Address Line 1; Postal Code',
    'No verified match for: Field of study for MSc in Big Data Analytics (offered: Data Mining, Data Science)',
    'Needs your answer: "Are you at least 18 years old?"',
    'Missing answers: earliest_full_time_start', // the prepare stage's own reason: not an employer question
  ]).map((q) => [q.question, q.applications]), [
    ['Are you at least 18 years old?', 2], ['Do you have a relative at Acme?', 1], ['Address Line 1', 1], ['Postal Code', 1],
    ['Field of study for MSc in Big Data Analytics', 1],
  ]);
});
