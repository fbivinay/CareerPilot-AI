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
  assert.equal(ask('Expected CTC (in LPA)', 'text').text, '7');
  assert.equal(ask('Expected CTC (in LPA)', 'text', { company: 'X', employment_type: 'internship' }).text, '4.8');
  assert.equal(ask('Expected stipend per month', 'text', { company: 'X', employment_type: 'internship' }).text, '40000');
  // A list of pay ranges: the range the figure falls in (Light & Wonder).
  const ranges = ['Up to INR 6,00,000', 'INR 6,00,000 - INR10,00,000', 'INR 10,00,000 - INR 20,00,000', 'INR 50,00,000 - above'];
  assert.deepEqual(ranges.filter((o) => ask('What is your desired base salary?').option[0].test(o)), ['INR 6,00,000 - INR10,00,000']);
  // Past ties named in the question, and required acknowledgements.
  assert.equal(ask('If your desired pay rate is higher than the amount the position pays, do you still want to be considered for the position?'), undefined);
  assert.deepEqual(answerFor({ label: 'If your desired pay rate is higher than the amount the position pays, do you still want to be considered for the position?', kind: 'dropdown', required: true },
    { profile, answers: { ...answers, consider_if_pay_below_expectation: true }, job: { company: 'Lnw' }, inIndia: true }), { yes: true });
  assert.deepEqual(ask('Did you work for KPMG?'), { yes: false });
  assert.deepEqual(ask('Do you require a visa to work in the country where this role is based?'), { yes: false });
  const permit = answerFor({ label: 'Do you possess a valid residency permit in the country for which the position resides?', kind: 'dropdown', required: true },
    { profile, answers: { citizenship: 'India' }, job: { company: 'Hpe' }, inIndia: true });
  // Preference order, as the engine's best() applies it.
  const first = (wants, options) => { for (const re of wants) { const o = options.find((t) => re.test(t)); if (o) return o; } return null; };
  assert.equal(first(permit.option, ['Yes', 'No', 'Not Applicable']), 'Not Applicable');
  assert.equal(first(permit.option, ['Yes', 'No']), 'Yes');
  assert.ok(answerFor({ label: 'What is your Primary Nationality?', kind: 'prompt', required: true }, { profile, answers: { citizenship: 'India' }, job: { company: 'Rbs' } }).option[0].test('India'));
  assert.deepEqual(ask('Ticking in confirmation of reception and reading the privacy notice.', 'checkbox'), { yes: true });
  assert.deepEqual(answerFor({ label: 'Visa may use automated tools such as AI to support review of your application for this role, and if applicable, match you with relevant existing and future open roles.', kind: 'dropdown', required: true },
    { profile, answers: { allow_ai_screening: true, consider_for_other_roles: true }, job: { company: 'Visa' } }), { yes: true });
  assert.deepEqual(answerFor({ label: 'Do you have an Indian nationality?', kind: 'radio', required: true }, { profile, answers: { citizenship: 'India' }, job: { company: 'Rbs' } }), { yes: true });
  assert.deepEqual(answerFor({ label: 'Are you a US citizen?', kind: 'radio', required: true }, { profile, answers: { citizenship: 'India' }, job: { company: 'X' } }), { yes: false });
  assert.deepEqual(ask('Have you been made redundant by NatWest Group or any of its subsidiary companies within the last 12 months?'), { yes: false });
  assert.deepEqual(ask('Have you previously had your employment terminated for misconduct by NatWest Group or any of its subsidiary companies?'), { yes: false });
  assert.ok(ask('Do you hold the professional certifications and/or clearance as outlined in the job description?', 'dropdown',
    { company: 'Pwc', description: 'Certifications (if blank, certifications not specified) Required Skills Python. Government Clearance Required? No' }).option.some((re) => re.test('Not Applicable')));
  assert.deepEqual(ask('Have you worked for Haleon in the past?'), { yes: false });
  assert.deepEqual(ask('Have you worked for Acme Labs in the past?'), { yes: true });
  assert.deepEqual(ask('I have read the Privacy Notice', 'checkbox'), { yes: true });
  assert.deepEqual(ask('I acknowledge that I have read and understand how my information will be processed.', 'checkbox'), { yes: true });
  assert.deepEqual(ask('Logitech uses an automated scheduling system to support you during the recruitment process. Your consent is required to proceed.'), { yes: true });
  // Consent yes, marketing never, self-identification declined.
  assert.deepEqual(ask('Yes, I have read and consent to the terms and conditions', 'checkbox'), { yes: true });
  assert.equal(ask('I agree to receive job alerts and marketing emails', 'checkbox'), undefined);
  assert.ok(ask('Veteran Status').option[0].test('I do not wish to self-identify'));
  assert.deepEqual(dateRange('May 2026 - Jun 2026'), [{ month: 5, year: 2026 }, { month: 6, year: 2026 }]);
  assert.ok(fieldWants('Big Data Analytics').test('Data Analytics') && !fieldWants('Big Data Analytics').test('Business Analytics'));
  assert.ok(fieldWants('Statistics & Economics').test('Statistics, General') && !fieldWants('Statistics & Economics').test('Agricultural Economics'));
  assert.ok(!fieldWants('Statistics & Economics').test('General'));
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
  // Accuracy plus its consequences, as a yes/no, with the standing permission (Haleon); nothing more.
  const haleon = 'I acknowledge that my responses are accurate and complete. I acknowledge that if I make an inaccurate or incomplete representation then I will be ineligible to be considered for employment and, if inaccuracy or incompleteness is discovered after an offer is extended to me or accepted, then I may have disciplinary consequences up to and including separation of employment in accordance with local policies, procedures, or laws.';
  assert.deepEqual(ask(haleon, 'dropdown', { may_certify_accuracy: true }), { yes: true });
  assert.equal(ask(haleon, 'dropdown', {}), undefined);
  assert.equal(ask(`${haleon} I agree to resolve any dispute by binding arbitration.`, 'dropdown', { may_certify_accuracy: true }), undefined);
  assert.equal(ask('I acknowledge that my responses are accurate and complete. I acknowledge that if they are incomplete, I waive any claim and my offer may be terminated.', 'checkbox', { may_certify_accuracy: true }), undefined);
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
  const checks = { willing_background_check: true, willing_medical_check: true, medical_history_to_declare: false, ongoing_court_cases: false,
    disability_affects_job: false, willing_cet_shift: true };
  const ask2 = (label) => answerFor({ label, kind: 'dropdown', required: true }, { profile, answers: checks, job: { company: 'Synechron' } });
  assert.deepEqual(ask2('Are you willing to undergo a background check as part of this hiring process? "BGV is a mandatory requirement"'), { yes: true });
  assert.deepEqual(ask2('Are you willing to undergo medical check as part of this hiring process?'), { yes: true });
  assert.deepEqual(ask2('Do you have any medical History that needs to be informed prior?'), { yes: false });
  assert.deepEqual(ask2('Do you have any ongoing court cases?'), { yes: false });
  assert.deepEqual(ask2('Do you have a disability that would interfere with your ability to perform this job?'), { yes: false });
  assert.deepEqual(ask2('Are you willing to work in Central European Time shift hours ?'), { yes: true });
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
  const coi = 'HPE Policy prohibits employees from engaging in activities that pose a conflict(s) of interest for HPE such as: Outside employment with or receiving compensation from a customer, business partner, supplier, or competitor; Significant financial interest in a customer held by you or a family member; Close personal relationships between employees in the same organization. Please advise if you would be engaging in any of the above.';
  assert.equal(ask(coi), undefined); // not covered by the relatives or past-ties answers
  assert.deepEqual(answerFor({ label: coi, kind: 'dropdown', required: true }, { profile, answers: { conflicts_of_interest: false }, job: { company: 'Hpe' } }), { yes: false });
  assert.deepEqual(ask('Please select your date of birth:', 'date'), { date: { year: 2003, month: 5, day: 14 } });
  assert.deepEqual(ask('Do you permit Labcorp to process your data to consider you for future job openings using Artificial Intelligence (AI) tools ?'), { yes: true });
  assert.deepEqual(ask('I agree to have my personal data processed by PwC for the purpose of recruitment for other positions than the one I have initially applied for'), { yes: true });
  assert.deepEqual(ask('Have you ever applied, interviewed, received an offer, or been employed with PwC or its predecessor firms? If yes, please provide firm name.', 'textarea', undefined, { ...answers, previously_interviewed: false }), { yes: false });
  assert.deepEqual(ask('Are you currently working, or have you worked, as third party labor or an independent contractor to PwC?', 'dropdown', undefined, { ...answers, prior_relationship_with_employer: false }), { yes: false });
  assert.equal(ask('What are your salary expectations? (Per Annum)', 'text').text, '700000');
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
  // Mactores (Lever), with the answers given on 2026-10-18; unknown until given.
  assert.equal(ask('Whats the duration of the internship are you looking for?'), undefined);
  Object.assign(answers, { internship_min_months: 6, full_time_after_internship: true, internship_hours_per_day: 8, willing_to_take_tests: true });
  assert.equal(pick('Whats the duration of the internship are you looking for?', ['3 Months', '4 to 6 Months', '6 Months and Above']), '6 Months and Above');
  assert.equal(pick('Whats the duration of the internship are you looking for?', ['Less than 6 months', '6-12 months']), '6-12 months');
  assert.deepEqual(ask('Are you looking for a full time role immediately after the internship?'), { yes: true });
  assert.equal(pick('How many hours per day are you available for internship', ['4 hours (Half day)', '8 hours (Full Day)']), '8 hours (Full Day)');
  assert.deepEqual(ask('As part of the hiring process, as the first step, Mactores conducts Aptitude Test and relevant Technical Test for your Job Role. These tests help us reduce our time to decisions and help you analyze your skills and expertise. Please confirm if you will be willing to take these tests before the initial interview?'), { yes: true });
});

test('an account is verified only from Workday mail or the employer’s own domain', async () => {
  const { verificationSender } = await import('../lib/apply/workday.mjs');
  const host = 'barclays.wd3.myworkdayjobs.com';
  assert.ok(verificationSender('barclays.com', host));
  assert.ok(verificationSender('otp.workday.com', host));
  assert.ok(verificationSender('mail.barclays.com', host));
  assert.ok(!verificationSender('barclays.com.evil.io', host));
  assert.ok(!verificationSender('notbarclays.com', host));
  assert.ok(!verificationSender('hpe.com', host));
  assert.ok(verificationSender('transunionapps.com', 'transunion.wd5.myworkdayjobs.com'));
  assert.ok(verificationSender('ag.com', 'ag.wd3.myworkdayjobs.com') && !verificationSender('agency.com', 'ag.wd3.myworkdayjobs.com'));
});

test('AllianceBernstein, Amgen and Ashby questions follow the standing answers', async () => {
  const { answerFor, best, degreeWants } = await import('../lib/apply/workday.mjs');
  const profile = { name: 'A Candidate', experience: [{ company: 'Acme, Bengaluru', dates: 'May 2026 - Jun 2026' }],
    education: [{ degree: 'MSc in Big Data Analytics', dates: 'Aug 2025 - Jun 2099' }, { degree: 'BSc in Statistics', dates: 'Aug 2022 - Jun 2025' }] };
  const answers = { relatives_at_employer: false, citizenship: 'India', career_break: false, current_ctc: 0, expected_ctc: 700000,
    reason_for_leaving_last_role: 'Internship completed', regulatory_licensed_role: false, referred_at: [] };
  const ask = (label, kind = 'dropdown') => answerFor({ label, kind, required: true },
    { profile, answers, job: { company: 'AllianceBernstein', employment_type: 'full_time' }, inIndia: true, appliedHere: false });
  assert.deepEqual(ask('Do you have any relatives, either directly or through marriage, that work at AllianceBernstein?'), { yes: false });
  assert.deepEqual(ask('Are you a citizen or lawful resident of the country where the role you are applying for is located?'), { yes: true });
  assert.equal(ask('Reason for leaving', 'textarea').text, 'Internship completed');
  assert.equal(ask('Responsibilities for current job duties', 'textarea').text, 'Not applicable: I am not currently employed (MSc student).');
  assert.equal(ask('Explain any gaps in employment (Do not include absences due to illness, injury, or other disability)', 'textarea').text,
    'No gaps: I have been studying continuously (BSc, then MSc).');
  assert.deepEqual(ask('Have you within the past three years been a licensed representative or responsible officer of any regulatory body?'), { yes: false });
  assert.equal(ask('Expected Annual Salary Package', 'textarea').text, 'INR 700000');
  assert.equal(ask('Current Annual Salary Package', 'textarea').text, 'INR 0');
  assert.equal(ask('Expected Annual Salary Package', 'text').text, '700000'); // a number box keeps only digits
  assert.deepEqual(ask('Did you get recommended by someone we know? (recommendations are the best)', 'radio'), { yes: false });
  assert.equal(ask('Referred by (employee name)', 'text'), undefined);
  const bms = 'Please acknowledge that the name and address you provide in your application matches exactly with the name on your Aadhaar card. If it doesn\'t, please go back to the My Information section to correct it.';
  assert.equal(ask(bms), undefined);
  answers.details_match_aadhaar = true;
  assert.deepEqual(ask(bms), { yes: true });
  // CNX's questions for someone in a job, to a candidate with none.
  assert.deepEqual(ask('Have you notified your current manager in writing of your intent to apply for this position?'), { yes: false });
  assert.deepEqual(ask('Are you on a Performance Improvement Plan (PIP)?'), { yes: false });
  // Barclays' local-script address copy.
  const local = (label) => answerFor({ label, kind: 'text', required: true }, { profile: { ...profile, location: 'Bengaluru, Karnataka' },
    answers: { address_line1: 'Central Street', legal_given_name: 'R Vinay', legal_family_name: 'Kumar' }, job: { company: 'Barclays' }, inIndia: true });
  assert.equal(local('Local Given Name(s)').text, 'R Vinay');
  assert.equal(answerFor({ label: 'Building', kind: 'text', required: true }, { profile, answers: { address_building: 'SV PG' }, job: { company: 'X' } }).text, 'SV PG');
  assert.equal(answerFor({ label: 'Street Number', kind: 'text', required: true }, { profile, answers: { address_street_number: '23' }, job: { company: 'X' } }).text, '23');
  assert.equal(answerFor({ label: 'What is the legal full name of your father?', kind: 'text', required: true }, { profile, answers: { father_full_name: 'A B' }, job: { company: 'X' } }).text, 'A B');
  assert.equal(local('Local Family Name').text, 'Kumar');
  assert.equal(local('Address Line 1 - Local').text, 'Central Street');
  assert.equal(local('City - Local').text, 'Bengaluru');
  assert.equal(local('Current location').text, 'Bengaluru, Karnataka');
  const amgen = ['Other', 'High School Degree / Diploma / A-Levels / GED', 'Bachelor’s / Undergraduate Degree (3-4 year degree equivalent e.g., BA, BS, LLB, etc.)',
    'Master’s / Graduate Degree (1-2 year degree equivalent, e.g., MA, MS, MBA, etc.)'];
  assert.equal(best(amgen, degreeWants('MSc in Big Data Analytics')), 3);
  assert.equal(best(amgen, degreeWants('BSc in Statistics')), 2);
});

test('Barclays, Mastercard, Maersk, ICF, US Bank, Mobility, PwC and RELX questions', async () => {
  const { answerFor, best, degreeWants } = await import('../lib/apply/workday.mjs');
  const profile = { name: 'A Candidate', experience: [{ company: 'Acme Labs, Bengaluru', dates: 'May 2026 - Jun 2026' }] };
  const answers = { relatives_at_employer: false, prior_relationship_with_employer: false, needs_accommodation: false, willing_background_check: true,
    criminal_record: false, regulatory_investigation: false, dismissed_for_misconduct: false, related_to_stakeholder: false, current_ctc: 0,
    notice_period: 0, work_arrangements: ['Onsite', 'Hybrid', 'Remote'], applied_before: [] };
  const ask = (label, kind = 'dropdown', company = 'Barclays') => answerFor({ label, kind, required: true },
    { profile, answers, job: { company }, inIndia: true, appliedHere: false });
  const pick = (label, options, kind) => options.filter((o) => (ask(label, kind).option ?? []).some((re) => re.test(o)));
  assert.deepEqual(ask('Have you been employed within the last 24 months by the Barclays Group Statutory Auditor, KPMG? (Please do not include insights programmes, or internships unless working specifically on the Barclays account)'), { yes: false });
  assert.deepEqual(ask('Barclays welcomes applications from all candidates and is committed to ensuring its recruitment processes are fair and inclusive. Please indicate if you require an adjustment (accommodation) at any time during the recruitment process. Please note there is no requirement to disclose any medical information as part of this process.'), { yes: false });
  assert.deepEqual(ask('Do you have any criminal convictions, cautions, reprimands or final warnings (including traffic offences) in any country?'), { yes: false });
  assert.deepEqual(ask('Have you ever been subject to investigation by or disciplined/cautioned by a regulatory body?'), { yes: false });
  assert.deepEqual(ask('Have you ever been dismissed by a previous employer(s) for gross misconduct or as part of disciplinary action?'), { yes: false });
  assert.deepEqual(ask('If your application is successful Barclays undertakes people screening as part of its recruitment process, these include; criminal records, address verification, academic qualifications, employment dates and employer references — are you happy to continue with your application?'), { yes: true });
  assert.deepEqual(ask('To the best of your knowledge and understanding, are you related to a Barclays Stakeholder? (Please note that a Barclays employee is not considered a Barclays Stakeholder)'), { yes: false });
  // The same question as the form reads it, with its explanation, which mentions screening (it was once "Yes").
  assert.deepEqual(ask('Connected Persons: As part of our pre-employment screening process, we may need to understand if you are related to a Barclays Stakeholder.* This is so that we can identify and manage any potential conflicts of interest. Barclays Stakeholders are typically senior decision-makers at client firms, our suppliers, our regulators or individuals defined as Politically Exposed Persons (PEPs), such as government ministers and senior civil servants. To the best of your knowledge and understanding, are you related to a Barclays Stakeholder? (Please note that a Barclays employee is not considered a Barclays Stakeholder)'), { yes: false });
  assert.equal(answerFor({ label: 'Are you related to a Barclays Stakeholder?', kind: 'dropdown', required: true },
    { profile, answers: { relatives_at_employer: false }, job: { company: 'Barclays' }, inIndia: true }), undefined); // not the relatives answer
  assert.deepEqual(ask('In your current role, do you engage with Mastercard employees to negotiate, influence and/or sign commercial contracts or government contracts?'), { yes: false });
  assert.deepEqual(ask('Are you or were you recently (in the last six months) an employee of a government office or agency that has oversight of Mastercard?'), { yes: false });
  assert.deepEqual(ask('Have you applied to A.P. Moller Maersk Group before?', 'dropdown', 'Maersk'), { yes: false });
  assert.deepEqual(ask('Have you ever been a previous ICF Independent Consultant?', 'dropdown', 'ICF'), { yes: false });
  assert.deepEqual(ask('Do you have an immediate family relationship (parent, grandparent, child, sibling, first cousin, aunt/uncle, niece/nephew, spouse, brother or sister, in law or step) with anyone who may be in the same reporting structure of the position for which you have applied?', 'dropdown', 'US Bank'), { yes: false });
  assert.deepEqual(pick('What is your notice period?', ['Less than 30 days', '30 to 59 days', '60 to 89 days', '90 or more days']).slice(0, 1), ['Less than 30 days']);
  assert.deepEqual(pick('What types of schedules you are willing to work?', ['Onsite/In-Office', 'Hybrid', 'Fully Remote'], 'checkbox'), ['Onsite/In-Office', 'Hybrid', 'Fully Remote']);
  assert.deepEqual(ask('I am aware that I am expected to work in India, even if I am deployed on a project which has flexibility to work from home', 'dropdown', 'PwC'), { yes: true });
  assert.deepEqual(ask('By checking this box you consent to sharing information with AllianceBernstein.', 'checkbox', 'Abglobal'), { yes: true });
  assert.equal(ask('I consent to sharing my information with third parties and partners.', 'checkbox', 'Abglobal'), undefined);
  // A school's careers portal is not the employer's own site.
  const heard = ask('How did you hear about this job?', 'dropdown', 'AllianceBernstein').option;
  assert.equal(best(["School's Career Portal (i.e. Handshake/Symplicity)", 'Careers Page', 'Other'], heard), 1);
  assert.equal(best(["School's Career Portal (i.e. Handshake/Symplicity)", 'Other'], heard), 1);
  Object.assign(answers, { age_18_or_older: true, has_aadhaar_card: true, has_pan_card: true, will_not_use_others_confidential_info: true, outside_employment_to_continue: false });
  assert.deepEqual(ask('Are you currently engaged in any outside employment or activity that you would like to continue if you are hired by Mastercard?', 'dropdown', 'Mastercard'), { yes: false });
  Object.assign(answers, { restrictive_covenants: false, employment_restrictions: false, willing_to_relocate: true });
  assert.deepEqual(ask('Are you willing to work from the location(s) posted on this job?', 'dropdown', 'US Bank'), { yes: true });
  assert.deepEqual(ask('Do you have any commitments or agreements with other employers that might affect your employment with RELX, Inc. or any of its subsidiaries (LexisNexis, Elsevier, Reed Exhibitions, Reed Business, Risk Solutions)?', 'dropdown', 'RELX'), { yes: false });
  assert.deepEqual(ask('Please confirm if you have a valid Aadhar card.', 'dropdown', 'Maersk'), { yes: true });
  assert.deepEqual(ask('Please confirm if you have a valid PAN card.', 'dropdown', 'Maersk'), { yes: true });
  assert.deepEqual(ask('I confirm that I am 18+ years of age', 'dropdown', 'Maersk'), { yes: true });
  assert.deepEqual(ask('I agree that I will not disclose or use, while interviewing with or employed with GE Vernova and GE Vernova’s affiliate businesses, any confidential or proprietary information of others, including any former employer.', 'dropdown', 'GE Vernova'), { yes: true });
  // Fractal, Maersk, TransUnion and GE Vernova, with the answers of 2026-10-18.
  Object.assign(answers, { citizenship: 'India', highest_qualification_reg_no: 'X123', education_type: 'Masters', highest_institution_state: 'Karnataka',
    highest_institution_country: 'India', fractal_av_certificates: false, retain_profile_for_other_roles: true, previously_interviewed: false });
  const fr = (label, options) => options.filter((o) => (ask(label, 'dropdown', 'Fractal').option ?? []).some((re) => re.test(o)));
  assert.equal(ask('Enter the Roll number/ Seat Number / Registration Number of your Highest Education Qualification', 'textarea', 'Fractal').text, 'X123');
  assert.deepEqual(fr('Type of Education', ['Bachelors', 'Masters', 'Ph.D']), ['Masters']);
  assert.deepEqual(fr('The Institution where you completed your highest education qualification is located in which State?', ['Assam', 'Karnataka']), ['Karnataka']);
  assert.deepEqual(fr('The Institution where you completed your highest education qualification is located in which Country?', ['India', 'Nepal']), ['India']);
  assert.deepEqual(ask('Are you comfortable working from office or at client location?', 'dropdown', 'Fractal'), { yes: true });
  assert.deepEqual(ask('Have you undergone any prior evaluation at Fractal or any of its entities in the form of test / interview (online or offline) in the last 6 months ?', 'dropdown', 'Fractal'), { yes: false });
  assert.deepEqual(ask('Please select "Yes" or "No" to indicate whether you have completed Fractal Data Science Professional Certificate. If the answer is yes, please attach the certificate.', 'dropdown', 'Fractal'), { yes: false });
  const role = answerFor({ label: 'Please select the role you are applying for', kind: 'dropdown', required: true },
    { profile, answers, job: { company: 'Fractal', title: 'Data Scientist (Computer Vision)' }, inIndia: true });
  assert.equal(best(['Data Engineer', 'Data Scientist', 'ML Engineer'], role.option), 1);
  assert.equal(best(['Indian Citizen', 'US Citizen', 'Foreign National'], ask('Please specify your Citizenship Status', 'dropdown', 'Maersk').option), 0);
  const notice = ask('Do you need to provide a notice period to your current employer?', 'dropdown', 'TransUnion');
  assert.equal(best(['Yes', 'No'], notice.option), 1);
  assert.equal(best(['Yes', 'No', 'Not Applicable, I am a Fresher'], ask('Are you serving Notice Period?', 'dropdown', 'Fractal').option), 2);
  assert.deepEqual(ask('In addition to the role you are applying for, do you consent to GE Vernova retaining your Candidate profile to assess your suitability for roles for which you may not have applied, and to contact you by email about job opportunities?', 'dropdown', 'GE Vernova'), { yes: true });
  // A number that names the qualification is not the qualification.
  assert.equal(answerFor({ label: 'Enter the Roll number/ Seat Number / Registration Number of your Highest Education Qualification', kind: 'textarea', required: true },
    { profile: { name: 'A', education: [{ degree: 'MSc in X', institution: 'Y', dates: 'Aug 2025 - Jun 2099' }] }, answers: {}, job: { company: 'Fractal' } }), undefined);
  const relx = ['Bachelor’s Degree or Equivalent Degree', "Associate's Degree or 2-year Equivalent Degree", 'Master’s Degree or Equivalent Degree', 'Master’s in Business Administration (MBA)'];
  assert.equal(best(relx, degreeWants('MSc in Big Data Analytics')), 2);
  assert.equal(best(relx, degreeWants('BSc in Statistics')), 0);
  const msd = ['High School Graduate or Equiv', "Bachelor Degree/Int'l Equiv", "Master Degree/Int'l Equiv", 'Master of Business Administration - MBA'];
  assert.equal(best(msd, degreeWants('MSc in Big Data Analytics')), 2);
  assert.equal(best(msd, degreeWants('BSc in Statistics')), 1);
});

test('the answer pack names a current company only for a job still going', async () => {
  const { answerPack } = await import('../lib/prepare.mjs');
  const company = (dates) => answerPack({ name: 'A Candidate', experience: [{ company: 'Acme Labs, Bengaluru', dates }] }, {}).fields.current_company;
  assert.equal(company('May 2026 - Jun 2026'), undefined); // a finished internship
  assert.equal(company('May 2026 - Present'), 'Acme Labs');
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

test('a degree is matched to its own entry or its level’s bucket, never to another degree at that level', async () => {
  const { degreeWants } = await import('../lib/apply/workday.mjs');
  const pick = (degree, options) => { for (const re of degreeWants(degree)) { const o = options.find((t) => re.test(t.replace(/’/g, "'"))); if (o) return o; } return null; };
  const visa = ['Bachelor’s or Equivalent First-Degree (ISCED 6: BA, BSc, BEng, LLB, etc.)', 'Master of Business Administration - MBA ( (ISCED 7)',
    'Master’s or Equivalent Second-Degree (ISCED 7: MA, MSc, MEng, MPhil, professional licentiate)'];
  assert.equal(pick('MSc in Big Data Analytics', visa), visa[2]);
  assert.equal(pick('BSc in Statistics & Economics', visa), visa[0]);
  assert.equal(pick('MSc in Big Data Analytics', ['Master of Business Administration', 'Master of Arts']), null);
  assert.equal(pick('BSc in Statistics & Economics', ['Bachelor of Arts', 'Bachelor of Commerce']), null);
  assert.equal(pick('MSc in Big Data Analytics', ['Masters (+2 or +3 yrs)']), 'Masters (+2 or +3 yrs)');
  const circles = ['Bachelor of Arts (BA)', 'Bachelor of Science (BS)', 'Masters of Arts (MA)', 'Masters of Science (MS)', 'Masters of Business Administration (MBA)'];
  assert.equal(pick('MSc in Big Data Analytics', circles), 'Masters of Science (MS)');
  assert.equal(pick('BSc in Statistics & Economics', circles), 'Bachelor of Science (BS)');
  assert.equal(pick('MSc in Big Data Analytics', ["Master's (M.A., M.S., M.B.A.)"]), "Master's (M.A., M.S., M.B.A.)");
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
