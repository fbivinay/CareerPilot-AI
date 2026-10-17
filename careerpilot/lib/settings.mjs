// Defaults live in code; the dashboard Settings page stores overrides in kv('settings').
import { kvGet, kvSet } from './db.mjs';

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
    outreach: true,                  // cold outreach to verified public recruiting contacts
    followUps: true,
    actOnUndisclosedComp: true,      // allow automatic actions when salary is not disclosed (status stays low-confidence)
  },
  limits: {
    outreachPerDay: 10,
    emailApplicationsPerDay: 10,
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

export async function getSettings(db) {
  return merge(DEFAULT_SETTINGS, await kvGet(db, 'settings', {}));
}

export async function saveSettings(db, overrides) {
  await kvSet(db, 'settings', overrides);
}
