// Defaults live in code; the dashboard Settings page stores overrides in kv('settings').
// The candidate's timeline is derived from their (encrypted) profile, not stored here.
import { kvGet, kvSet } from './db.mjs';
import { loadProfile } from './profile.mjs';

export const DEFAULT_SETTINGS = {
  compensation: {
    fullTimeMinLpa: 7,            // INR lakh per annum, applied only when disclosed
    internshipMinMonthly: 40000,  // INR per month, applied only when disclosed
  },
  matching: {
    qualifyScore: 60,             // rule score needed to be "qualified"
    autoActionScore: 70,          // score needed before any automatic outbound action
    maxExperienceYears: 1,        // exclude when the JD's minimum exceeds this
    includeInternships: true,
  },
  timeline: null, // filled from the profile by getSettings()
  locations: {
    // Ordered by preference; anything outside India is excluded.
    primary: ['bengaluru', 'bangalore'],
    india: ['india', 'hyderabad', 'pune', 'chennai', 'mumbai', 'navi mumbai', 'delhi', 'new delhi', 'gurgaon',
      'gurugram', 'noida', 'kolkata', 'ahmedabad', 'kochi', 'cochin', 'trivandrum', 'thiruvananthapuram',
      'coimbatore', 'jaipur', 'indore', 'chandigarh', 'mysore', 'mysuru', 'mangalore', 'mangaluru', 'bhubaneswar',
      'nagpur', 'vadodara', 'visakhapatnam', 'karnataka', 'maharashtra', 'telangana', 'tamil nadu'],
  },
  automation: {
    emailApplications: true,         // send applications to employer-published application addresses
    portalApplications: true,        // submit on employer Workday sites; questions the profile cannot answer block, never guess
    outreach: true,                  // cold outreach to verified public recruiting contacts
    followUps: true,
    actOnUndisclosedComp: true,      // allow automatic actions when salary is not disclosed (status stays low-confidence)
  },
  limits: {
    outreachPerDay: 10,
    emailApplicationsPerDay: 10,
    portalApplicationsPerDay: 10,
    perCompanyCooldownDays: 21,
    maxContactsPerCompany: 2,
    maxApplicationsPerAddress: 2,   // email applications to one employer address per cooldown window
    followUpAfterDays: 7,
    maxFollowUps: 1,
    sendWindow: { tz: 'Asia/Kolkata', days: [1, 2, 3, 4, 5], startHour: 9.5, endHour: 18.5 },
  },
  ai: {
    // Provider order for fallback. Each provider is used only for the data classes it is allowed.
    order: ['groq', 'gemini', 'openrouter'],
    maxCallsPerHour: 40,
  },
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export async function getSettings(db, env = process.env) {
  const s = merge(DEFAULT_SETTINGS, await kvGet(db, 'settings', {}));
  const profile = await loadProfile(db, env).catch(() => null);
  s.timeline = profile ? timelineFromProfile(profile) : null;
  return s;
}

const isoDate = (v) => {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.toISOString() : String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
};

// When the candidate can start, and the graduating batches they belong to, exactly as the profile states.
export function timelineFromProfile(profile, now = new Date()) {
  const a = profile.answers ?? {};
  const degrees = (profile.education ?? []).map((e) => {
    const year = Number(String(e.dates ?? '').match(/(20\d\d)\s*$/)?.[1]);
    return year ? { name: String(e.degree ?? '').split(/ in /i)[0], year, expected: year > now.getUTCFullYear() } : null;
  }).filter(Boolean);
  return {
    // A written answer such as "after my MSc" is not a date, so no start date is assumed from it.
    fullTimeFrom: a.earliest_full_time_start != null ? isoDate(a.earliest_full_time_start) : isoDate(a.earliest_joining_date),
    internshipFrom: isoDate(a.internship_available_from) ?? isoDate(a.earliest_joining_date),
    batchYears: degrees.map((d) => d.year),
    degrees: degrees.map((d) => `${d.name} ${d.year}${d.expected ? ' (expected)' : ''}`).join(', '),
  };
}

export async function saveSettings(db, overrides) {
  await kvSet(db, 'settings', overrides);
}
