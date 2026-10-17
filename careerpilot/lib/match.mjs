// Deterministic job qualification: role family, seniority, experience, location,
// compensation. Every decision carries a human-readable reason.

// Bump when rules change so stored jobs are re-evaluated on the next run.
export const RULES_VERSION = 2;

export const ROLE_FAMILIES = {
  ai: {
    label: 'AI / GenAI / Agentic AI Engineer',
    title: [/\bgen(erative)?[\s-]?ai\b/, /\bagentic\b/, /\bllm\b/, /\bai[\s/-]*(ml\s+)?engineer/, /\bai\s+(research|scientist)/,
      /\bmachine learning engineer\b/, /\bml\s*engineer\b/, /\bmlops\b/, /\bnlp\b/, /\bapplied (ai|ml|scientist)\b/,
      /\bcomputer vision\b/, /\bdeep learning\b/, /\bai\s+(intern|trainee|associate)\b/, /\bprompt engineer/],
  },
  ds: {
    label: 'Data Scientist / Junior ML Engineer',
    title: [/\bdata scien(ce|tist)/, /\bml\b/, /\bmachine learning\b/, /\bresearch scientist\b/],
  },
  de: {
    label: 'Data Engineer / Analytics Engineer',
    title: [/\bdata engineer/, /\banalytics engineer/, /\bbig data\b/, /\betl\b/, /\bdata platform\b/, /\bdata engineering\b/, /\bdata pipeline/],
  },
  da: {
    label: 'Data Analyst / Product Analyst / Decision Scientist',
    title: [/\bdata analy(st|tics)\b/, /\bproduct analy(st|tics)\b/, /\bdecision scien/, /\bbusiness intelligence\b/, /\bbi (analyst|developer|engineer)\b/,
      /\banalytics (associate|analyst|intern|trainee)\b/, /\bquantitative analyst\b/, /\binsights analyst\b/],
  },
};

// Explicitly excluded roles (user instruction), checked before families.
const EXCLUDED_TITLES = [
  [/\b(python|java|node(\.js)?|golang|go)\s+(backend\s+)?developer\b/, 'Python/backend developer roles are excluded'],
  [/\bbackend\b/, 'Backend developer roles are excluded'],
  [/\bai application developer\b/, 'AI Application Developer roles are excluded'],
  [/\bfull[\s-]?stack\b/, 'Full-stack roles are excluded'],
  [/\b(qa|quality assurance|sdet|tester|testing|test automation)\b/, 'QA/testing roles are excluded'],
  [/\bfront[\s-]?end\b/, 'Frontend roles are excluded'],
  [/\b(android|ios|mobile|flutter|react native)\b/, 'Mobile development roles are excluded'],
  [/\b(sales|account (executive|manager)|business development|marketing manager|recruiter|talent acquisition|hr\b|customer success|support engineer|devrel|developer advocate)\b/, 'Not a target role family'],
];

const SENIOR_TITLE = /\b(senior|sr\.?|lead|principal|staff|manager|head|director|architect|vp|vice president|chief|expert|experienced|iii|iv)\b/;
const MID_TITLE = /\b(ii|2|mid[\s-]?level)\b/;
// Strong entry-level signals override seniority words; 'associate' alone does not ("Senior Associate" is 2-5 years).
const JUNIOR_TITLE = /\b(junior|jr\.?|intern(ship)?|trainee|graduate|new grad|fresher|entry[\s-]?level|apprentice|campus|early career|0-1|0 ?- ?2)\b/;
const ASSOCIATE_TITLE = /\b(associate|analyst i|engineer i|scientist i)\b/;
const INTERN_TITLE = /\b(intern(ship)?|trainee|apprentice|co-?op)\b/;

const lower = (s) => String(s ?? '').toLowerCase();

export function roleFamily(title) {
  const t = lower(title);
  for (const [re, reason] of EXCLUDED_TITLES) if (re.test(t)) return { family: null, excluded: reason };
  for (const fam of ['ai', 'de', 'da', 'ds']) {
    if (ROLE_FAMILIES[fam].title.some((re) => re.test(t))) return { family: fam };
  }
  return { family: null, excluded: 'Title does not match any target role family' };
}

export function employmentType(title, description = '') {
  const t = lower(title);
  if (INTERN_TITLE.test(t)) return 'internship';
  const d = lower(description).slice(0, 4000);
  if (/\b(internship|stipend)\b/.test(d) && !/\bfull[\s-]?time\b/.test(d)) return 'internship';
  if (/\bcontract(ual)?\b|\bfreelance\b/.test(t)) return 'contract';
  return 'full_time';
}

// Returns {min, max} years or null. Picks the first explicit requirement in the text.
export function parseExperience(text) {
  const s = lower(text).replace(/–|—/g, '-');
  if (/\b(fresher|freshers|no experience required|new grads?|recent graduates?|0\s*years?)\b/.test(s)) {
    const range = s.match(/\b0\s*(?:-|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)/);
    return { min: 0, max: range ? Number(range[1]) : 1 };
  }
  const range = s.match(/\b(\d{1,2}(?:\.\d)?)\s*(?:-|to)\s*(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const plus = s.match(/\b(?:minimum|min\.?|at least|over)?\s*(\d{1,2}(?:\.\d)?)\s*\+\s*(?:years?|yrs?)/)
    || s.match(/\b(?:minimum|min\.?|at least)\s*(?:of\s*)?(\d{1,2}(?:\.\d)?)\s*(?:years?|yrs?)/)
    || s.match(/\b(\d{1,2})\s*(?:years?|yrs?)\s*(?:of\s*)?(?:relevant\s*|professional\s*|industry\s*|hands-on\s*|work\s*)?experience/);
  if (plus) return { min: Number(plus[1]), max: null };
  return null;
}

const INR_WORD = /(₹|inr|rs\.?|rupees)/;

// Normalized compensation: {min, max, period: 'year'|'month', currency, source:'disclosed'}.
// Only explicit figures are parsed; nothing is inferred.
export function parseCompensation(text) {
  const s = lower(text).replace(/,/g, '').replace(/–|—/g, '-');
  const lpa = s.match(/(?:₹|inr|rs\.?)?\s*(\d{1,2}(?:\.\d{1,2})?)\s*(?:-|to)?\s*(\d{1,2}(?:\.\d{1,2})?)?\s*(?:lpa|lakhs?\s*(?:per annum|p\.?a\.?|\/\s*annum|per year)|l\.p\.a)/);
  if (lpa) {
    const min = Number(lpa[1]) * 1e5;
    return { min, max: lpa[2] ? Number(lpa[2]) * 1e5 : min, period: 'year', currency: 'INR', source: 'disclosed' };
  }
  const monthly = s.match(/(?:stipend|salary|pay|ctc)?[^.\n]{0,40}?(₹|inr|rs\.?)\s*(\d{4,6})(?:\s*(?:-|to)\s*(?:₹|inr|rs\.?)?\s*(\d{4,6}))?\s*(?:\/|per|a|p\.?)\s*(?:month|mo\b|pm\b)/)
    || s.match(/stipend[^.\n]{0,30}?(₹|inr|rs\.?)?\s*(\d{2,3})k(?:\s*(?:-|to)\s*(\d{2,3})k)?/);
  if (monthly) {
    const k = monthly[0].includes('k') && !monthly[0].match(/\d{4}/) ? 1000 : 1;
    const min = Number(monthly[2]) * k;
    return { min, max: monthly[3] ? Number(monthly[3]) * k : min, period: 'month', currency: 'INR', source: 'disclosed' };
  }
  const annual = s.match(/(₹|inr|rs\.?)\s*(\d{6,8})(?:\s*(?:-|to)\s*(?:₹|inr|rs\.?)?\s*(\d{6,8}))?/);
  if (annual && INR_WORD.test(annual[0])) {
    const min = Number(annual[2]);
    return { min, max: annual[3] ? Number(annual[3]) : min, period: 'year', currency: 'INR', source: 'disclosed' };
  }
  return null;
}

export function locationTier(location, description, settings) {
  const loc = lower(location);
  const { primary, india } = settings.locations;
  if (primary.some((c) => loc.includes(c))) return { tier: 1, reason: 'Bengaluru' };
  const remote = /\bremote|work from home|wfh|anywhere\b/.test(loc);
  const inIndia = india.some((c) => loc.includes(c));
  if (remote && inIndia) return { tier: 2, reason: 'Remote (India)' };
  if (inIndia) return { tier: 3, reason: 'India (other city)' };
  if (!loc.trim() || remote) {
    const d = lower(description).slice(0, 6000);
    if (primary.some((c) => d.includes(c))) return { tier: 1, reason: 'Bengaluru (from description)' };
    if (/\bindia\b/.test(d)) return { tier: remote ? 2 : 3, reason: 'India (from description)' };
    return { tier: null, reason: remote ? 'Remote but India eligibility unclear' : 'Location not stated', uncertain: true };
  }
  return { tier: null, reason: `Outside India (${location})`, excluded: true };
}

export function normalizeTitle(title) {
  return lower(title).replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function fingerprint({ company, title, location }) {
  const city = lower(location).split(/[,;|·/]/)[0].replace(/[^a-z]+/g, '');
  return [lower(company).replace(/[^a-z0-9]+/g, ''), normalizeTitle(title), city].join('|');
}

// Full evaluation. Returns fields to persist on the job row.
export function evaluateJob(job, settings) {
  const reasons = [];
  const text = `${job.title}\n${job.description ?? ''}`;
  const result = (status, exclusion = null) => ({
    status, exclusion_reason: exclusion, score, confidence, role_category: family,
    employment_type: type, experience_min: exp?.min ?? null, experience_max: exp?.max ?? null,
    comp_min: comp?.min ?? null, comp_max: comp?.max ?? null, comp_period: comp?.period ?? null,
    comp_currency: comp?.currency ?? null, comp_source: comp?.source ?? null,
    match_reasons: JSON.stringify(reasons),
  });
  let score = 0;
  let confidence = 'high';
  const { family, excluded } = roleFamily(job.title);
  const type = employmentType(job.title, job.description);
  const exp = parseExperience(job.description ?? '') ?? parseExperience(job.title);
  const comp = job.salary?.min || job.salary?.max
    ? { min: job.salary.min ?? job.salary.max, max: job.salary.max ?? job.salary.min, period: job.salary.period ?? 'year', currency: (job.salary.currency || '').toUpperCase() || null, source: 'disclosed' }
    : parseCompensation(job.description ?? '');

  if (!family) return result('excluded', excluded);
  score += 40;
  reasons.push(`Role family: ${ROLE_FAMILIES[family].label}`);

  if (type === 'internship' && !settings.matching.includeInternships) return result('excluded', 'Internships disabled in settings');
  if (type === 'contract') { score -= 10; reasons.push('Contract role (-10)'); }

  const t = lower(job.title);
  if (SENIOR_TITLE.test(t) && !JUNIOR_TITLE.test(t)) return result('excluded', 'Senior-level title');
  if (JUNIOR_TITLE.test(t)) { score += 25; reasons.push('Entry-level / intern title (+25)'); }
  else if (ASSOCIATE_TITLE.test(t)) { score += 20; reasons.push('Associate-level title (+20)'); }
  else if (MID_TITLE.test(t)) { score += 5; reasons.push('Level II title, may expect experience (+5)'); confidence = 'low'; }
  else { score += 15; reasons.push('No seniority in title (+15)'); }

  if (exp) {
    if (exp.min > settings.matching.maxExperienceYears) return result('excluded', `Requires ${exp.min}+ years experience`);
    reasons.push(`Experience requirement ${exp.min}${exp.max != null ? '-' + exp.max : '+'} years fits`);
  } else {
    reasons.push('Experience requirement not stated');
  }
  if (!job.description) {
    score -= 10;
    confidence = 'low';
    reasons.push('Job description not fetched yet; experience and pay unverified (-10)');
  }

  const loc = locationTier(job.location, job.description, settings);
  if (loc.excluded) return result('excluded', loc.reason);
  if (loc.tier === 1) score += 20; else if (loc.tier === 2) score += 15; else if (loc.tier === 3) score += 10;
  if (loc.uncertain) confidence = 'low';
  reasons.push(`Location: ${loc.reason}`);

  if (comp && comp.currency === 'INR') {
    if (comp.period === 'month') {
      const floor = type === 'internship' ? settings.compensation.internshipMinMonthly : settings.compensation.fullTimeMinLpa * 1e5 / 12;
      if (comp.max < floor) return result('excluded', `Pay ₹${comp.max.toLocaleString('en-IN')}/month is below ₹${Math.round(floor).toLocaleString('en-IN')}/month`);
    } else {
      const floor = type === 'internship' ? settings.compensation.internshipMinMonthly * 12 : settings.compensation.fullTimeMinLpa * 1e5;
      if (comp.max < floor) return result('excluded', `CTC ₹${(comp.max / 1e5).toFixed(1)} LPA is below ₹${(floor / 1e5).toFixed(1)} LPA`);
    }
    score += 10;
    reasons.push('Disclosed compensation meets threshold (+10)');
  } else if (comp) {
    confidence = 'low';
    reasons.push(`Compensation disclosed in ${comp.currency || 'unknown currency'}; INR threshold not verifiable`);
  } else {
    confidence = 'low';
    reasons.push('Compensation not disclosed; threshold not verified');
  }

  if (job.postedAt || job.posted_at) {
    const ageDays = (Date.now() - new Date(job.postedAt ?? job.posted_at).getTime()) / 864e5;
    if (ageDays <= 14) { score += 5; reasons.push('Posted within 14 days (+5)'); }
    else if (ageDays > 60) { score -= 10; reasons.push('Posted over 60 days ago (-10)'); }
  }

  score = Math.max(0, Math.min(100, score));
  if (score < settings.matching.qualifyScore) return result('excluded', `Match score ${score} below ${settings.matching.qualifyScore}`);
  return result('qualified');
}
