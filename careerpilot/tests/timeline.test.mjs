// Timeline from the profile: available from 10 Nov 2026 for internships and full-time; belongs to the
// 2025 (BSc, completed) and 2027 (MSc, expected) batches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchYears, employmentType, evaluateJob, timelineFit } from '../lib/match.mjs';
import { availabilityLine } from '../lib/compose.mjs';
import { DEFAULT_SETTINGS, timelineFromProfile } from '../lib/settings.mjs';

const tl = { fullTimeFrom: '2026-11-10', internshipFrom: '2026-11-10', batchYears: [2027, 2025], degrees: 'MSc 2027 (expected), BSc 2025' };
const S = { ...DEFAULT_SETTINGS, timeline: tl };
const job = (over) => ({ title: 'Data Scientist', company: 'Acme', location: 'Bengaluru', description: 'Freshers welcome. Python, SQL.', ...over });
const reasons = (r) => JSON.parse(r.match_reasons).join(' | ');

test('timeline comes from the profile exactly as stated', () => {
  const t = timelineFromProfile({
    answers: { earliest_joining_date: new Date('2026-11-10'), internship_available_from: new Date('2026-11-10'), earliest_full_time_start: new Date('2026-11-10') },
    education: [{ degree: 'MSc in Big Data Analytics', dates: 'Aug 2025 - Jun 2027' }, { degree: 'BSc in Statistics & Economics', dates: 'Aug 2022 - Jun 2025' }],
  }, new Date('2026-10-17'));
  assert.deepEqual(t, tl);
  // A written answer such as "after my MSc" is not turned into a date.
  assert.equal(timelineFromProfile({ answers: { earliest_full_time_start: 'After completing my MSc' } }).fullTimeFrom, null);
});

test('full-time roles are open from the joining date; no start date stated is fine', () => {
  const r = evaluateJob(job({ description: 'Freshers welcome. CTC 9 LPA.' }), S);
  assert.equal(r.status, 'qualified');
  assert.equal(r.confidence, 'high');
  assert.doesNotMatch(reasons(r), /after your MSc|Start date not stated/);
});

test('batch restrictions use both degrees', () => {
  assert.deepEqual(batchYears('for 2024/2025/2026 batch'), [2024, 2025, 2026]);
  const bsc = evaluateJob(job({ description: 'Hiring 2025 pass-outs. Freshers.' }), S);
  assert.equal(bsc.status, 'qualified');
  assert.match(reasons(bsc), /2025 batch, which includes you/);
  assert.match(evaluateJob(job({ description: 'Only 2026 graduates may apply.' }), S).exclusion_reason, /For 2026 graduates; your degrees: MSc 2027 \(expected\), BSc 2025/);
  assert.equal(evaluateJob(job({ description: 'Open to final-year students.' }), S).status, 'qualified');
});

test('immediate joiners fit only when the start date is within about a month', () => {
  const imm = job({ description: 'Immediate joiners preferred.' });
  assert.equal(timelineFit(imm, 'full_time', tl, Date.parse('2026-10-17')).excluded, undefined);
  assert.match(timelineFit(imm, 'full_time', tl, Date.parse('2026-10-17')).reasons.join(), /you can start 10 Nov 2026/);
  assert.match(timelineFit(imm, 'full_time', tl, Date.parse('2026-09-01')).reason, /available from 10 Nov 2026/);
});

test('internships: conversion and MSc-friendly schedules rank higher', () => {
  const plain = evaluateJob(job({ title: 'Data Science Intern' }), S);
  const ppo = evaluateJob(job({ title: 'Data Science Intern', description: 'Freshers welcome. Internship with a PPO for top performers. Remote.' }), S);
  assert.equal(plain.status, 'qualified');
  assert.ok(ppo.score > plain.score);
  assert.match(reasons(ppo), /PPO/);
});

test('"Trainee" is a full-time entry role (judged on CTC), not an internship', () => {
  assert.equal(employmentType('Data Analyst Trainee'), 'full_time');
  assert.match(evaluateJob(job({ title: 'Data Analyst Trainee', description: 'Salary: Rs. 30000 to 54000 per month' }), S).exclusion_reason, /below/);
});

test('emails state availability exactly as provided', () => {
  const p = { answers: { internship_available_from: new Date('2026-11-10'), earliest_full_time_start: new Date('2026-11-10') } };
  assert.equal(availabilityLine(p, { employment_type: 'internship' }), 'I am available for an internship from 10 November 2026.');
  assert.equal(availabilityLine(p, { employment_type: 'full_time' }), 'I can join full-time from 10 November 2026.');
  assert.equal(availabilityLine({ answers: {} }, { employment_type: 'full_time' }), '');
});
