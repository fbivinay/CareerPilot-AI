import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateJob, parseCompensation, parseExperience, roleFamily, fingerprint } from '../lib/match.mjs';
import { DEFAULT_SETTINGS as S } from '../lib/settings.mjs';

const job = (over) => ({ title: 'Data Scientist', company: 'Acme', location: 'Bengaluru, India', description: '', ...over });

test('role families and exclusions', () => {
  assert.equal(roleFamily('Generative AI Engineer').family, 'ai');
  assert.equal(roleFamily('Agentic AI Intern').family, 'ai');
  assert.equal(roleFamily('Junior Data Scientist').family, 'ds');
  assert.equal(roleFamily('Analytics Engineer').family, 'de');
  assert.equal(roleFamily('Product Analyst').family, 'da');
  assert.equal(roleFamily('Decision Scientist').family, 'da');
  assert.equal(roleFamily('Python Backend Developer').family, null);
  assert.equal(roleFamily('AI Application Developer').family, null);
  assert.equal(roleFamily('Full Stack Engineer').family, null);
  assert.equal(roleFamily('Account Executive').family, null);
});

test('compensation parsing', () => {
  assert.deepEqual(parseCompensation('CTC: 8-12 LPA'), { min: 8e5, max: 12e5, period: 'year', currency: 'INR', source: 'disclosed' });
  assert.equal(parseCompensation('Stipend: ₹40,000 per month').min, 40000);
  assert.equal(parseCompensation('stipend of 25k-30k').max, 30000);
  assert.equal(parseCompensation('INR 9,00,000 per annum').min, 900000);
  assert.equal(parseCompensation('competitive salary'), null);
});

test('experience parsing', () => {
  assert.deepEqual(parseExperience('Freshers welcome'), { min: 0, max: 1 });
  assert.deepEqual(parseExperience('0-2 years of experience'), { min: 0, max: 2 });
  assert.deepEqual(parseExperience('3+ years in Python'), { min: 3, max: null });
  assert.deepEqual(parseExperience('Minimum 2 years experience'), { min: 2, max: null });
  assert.equal(parseExperience('Great team'), null);
});

test('qualifies a Bengaluru fresher role with disclosed pay', () => {
  const r = evaluateJob(job({ description: 'Freshers. CTC 8-10 LPA.' }), S);
  assert.equal(r.status, 'qualified');
  assert.equal(r.confidence, 'high');
  assert.ok(r.score >= 80);
});

test('undisclosed pay stays qualified but low-confidence, never invented', () => {
  const r = evaluateJob(job({ title: 'Data Analyst Intern' }), S);
  assert.equal(r.status, 'qualified');
  assert.equal(r.confidence, 'low');
  assert.equal(r.comp_min, null);
});

test('exclusions keep a reason', () => {
  assert.match(evaluateJob(job({ title: 'Senior Data Scientist' }), S).exclusion_reason, /Senior/);
  assert.match(evaluateJob(job({ description: '4+ years experience' }), S).exclusion_reason, /4\+ years/);
  assert.match(evaluateJob(job({ location: 'London, UK' }), S).exclusion_reason, /Outside India/);
  assert.match(evaluateJob(job({ description: 'CTC 5 LPA' }), S).exclusion_reason, /below/);
  assert.match(evaluateJob(job({ title: 'ML Intern', description: 'Stipend ₹20,000 per month' }), S).exclusion_reason, /below/);
  assert.equal(evaluateJob(job({ title: 'ML Intern', description: 'Stipend ₹45,000 per month' }), S).status, 'qualified');
});

test('fingerprint is stable across formatting', () => {
  assert.equal(fingerprint({ company: 'Acme Inc', title: 'Data Analyst (Remote)', location: 'Bengaluru, KA' }),
    fingerprint({ company: 'acme inc', title: 'Data  Analyst', location: 'Bengaluru' }));
});

test('seniority beats "associate"; QA roles excluded; missing JD lowers score', () => {
  assert.match(evaluateJob(job({ title: 'Data Science - Senior Associate' }), S).exclusion_reason, /Senior/);
  assert.equal(evaluateJob(job({ title: 'Associate Data Scientist', description: 'Freshers' }), S).status, 'qualified');
  assert.match(evaluateJob(job({ title: 'GenAI QA Automation Engineer' }), S).exclusion_reason, /QA/);
  const withJd = evaluateJob(job({ description: 'Freshers welcome' }), S).score;
  const noJd = evaluateJob(job({ description: '' }), S).score;
  assert.ok(noJd < withJd);
});
