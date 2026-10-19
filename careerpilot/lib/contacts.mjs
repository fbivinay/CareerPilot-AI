// Contacts come only from places where they were published or used verbatim:
//   jd            – an address printed in the job description
//   inbound_email – a person who emailed the candidate about an application
//   manual        – added by the candidate in the dashboard
// Addresses are never guessed from name patterns and never "verified" by probing mail servers.
import { createHash } from 'node:crypto';
import { now, one, run } from './db.mjs';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
// Addresses that exist for other purposes and must not receive job outreach.
const NOT_FOR_OUTREACH = /^(privacy|dpo|data\.?protection|gdpr|legal|security|abuse|accessibility|accommodations?|reasonable\.?accommodations?|disability|ethics|compliance|support|help|billing|sales|press|media|investors?|ir|noreply|no-reply|donotreply|do-not-reply|webmaster|postmaster|info)@/i;
const PLACEHOLDER = /@(example|domain|email|yourcompany|company)\.(com|org)$/i;

export function emailsInText(text) {
  return [...new Set((String(text ?? '').match(EMAIL_RE) ?? []).map((e) => e.toLowerCase().replace(/\.$/, '')))]
    .filter((e) => !NOT_FOR_OUTREACH.test(e) && !PLACEHOLDER.test(e));
}

// An address the employer explicitly asks applications to be sent to.
export function applicationEmail(text) {
  const s = String(text ?? '');
  const m = s.match(/(?:send|email|mail|share|forward|submit|drop)\s+(?:us\s+)?(?:your|an?|the)?\s*(?:updated\s+)?(?:resume|cv|profile|application|portfolio)[^@\n]{0,80}?([A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,})/i)
    ?? s.match(/apply\s+(?:by\s+)?(?:email(?:ing)?|writing)\s+(?:to|at|us at)?\s*([A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,})/i);
  const e = m?.[1]?.toLowerCase().replace(/\.$/, '');
  return e && emailsInText(e).length ? e : null;
}

export function domainMatchesCompany(email, company) {
  const domain = email.split('@')[1] ?? '';
  const label = domain.split('.').slice(0, -1).join('').replace(/[^a-z0-9]/g, '');
  const key = String(company ?? '').toLowerCase().replace(/\b(inc|llc|ltd|pvt|private|limited|technologies|labs|ai|india)\b/g, '').replace(/[^a-z0-9]/g, '');
  return key.length >= 3 && (label.includes(key) || key.includes(label) && label.length >= 4);
}

export function roleFromAddress(email) {
  const local = email.split('@')[0];
  if (/(career|job|recruit|talent|hiring|hr|people|ta)/i.test(local)) return 'Recruiting team';
  return null;
}

export async function upsertContact(db, { email, name = null, role = null, company = null, sourceType, sourceRef = null, domainMatch = false }) {
  const e = email.toLowerCase();
  const id = createHash('sha1').update(e).digest('hex').slice(0, 16);
  await run(db, `INSERT INTO contacts (id, email, name, role, company, source_type, source_ref, domain_match, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET name = COALESCE(contacts.name, excluded.name), company = COALESCE(contacts.company, excluded.company),
      domain_match = MAX(contacts.domain_match, excluded.domain_match),
      source_type = CASE WHEN excluded.source_type = 'inbound_email' THEN 'inbound_email' ELSE contacts.source_type END`,
  [id, e, name, role ?? roleFromAddress(e), company, sourceType, sourceRef, domainMatch ? 1 : 0, now()]);
  return one(db, 'SELECT * FROM contacts WHERE email = ?', [e]);
}

// What an address printed in a job description is for, read from the sentence that prints it. Most are not
// for applications: Karya, Maersk, ICF and Dexcom print theirs for disability accommodations, Airbus for
// reporting impersonation, BMS for errors in the posting. All four of the former were sent outreach on
// 2026-10-19. An address is used only when a sentence printing it asks for resumes or applications or names
// a recruiter (in its words, not the address: recruitment@ is printed for "extra support"), and is about
// nothing else.
const OTHER_PURPOSE = /accommodat|disabilit|adjustments?\b|special assistance|need (?:any )?(?:extra |additional )?(?:support|help)|accessib|impersonat|fraud|scam|privacy|data protection|personal data|incorrect|missing|do not send|report|complain|grievance|whistle/i;
const RECRUITING = /\b(resumes?|cvs?|apply|applications?|profiles?|portfolios?|recruit\w*|hiring|interested candidates)\b/i;
export function forRecruiting(text, email) {
  return String(text ?? '').split(/(?<=[.!?])\s+|\n+/).map((s) => s.toLowerCase())
    .some((s) => s.includes(email) && RECRUITING.test(s.replaceAll(email, '')) && !OTHER_PURPOSE.test(s));
}

// Record every outreach-eligible address printed in a job description.
export async function contactsFromJob(db, job) {
  const out = [];
  for (const email of emailsInText(job.description).filter((e) => forRecruiting(job.description, e))) {
    out.push(await upsertContact(db, { email, company: job.company, sourceType: 'jd', sourceRef: job.id, domainMatch: domainMatchesCompany(email, job.company) }));
  }
  return out;
}
