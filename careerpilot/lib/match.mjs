// Deterministic job qualification: role family, seniority, experience, location,
// compensation. Every decision carries a human-readable reason.

// Bump when rules change so stored jobs are re-evaluated on the next run.
export const RULES_VERSION = 5;

// An AI fit score below this excludes a rule-qualified job (shown with its reason, reversible in the dashboard).
export const AI_EXCLUDE_BELOW = 25;

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
      /\banalytics (associate|analyst|intern|trainee)\b/, /\bquantitative analyst\b/, /\binsights analyst\b/, /\bstatistic(ian|al analyst)\b/],
  },
};

// Explicitly excluded roles (user instruction), checked before families.
const EXCLUDED_TITLES = [
  [/\b(python|java|node(\.js)?|golang|go)\s+(backend\s+)?developer\b/, 'Python/backend developer roles are excluded'],
  [/\bbackend\b/, 'Backend developer roles are excluded'],
  [/\bai application developer\b/, 'AI Application Developer roles are excluded'],
  [/\bfull[\s-]?stack\b/, 'Full-stack roles are excluded'],
  [/\b(qa|quality assurance|sdet|tester|testing|test automation)\b/, 'QA/testing roles are excluded'],
  [/\b(quality control|annotat\w*|label(l)?ing|labeler|data entry|content moderat\w*|transcription|rater|evaluator|language specialist)\b/, 'Data annotation / QC gigs are excluded'],
  [/\b(technical support|support specialist|helpdesk|help desk)\b/, 'Support roles are excluded'],
  [/\bfront[\s-]?end\b/, 'Frontend roles are excluded'],
  [/\b(android|ios|mobile|flutter|react native)\b/, 'Mobile development roles are excluded'],
  [/\b(sales|account (executive|manager)|business development|marketing manager|recruiter|talent acquisition|hr\b|customer success|support engineer|devrel|developer advocate)\b/, 'Not a target role family'],
];

const SENIOR_TITLE = /\b(senior|sr\.?|lead|leader|leadership|principal|staff|manager|head|director|architect|vp|vice president|chief|expert|experienced|iii|iv)\b/;
const MID_TITLE = /\b(ii|2|mid[\s-]?level)\b/;
// Strong entry-level signals override seniority words; 'associate' alone does not ("Senior Associate" is 2-5 years).
const JUNIOR_TITLE = /\b(junior|jr\.?|intern(ship)?|trainee|graduate|new grad|fresher|entry[\s-]?level|apprentice|campus|early career|0-1|0 ?- ?2)\b/;
const ASSOCIATE_TITLE = /\b(associate|analyst i|engineer i|scientist i)\b/;
// "Trainee" roles in India are usually full-time entry jobs, so they are judged on CTC, not stipend.
const INTERN_TITLE = /\b(intern(ship)?|apprentice(ship)?|co-?op)\b/;

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
  if (/\b(contract(ual)?|freelance|temporary)\b/.test(t)) return 'contract';
  const d = lower(description).slice(0, 6000);
  const internshipBody = /\b(this is an? (paid |unpaid )?internship|internship (duration|period|opportunity|program(me)?)|duration of (the )?internship|\d+[\s-]*months?( long)? internship|stipend)\b/;
  if (internshipBody.test(d) && !/\bfull[\s-]?time (role|position|employment|opportunity|job)\b/.test(d)) return 'internship';
  return 'full_time';
}

// Experience requirement in years, or null. Each "N years" mention is judged by its surroundings:
// requirement phrasing ("2+ years of experience", "1-3 years in analytics", "Experience: 2 years")
// counts; company boilerplate ("for over 30 years", "built over 15 years", "with over 20 years at")
// does not. The first requirement found wins.
const YEARS_RE = /\b(\d{1,2}(?:\.\d)?)\s*(\+\s*)?(?:(?:-|to)\s*(\d{1,2}(?:\.\d)?)\s*\+?\s*)?(?:years?|yrs?)\b/g;
const EXPLICIT_AFTER = /^\s*(of\s+)?([\w/&,.()+-]+\s+){0,6}?(experience|expertise)\b/;
const GENERIC_AFTER = /^\s*(in|building|developing|designing|working|leading|managing|delivering|operating|shipping|writing|as an?|of (relevant|professional|industry|work|hands-on|practical|proven|post))\b/;
const EXPERIENCE_BEFORE = /\b(experience|exp)\.?\s*(required|requirement|level|needed)?\s*[:\-]?\s*(of\s*)?(minimum|min\.?|at least)?\s*$/;
const MINIMUM_BEFORE = /\b(minimum|min\.?|at least|requires?|need|needs)\s*(of\s*)?$/;
const BOILERPLATE_BEFORE = /(\b(?<!(looking|searching|seeking|hiring) )for\b|\b(with|built|founded|established|since|history|legacy|trusted|serving|been)\b)[^.;:\n]{0,25}$/;
const FRESHER_RE = /\b(freshers?|no (prior )?experience (is )?required|new grads?|recent graduates?|entry[\s-]level|0\s*(?:-|to)\s*\d+\s*(?:years?|yrs?))\b/;
const NOT_FRESHER_RE = /\b(not (suitable |open )?for freshers|no freshers|freshers (need not|should not|are not eligible))\b/;

export function parseExperience(text, { requireContext = true } = {}) {
  const s = lower(text).replace(/[–—]/g, '-');
  let explicit = null;
  for (const m of s.matchAll(YEARS_RE)) {
    const before = s.slice(Math.max(0, m.index - 40), m.index);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 80);
    const min = Number(m[1]);
    if (requireContext) {
      const stated = EXPLICIT_AFTER.test(after) || EXPERIENCE_BEFORE.test(before) || MINIMUM_BEFORE.test(before);
      const boilerplate = BOILERPLATE_BEFORE.test(before) && !EXPERIENCE_BEFORE.test(before) && !MINIMUM_BEFORE.test(before);
      const requirement = stated ? !boilerplate || EXPLICIT_AFTER.test(after) && min <= 15 : GENERIC_AFTER.test(after) && !boilerplate && min <= 20;
      if (!requirement) continue;
    }
    const openEnded = m[2] || /\b(minimum|min\.?|at least|over|more than)\s*(of\s*)?$/.test(before);
    explicit = { min, max: m[3] != null ? Number(m[3]) : openEnded ? null : min };
    break;
  }
  if (FRESHER_RE.test(s) && !NOT_FRESHER_RE.test(s)) return { min: 0, max: explicit?.max ?? (explicit?.min || 1) };
  return explicit;
}

const amount = (v) => (String(v).endsWith('k') ? parseFloat(v) * 1000 : Number(v));
const CUR = '(?:₹|inr|rs\\.?|rupees)';
const AMT = '(\\d{1,3}(?:\\.\\d+)?k|\\d{4,8})';
const MONTHLY_RE = new RegExp(`${CUR}\\s*${AMT}(?:\\s*(?:-|to)\\s*${CUR}?\\s*${AMT})?\\s*(?:(?:/|per|a|p\\.?)\\s*(?:month|mo)\\b|(?:pm|monthly)\\b)`);
const STIPEND_RE = new RegExp(`stipend[^.\\n]{0,40}?${CUR}?\\s*${AMT}(?:\\s*(?:-|to)\\s*${CUR}?\\s*${AMT})?`);
const ANNUAL_CONTEXT_RE = new RegExp(`(?:ctc|salary|package|compensation)[^.\\n]{0,30}?${CUR}?\\s*(\\d{6,8})(?:\\s*(?:-|to)\\s*${CUR}?\\s*(\\d{6,8}))?`);
const ANNUAL_UNIT_RE = new RegExp(`${CUR}\\s*(\\d{6,8})(?:\\s*(?:-|to)\\s*${CUR}?\\s*(\\d{6,8}))?\\s*(?:per annum|p\\.? ?a\\b|per year|annually|/\\s*(?:year|annum)|a year)`);

// Compensation explicitly stated in a posting, split into annual (CTC) and monthly (stipend) figures.
// Nothing is inferred; amounts without a pay context or unit are ignored.
export function parseCompensation(text) {
  const s = lower(text).replace(/(\d),(?=\d)/g, '$1').replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  const out = {};
  const range = (a, b, scale = 1) => ({ min: amount(a) * scale, max: amount(b ?? a) * scale });

  const lpa = s.match(/(\d{1,2}(?:\.\d+)?)\s*(?:l|lpa|lakhs?|lacs?)?\s*(?:-|to)\s*(?:₹|inr|rs\.?)?\s*(\d{1,2}(?:\.\d+)?)\s*(?:lpa|l\.p\.a|lakhs?|lacs?)\b/)
    ?? s.match(/(\d{1,2}(?:\.\d+)?)\s*(?:lpa|l\.p\.a)\b/)
    ?? s.match(/(?:ctc|salary|package|compensation)[^.\n]{0,25}?(\d{1,2}(?:\.\d+)?)\s*(?:lakhs?|lacs?|l)\b/)
    ?? s.match(/(\d{1,2}(?:\.\d+)?)\s*(?:lakhs?|lacs?)\s*(?:per annum|p\.? ?a\b|per year|annually|a year)/);
  if (lpa) out.annual = range(lpa[1], lpa[2], 1e5);

  const monthly = s.match(MONTHLY_RE) ?? s.match(STIPEND_RE);
  if (monthly) {
    const [a, b] = monthly.slice(1).filter((v) => v != null);
    const m = range(a, b);
    if (m.min >= 1000 && m.max <= 500000) out.monthly = m;
  }

  if (!out.annual) {
    const annual = s.match(ANNUAL_CONTEXT_RE) ?? s.match(ANNUAL_UNIT_RE);
    if (annual) out.annual = range(annual[1], annual[2]);
  }
  return out.annual || out.monthly ? out : null;
}

// The figure that matters for this employment type: stipend for internships, CTC otherwise.
export function chooseCompensation(parsed, type) {
  if (!parsed) return null;
  const [period, value] = type === 'internship'
    ? (parsed.monthly ? ['month', parsed.monthly] : ['year', parsed.annual])
    : (parsed.annual ? ['year', parsed.annual] : ['month', parsed.monthly]);
  return { ...value, period, currency: 'INR', source: 'disclosed' };
}

const CITY_ALIASES = [[/\bbangalore\b/g, 'bengaluru'], [/\bbombay\b/g, 'mumbai'], [/\bgurgaon\b/g, 'gurugram'], [/\bnew delhi\b/g, 'delhi'],
  [/\bmadras\b/g, 'chennai'], [/\bcalcutta\b/g, 'kolkata'], [/\bmysore\b/g, 'mysuru'], [/\bmangalore\b/g, 'mangaluru'],
  [/\btrivandrum\b/g, 'thiruvananthapuram'], [/\bcochin\b/g, 'kochi']];
export const normalizeCities = (s) => CITY_ALIASES.reduce((acc, [re, to]) => acc.replace(re, to), lower(s));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (hay, words) => words.some((w) => new RegExp(`(^|[^a-z])${escapeRe(w)}([^a-z]|$)`).test(hay));
const NON_INDIA = /\b(united states|usa|u\.s\.a?|us|uk|united kingdom|england|london|canada|toronto|europe|emea|germany|berlin|france|paris|spain|poland|netherlands|amsterdam|ireland|dublin|singapore|philippines|manila|australia|sydney|new zealand|latam|brazil|mexico|japan|tokyo|china|vietnam|indonesia|malaysia|uae|dubai|israel|switzerland|sweden|portugal|lisbon|argentina|colombia|south africa|nigeria|kenya|egypt|turkey|romania|ukraine|pakistan|bangladesh|sri lanka|nepal|korea|taiwan|hong kong|thailand|saudi|qatar|indiana|indianapolis|california|new york|texas|washington|seattle|san francisco|boston|chicago|atlanta|austin|denver)\b/;

export function locationTier(location, description, settings) {
  const loc = lower(location);
  const { primary, india } = settings.locations;
  if (hasWord(loc, primary)) return { tier: 1, reason: 'Bengaluru' };
  const remote = /\bremote\b|\bwork from home\b|\bwfh\b|\banywhere\b/.test(loc);
  const inIndia = hasWord(loc, india);
  if (remote && inIndia) return { tier: 2, reason: 'Remote (India)' };
  if (inIndia) return { tier: 3, reason: 'India (other city)' };
  if (NON_INDIA.test(loc)) return { tier: null, reason: `Outside India (${location})`, excluded: true };
  if (!loc.trim() || remote) {
    const d = lower(description).slice(0, 6000);
    if (hasWord(d, primary)) return { tier: 1, reason: 'Bengaluru (from description)', uncertain: true };
    if (/\bindia\b/.test(d)) return { tier: remote ? 2 : 3, reason: 'India (from description)', uncertain: true };
    return { tier: null, reason: remote ? 'Remote but India eligibility unclear' : 'Location not stated', uncertain: true };
  }
  return { tier: null, reason: `Outside India (${location})`, excluded: true };
}

export function normalizeTitle(title) {
  return lower(title).replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function fingerprint({ company, title, location }) {
  const city = normalizeCities(location).split(/[,;|·/]/)[0].replace(/[^a-z]+/g, '');
  return [lower(company).replace(/[^a-z0-9]+/g, ''), normalizeTitle(title), city].join('|');
}

// Timeline fit for a candidate who is studying until graduation (settings.timeline):
// internships are available now; full-time roles fit only if they hire the graduating batch or
// final-year students. Joining full-time before graduation is never assumed.
const CONVERSION_RE = /\b(ppo|pre-?placement offer|full[- ]time conversion|convert(ed)? (in)?to (a )?full[- ]time|conversion to (a )?full[- ]time|return offer)\b/;
const FLEXIBLE_RE = /\b(part[- ]time|remote|work from home|wfh|flexible (hours|schedule|timings?))\b/;
const IMMEDIATE_RE = /\b(immediate joiners?|immediate joining|join(ing)? immediately|immediately available|available to join immediately|(must|should|able to) join (immediately|within \d+ (days|weeks)))\b/;

export function timelineFit(job, type, tl) {
  if (!tl) return { points: 0, reasons: [] };
  const d = lower(`${job.title}\n${job.description ?? ''}`).replace(/[–—]/g, '-');
  const y = tl.graduationYear;
  const when = `${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][tl.graduationMonth] ?? ''} ${y}`.trim();
  if (type === 'internship') {
    const out = { points: 5, reasons: ['Internship: available now, before graduation (+5)'] };
    if (CONVERSION_RE.test(d)) { out.points += 5; out.reasons.push('Mentions full-time conversion / PPO (+5)'); }
    if (FLEXIBLE_RE.test(d)) { out.points += 3; out.reasons.push('Part-time, remote or flexible: easier alongside the MSc (+3)'); }
    return out;
  }
  if (type !== 'full_time') return { points: 0, reasons: [] };
  const compatible = new RegExp(`\\b(${y} (batch|graduates?|pass[- ]?outs?|grads?)|batch (of )?${y}|class of ${y}|graduating (in )?${y}|(expected|anticipated|due) to graduate[^.]{0,30}${y}|final[- ]year students?|pre-?final[- ]year|students (graduating|in their final year)|(start|join)(ing)? (date )?(in |from )?(\\w+ )?${y})\\b`);
  if (compatible.test(d)) return { points: 10, reasons: [`Open to ${y} graduates / final-year students (+10)`] };
  if (IMMEDIATE_RE.test(d)) return { excluded: true, reason: `Requires immediate joining; you can join full-time after your MSc (${when})` };
  const earlier = d.match(/\b(20[12]\d) (batch|graduates?|pass[- ]?outs?)|batch (?:of )?(20[12]\d)|(?:graduated|passed out) in (20[12]\d)\b/);
  const earlierYear = earlier && Number(earlier[1] ?? earlier[3] ?? earlier[4]);
  if (earlierYear && earlierYear < y) return { excluded: true, reason: `For ${earlierYear}-or-earlier graduates; you graduate in ${when}` };
  return { points: -5, uncertain: true,
    reasons: [`Start date not stated: you can join full-time after your MSc (${when}) unless the employer allows earlier (-5)`] };
}

// Full evaluation. Returns fields to persist on the job row.
export function evaluateJob(job, settings) {
  const reasons = [];
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
  // A title such as 'Data Analyst (3+ yrs)' states the requirement directly, so no context is needed there.
  const exp = parseExperience(job.description ?? '') ?? parseExperience(job.title, { requireContext: false });
  const comp = job.salary?.min || job.salary?.max
    ? { min: job.salary.min ?? job.salary.max, max: job.salary.max ?? job.salary.min, period: job.salary.period ?? 'year', currency: (job.salary.currency || '').toUpperCase() || null, source: 'provider' }
    : chooseCompensation(parseCompensation(job.description ?? ''), type);

  if (!family) return result('excluded', excluded);
  score += 40;
  reasons.push(`Role family: ${ROLE_FAMILIES[family].label}`);

  if (type === 'internship' && !settings.matching.includeInternships) return result('excluded', 'Internships disabled in settings');
  if (type === 'contract') { score -= 10; reasons.push('Contract role (-10)'); }

  const timeline = timelineFit(job, type, settings.timeline);
  if (timeline.excluded) return result('excluded', timeline.reason);
  score += timeline.points;
  if (timeline.uncertain) confidence = 'low';
  reasons.push(...timeline.reasons);

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
