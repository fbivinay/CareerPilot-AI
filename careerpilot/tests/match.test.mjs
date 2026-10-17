import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseCompensation, employmentType, evaluateJob, fingerprint, locationTier, parseCompensation, parseExperience, roleFamily } from '../lib/match.mjs';
import { DEFAULT_SETTINGS as S } from '../lib/settings.mjs';

const job = (over) => ({ title: 'Data Scientist', company: 'Acme', location: 'Bengaluru, India', description: '', ...over });

test('role families and exclusions', () => {
  assert.equal(roleFamily('Generative AI Engineer').family, 'ai');
  assert.equal(roleFamily('Agentic AI Intern').family, 'ai');
  assert.equal(roleFamily('AI/ML Engineer').family, 'ai');
  assert.equal(roleFamily('Junior Data Scientist').family, 'ds');
  assert.equal(roleFamily('Analytics Engineer').family, 'de');
  assert.equal(roleFamily('Product Analyst').family, 'da');
  assert.equal(roleFamily('Decision Scientist').family, 'da');
  assert.equal(roleFamily('Data Analytics Intern').family, 'da');
  assert.equal(roleFamily('Python Backend Developer').family, null);
  assert.equal(roleFamily('Python Developer').family, null);
  assert.equal(roleFamily('AI Application Developer').family, null);
  assert.equal(roleFamily('Full Stack Engineer').family, null);
  assert.equal(roleFamily('Account Executive').family, null);
  assert.equal(roleFamily('Business Analyst').family, null);
});

test('compensation: LPA, stipends, annual figures, and things that are not pay', () => {
  assert.deepEqual(parseCompensation('CTC: 8-12 LPA'), { annual: { min: 8e5, max: 12e5 } });
  assert.deepEqual(parseCompensation('Salary: ₹7 LPA to ₹9 LPA').annual, { min: 7e5, max: 9e5 });
  assert.deepEqual(parseCompensation('Package of 6.5 lakhs per annum').annual, { min: 6.5e5, max: 6.5e5 });
  assert.deepEqual(parseCompensation('CTC 10 lakhs').annual, { min: 10e5, max: 10e5 });
  assert.equal(parseCompensation('Stipend: ₹40,000 per month').monthly.min, 40000);
  assert.deepEqual(parseCompensation('Stipend: 15,000 - 20,000/month').monthly, { min: 15000, max: 20000 });
  assert.deepEqual(parseCompensation('stipend of 25k-30k').monthly, { min: 25000, max: 30000 });
  assert.equal(parseCompensation('Rs. 35000 pm').monthly.max, 35000);
  assert.equal(parseCompensation('INR 9,00,000 per annum').annual.min, 900000);
  assert.equal(parseCompensation('Compensation: INR 6,00,000 - 8,00,000').annual.max, 800000);
  // Not pay: funding, insurance cover, years, unpaid stipends.
  assert.equal(parseCompensation('We raised ₹50,000 crore and have 20 years of history'), null);
  assert.equal(parseCompensation('Health insurance cover of Rs. 5,00,000 for family'), null);
  assert.equal(parseCompensation('Stipend: performance based'), null);
  assert.equal(parseCompensation('competitive salary'), null);
});

test('internship pay is judged on the stipend, not the PPO CTC', () => {
  const parsed = parseCompensation('Stipend ₹30,000 per month. PPO with CTC of 8 LPA on conversion.');
  assert.deepEqual(chooseCompensation(parsed, 'internship'), { min: 30000, max: 30000, period: 'month', currency: 'INR', source: 'disclosed' });
  assert.equal(chooseCompensation(parsed, 'full_time').period, 'year');
  assert.match(evaluateJob(job({ title: 'Data Science Intern', description: 'Stipend ₹30,000 per month. PPO with CTC of 8 LPA.' }), S).exclusion_reason, /below/);
});

test('experience: requirements count, company boilerplate does not', () => {
  assert.deepEqual(parseExperience('Freshers welcome'), { min: 0, max: 1 });
  assert.deepEqual(parseExperience('0-2 years of experience'), { min: 0, max: 2 });
  assert.deepEqual(parseExperience('3+ years of experience in Python'), { min: 3, max: null });
  assert.deepEqual(parseExperience('Minimum 2 years experience'), { min: 2, max: null });
  assert.deepEqual(parseExperience('Experience: 1-3 years'), { min: 1, max: 3 });
  assert.deepEqual(parseExperience('Experience required: 4 yrs'), { min: 4, max: 4 });
  assert.equal(parseExperience('Trusted by 500 brands for over 15+ years. Great team.'), null);
  assert.equal(parseExperience('Great team'), null);
  assert.deepEqual(parseExperience('Not suitable for freshers. 3+ years of experience required.'), { min: 3, max: null });
  assert.deepEqual(parseExperience('Data Analyst (3+ yrs)', { requireContext: false }), { min: 3, max: null });
});

test('employment type', () => {
  assert.equal(employmentType('Data Analyst Intern'), 'internship');
  assert.equal(employmentType('Data Analyst', 'This is a 6 month internship with a stipend.'), 'internship');
  assert.equal(employmentType('Data Analyst', 'Prior internship experience preferred.'), 'full_time');
  assert.equal(employmentType('Data Analyst (Contract)'), 'contract');
});

test('locations: India only, with aliases and no false friends', () => {
  assert.equal(locationTier('Bangalore', '', S).tier, 1);
  assert.equal(locationTier('Remote - India', '', S).tier, 2);
  assert.equal(locationTier('Hyderabad, Telangana', '', S).tier, 3);
  assert.ok(locationTier('Indianapolis, Indiana', '', S).excluded);
  assert.ok(locationTier('Remote - US', 'We also have an office in India.', S).excluded);
  assert.ok(locationTier('London, UK', '', S).excluded);
  const fromJd = locationTier('Remote', 'This role is open to candidates in India.', S);
  assert.equal(fromJd.tier, 2);
  assert.equal(fromJd.uncertain, true);
});

test('qualifies a Bengaluru fresher role with disclosed pay', () => {
  const r = evaluateJob(job({ description: 'Freshers. CTC 8-10 LPA.' }), S);
  assert.equal(r.status, 'qualified');
  assert.equal(r.confidence, 'high');
  assert.ok(r.score >= 80);
});

test('undisclosed pay stays qualified but low-confidence, never invented', () => {
  const r = evaluateJob(job({ title: 'Data Analyst Intern', description: 'Freshers welcome. SQL and Python.' }), S);
  assert.equal(r.status, 'qualified');
  assert.equal(r.confidence, 'low');
  assert.equal(r.comp_min, null);
});

test('exclusions keep a reason', () => {
  assert.match(evaluateJob(job({ title: 'Senior Data Scientist' }), S).exclusion_reason, /Senior/);
  assert.match(evaluateJob(job({ description: '4+ years of experience with ML' }), S).exclusion_reason, /4\+ years/);
  assert.match(evaluateJob(job({ location: 'London, UK' }), S).exclusion_reason, /Outside India/);
  assert.match(evaluateJob(job({ description: 'CTC 5 LPA' }), S).exclusion_reason, /below/);
  assert.match(evaluateJob(job({ title: 'ML Intern', description: 'Stipend ₹20,000 per month' }), S).exclusion_reason, /below/);
  assert.equal(evaluateJob(job({ title: 'ML Intern', description: 'Stipend ₹45,000 per month' }), S).status, 'qualified');
});

test('seniority beats "associate"; QA roles excluded; missing JD lowers score', () => {
  assert.match(evaluateJob(job({ title: 'Data Science - Senior Associate' }), S).exclusion_reason, /Senior/);
  assert.equal(evaluateJob(job({ title: 'Associate Data Scientist', description: 'Freshers' }), S).status, 'qualified');
  assert.match(evaluateJob(job({ title: 'GenAI QA Automation Engineer' }), S).exclusion_reason, /QA/);
  const withJd = evaluateJob(job({ description: 'Freshers welcome' }), S).score;
  const noJd = evaluateJob(job({ description: '' }), S).score;
  assert.ok(noJd < withJd);
});

test('fingerprint is stable across formatting and city aliases', () => {
  assert.equal(fingerprint({ company: 'Acme Inc', title: 'Data Analyst (Remote)', location: 'Bengaluru, KA' }),
    fingerprint({ company: 'acme inc', title: 'Data  Analyst', location: 'Bangalore' }));
});

test('experience parsing on phrases taken from real postings', () => {
  const cases = [
    ['appen has been a leader in ai training data for over 30 years. we specialise', null],
    ['bs/ms in ml; 1 to 3 years in ds/ai/ml engineering roles (internships', 1],
    ['- 1–3 years of professional software engineering experience, with', 1],
    ['who you are: 12+ years in data science, analytics, with 5+ years leading', 12],
    ['requirements 2-3 years in a technical support role', 2],
    ['looking for 5+ years building and operating production data pipelines', 5],
    ['with over 20 years at the intersection of supply chain. 3-5+ years in an engineering role', 3],
    ['data lake in the industry, built over 15 years and constantly enriched', null],
    ['for more than 30 years, verifone has established', null],
    ['operating for 25 years in india, we build', null],
    ['required qualifications: 3–5+ years of expertise in python is a must have. a 30-year legacy', 3],
    ['candidates with 2+ years of experience in sql', 2],
  ];
  for (const [text, min] of cases) assert.equal(parseExperience(text)?.min ?? null, min, text);
});

test('annotation/QC gigs, support roles and "leader" titles are excluded', () => {
  assert.equal(roleFamily('Quality control specialist for AI/ ML with Hindi language').family, null);
  assert.equal(roleFamily('Data Annotation Specialist').family, null);
  assert.equal(roleFamily('Technical Support & AI Engineer').family, null);
  assert.match(evaluateJob(job({ title: 'Analytics & Data Science Leader' }), S).exclusion_reason, /Senior/);
});
