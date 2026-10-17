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
  assert.deepEqual(ask('Have you ever worked for Marvell (as an Employee, Intern or Contractor)?'), { yes: false });
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
