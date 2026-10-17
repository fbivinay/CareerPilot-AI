// Studying until June 2027: internships now; full-time only where the employer hires that batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateJob, employmentType } from '../lib/match.mjs';
import { availabilityLine } from '../lib/compose.mjs';
import { DEFAULT_SETTINGS as S } from '../lib/settings.mjs';

const job = (over) => ({ title: 'Data Scientist', company: 'Acme', location: 'Bengaluru', description: 'Freshers welcome. Python, SQL.', ...over });

test('internships are prioritised, more so with conversion or a schedule that fits the MSc', () => {
  const plain = evaluateJob(job({ title: 'Data Science Intern' }), S);
  const ppo = evaluateJob(job({ title: 'Data Science Intern', description: 'Freshers welcome. 6-month internship with a PPO for top performers. Remote.' }), S);
  assert.equal(plain.status, 'qualified');
  assert.ok(ppo.score > plain.score);
  assert.ok(JSON.parse(ppo.match_reasons).some((r) => /PPO/.test(r)));
});

test('full-time roles: 2027 batch fits, immediate joining or earlier batches do not, unknown is flagged', () => {
  const fits = evaluateJob(job({ description: 'Open to 2027 graduates. Freshers welcome.' }), S);
  assert.equal(fits.status, 'qualified');
  assert.ok(JSON.parse(fits.match_reasons).some((r) => /2027 graduates/.test(r)));
  assert.match(evaluateJob(job({ description: 'Freshers. Immediate joiners only.' }), S).exclusion_reason, /immediate joining/);
  assert.match(evaluateJob(job({ description: 'Hiring 2025 pass-outs.' }), S).exclusion_reason, /2025-or-earlier graduates/);
  assert.equal(evaluateJob(job({ description: 'For 2025/2026/2027 graduates.' }), S).status, 'qualified');
  const unknown = evaluateJob(job(), S);
  assert.equal(unknown.status, 'qualified');
  assert.equal(unknown.confidence, 'low');
  assert.ok(JSON.parse(unknown.match_reasons).some((r) => /after your MSc \(Jun 2027\)/.test(r)));
  // Ranking: internship > full-time with unknown start date.
  assert.ok(evaluateJob(job({ title: 'Data Analyst Intern' }), S).score > unknown.score);
});

test('"Trainee" is a full-time entry role (judged on CTC), not an internship', () => {
  assert.equal(employmentType('Data Analyst Trainee'), 'full_time');
  assert.match(evaluateJob(job({ title: 'Data Analyst Trainee', description: 'For 2027 graduates. Salary: Rs. 30000 to 54000 per month' }), S).exclusion_reason, /below/);
});

test('emails state availability exactly as provided', () => {
  const p = { answers: { internship_available_from: new Date('2026-11-10'), earliest_full_time_start: 'After completing my MSc (expected June 2027)' } };
  assert.equal(availabilityLine(p, { employment_type: 'internship' }), 'I am available for an internship from 10 November 2026.');
  assert.equal(availabilityLine(p, { employment_type: 'full_time' }), 'I can join full-time after completing my MSc (expected June 2027).');
  assert.equal(availabilityLine({ answers: {} }, { employment_type: 'full_time' }), '');
});
