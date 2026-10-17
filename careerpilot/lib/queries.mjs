// Read queries behind the dashboard. Every number shown links to the list these same filters produce,
// so a statistic and its drill-down can never disagree.
import { all, getDb, kvGet, one } from './db.mjs';
import { APPLIED } from './applications.mjs';
import { providerHealth } from './ai.mjs';
import { loadProfile } from './profile.mjs';
import { answerPack } from './prepare.mjs';

export const PAGE_SIZE = 50;

const HEARD_BACK = ['assessment', 'interview', 'offer', 'rejected']; // a human decision, not an auto-acknowledgement

// Application status groups usable as ?status= in /applications.
export const APP_GROUPS = {
  applied: APPLIED,
  responded: HEARD_BACK,
  pending: ['ready', 'blocked', 'failed'],
};

const placeholders = (a) => a.map(() => '?').join(',');
const page = (p) => Math.max(1, Number(p) || 1);

function jobFilters(f) {
  const where = [];
  const args = [];
  const status = f.status ?? 'qualified';
  // "all" means every tracked job with duplicates merged, matching the Overview count.
  if (status === 'all') where.push(`j.status != 'duplicate'`);
  else { where.push('j.status = ?'); args.push(status); }
  if (f.q) { where.push('(lower(j.title) LIKE ? OR lower(j.company) LIKE ? OR lower(j.location) LIKE ?)'); const q = `%${f.q.toLowerCase()}%`; args.push(q, q, q); }
  if (f.category) { where.push('j.role_category = ?'); args.push(f.category); }
  if (f.confidence) { where.push('j.confidence = ?'); args.push(f.confidence); }
  if (f.type) { where.push('j.employment_type = ?'); args.push(f.type); }
  if (f.source) { where.push(f.source === 'alerts' ? `j.source LIKE 'alert:%'` : 'j.source = ?'); if (f.source !== 'alerts') args.push(f.source); }
  if (f.company) { where.push('j.company = ?'); args.push(f.company); }
  if (f.location === 'bengaluru') where.push(`(lower(j.location) LIKE '%bengaluru%' OR lower(j.location) LIKE '%bangalore%')`);
  if (f.location === 'remote') where.push(`lower(j.location) LIKE '%remote%'`);
  if (f.comp === 'disclosed') where.push('j.comp_source IS NOT NULL');
  if (f.comp === 'undisclosed') where.push('j.comp_source IS NULL');
  if (f.since) { where.push('j.first_seen >= ?'); args.push(new Date(Date.now() - Number(f.since) * 864e5).toISOString()); }
  return { where: where.length ? where.join(' AND ') : '1=1', args };
}

const JOB_SORTS = { score: 'j.score DESC, j.ai_score DESC', newest: 'j.first_seen DESC', posted: 'j.posted_at DESC', company: 'j.company ASC', comp: 'j.comp_max DESC' };

export async function listJobs(f) {
  const db = await getDb();
  const { where, args } = jobFilters(f);
  const order = JOB_SORTS[f.sort] ?? JOB_SORTS.score;
  const p = page(f.page);
  const total = Number((await one(db, `SELECT count(*) n FROM jobs j WHERE ${where}`, args)).n);
  const rows = await all(db, `SELECT j.id, j.title, j.company, j.location, j.url, j.source, j.status, j.score, j.ai_score, j.confidence, j.role_category,
      j.employment_type, j.comp_min, j.comp_max, j.comp_period, j.comp_source, j.posted_at, j.first_seen, j.exclusion_reason, a.id app_id, a.status app_status
    FROM jobs j LEFT JOIN applications a ON a.job_id = j.id WHERE ${where} ORDER BY ${order}, j.id LIMIT ? OFFSET ?`, [...args, PAGE_SIZE, (p - 1) * PAGE_SIZE]);
  const sources = (await all(db, `SELECT DISTINCT source FROM jobs ORDER BY source`)).map((r) => r.source);
  return { rows, total, page: p, sources };
}

export async function getJob(id) {
  const db = await getDb();
  const job = await one(db, 'SELECT * FROM jobs WHERE id = ?', [id]);
  if (!job) return null;
  const [application, emails, outreach, events, duplicates, contacts] = await Promise.all([
    one(db, 'SELECT * FROM applications WHERE job_id = ?', [id]),
    all(db, 'SELECT * FROM emails WHERE job_id = ? ORDER BY received_at DESC', [id]),
    all(db, `SELECT o.*, c.email, c.name FROM outreach o JOIN contacts c ON c.id = o.contact_id WHERE o.job_id = ? ORDER BY o.created_at DESC`, [id]),
    all(db, `SELECT * FROM events WHERE entity = 'job' AND entity_id = ? ORDER BY id DESC LIMIT 50`, [id]),
    all(db, 'SELECT id, url, source FROM jobs WHERE duplicate_of = ?', [id]),
    all(db, `SELECT * FROM contacts WHERE source_ref = ? OR lower(company) = lower(?)`, [id, job.company]),
  ]);
  return { job, application, emails, outreach, events, duplicates, contacts };
}

function appFilters(f) {
  const where = [];
  const args = [];
  if (f.status === 'interviewed') {
    // Ever reached an interview, including ones later rejected or turned into offers.
    where.push(`(a.status IN ('interview','offer') OR a.id IN (SELECT entity_id FROM events WHERE entity = 'application' AND to_status = 'interview'))`);
  } else if (f.status) {
    const set = APP_GROUPS[f.status] ?? [f.status];
    where.push(`a.status IN (${placeholders(set)})`);
    args.push(...set);
  }
  if (f.method) { where.push(f.method === 'platform' ? `a.method LIKE 'platform:%'` : 'a.method = ?'); if (f.method !== 'platform') args.push(f.method); }
  if (f.q) { where.push('(lower(j.title) LIKE ? OR lower(j.company) LIKE ?)'); args.push(`%${f.q.toLowerCase()}%`, `%${f.q.toLowerCase()}%`); }
  if (f.company) { where.push('j.company = ?'); args.push(f.company); }
  if (f.category) { where.push('j.role_category = ?'); args.push(f.category); }
  if (f.source) { where.push(f.source === 'alerts' ? `j.source LIKE 'alert:%'` : 'j.source = ?'); if (f.source !== 'alerts') args.push(f.source); }
  if (f.resume) { where.push('a.resume_version = ?'); args.push(f.resume); }
  return { where: where.length ? where.join(' AND ') : '1=1', args };
}

const APP_SORTS = { updated: 'a.updated_at DESC', submitted: 'a.submitted_at DESC', company: 'j.company ASC', score: 'j.score DESC' };

export async function listApplications(f) {
  const db = await getDb();
  const { where, args } = appFilters(f);
  const p = page(f.page);
  const total = Number((await one(db, `SELECT count(*) n FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${where}`, args)).n);
  const rows = await all(db, `SELECT a.*, j.title, j.company, j.url, j.location, j.score, j.source,
      (SELECT count(*) FROM emails e WHERE e.application_id = a.id) email_count
    FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${where} ORDER BY ${APP_SORTS[f.sort] ?? APP_SORTS.updated}, a.id LIMIT ? OFFSET ?`,
  [...args, PAGE_SIZE, (p - 1) * PAGE_SIZE]);
  return { rows, total, page: p };
}

export async function getApplication(id) {
  const db = await getDb();
  const app = await one(db, `SELECT a.*, j.title, j.company, j.url, j.location, j.id job_id, j.score, j.description, j.employment_type FROM applications a
    JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`, [id]);
  if (!app) return null;
  const [emails, outreach, events, profile] = await Promise.all([
    all(db, 'SELECT * FROM emails WHERE application_id = ? OR (thread_id IS NOT NULL AND thread_id = ?) ORDER BY received_at DESC', [id, app.gmail_thread_id]),
    all(db, `SELECT o.*, c.email, c.name FROM outreach o JOIN contacts c ON c.id = o.contact_id WHERE o.job_id = ? ORDER BY o.created_at DESC`, [app.job_id]),
    all(db, `SELECT * FROM events WHERE entity = 'application' AND entity_id = ? ORDER BY id DESC`, [id]),
    loadProfile(db).catch(() => null),
  ]);
  // Built on demand from the encrypted profile; absent where the decryption key is not configured.
  const pack = profile ? answerPack(profile, app) : null;
  return { app, emails, outreach, events, pack };
}

export async function listOutreach(f) {
  const db = await getDb();
  const where = [];
  const args = [];
  if (f.status) { where.push('o.status = ?'); args.push(f.status); }
  if (f.kind) { where.push('o.kind = ?'); args.push(f.kind); }
  if (f.replied === '1') where.push('o.replied_at IS NOT NULL');
  if (f.company) { where.push('lower(c.company) = lower(?)'); args.push(f.company); }
  const w = where.length ? where.join(' AND ') : '1=1';
  const p = page(f.page);
  const total = Number((await one(db, `SELECT count(*) n FROM outreach o JOIN contacts c ON c.id = o.contact_id WHERE ${w}`, args)).n);
  const rows = await all(db, `SELECT o.*, c.email, c.name, c.company, j.title FROM outreach o JOIN contacts c ON c.id = o.contact_id
    LEFT JOIN jobs j ON j.id = o.job_id WHERE ${w} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`, [...args, PAGE_SIZE, (p - 1) * PAGE_SIZE]);
  return { rows, total, page: p };
}

export async function getOutreach(id) {
  const db = await getDb();
  const o = await one(db, `SELECT o.*, c.email, c.name, c.company, c.source_type, c.source_ref, j.title FROM outreach o
    JOIN contacts c ON c.id = o.contact_id LEFT JOIN jobs j ON j.id = o.job_id WHERE o.id = ?`, [id]);
  if (!o) return null;
  const followups = await all(db, 'SELECT * FROM outreach WHERE followup_of = ? ORDER BY created_at', [id]);
  const events = await all(db, `SELECT * FROM events WHERE entity = 'outreach' AND entity_id IN (${placeholders([id, ...followups.map((x) => x.id)])}) ORDER BY id DESC`,
    [id, ...followups.map((x) => x.id)]);
  return { o, followups, events };
}

export async function listContacts() {
  const db = await getDb();
  return all(db, `SELECT c.*, (SELECT count(*) FROM outreach o WHERE o.contact_id = c.id AND o.status = 'sent') sent
    FROM contacts c ORDER BY c.created_at DESC LIMIT 200`);
}

export async function listEmails(f) {
  const db = await getDb();
  const where = [`e.category != 'ignored'`];
  const args = [];
  if (f.category) { where.push('e.category = ?'); args.push(f.category); }
  if (f.review === '1') where.push('e.needs_review = 1 AND e.reviewed = 0');
  if (f.linked === '1') where.push('e.application_id IS NOT NULL');
  const p = page(f.page);
  const w = where.join(' AND ');
  const total = Number((await one(db, `SELECT count(*) n FROM emails e WHERE ${w}`, args)).n);
  const rows = await all(db, `SELECT e.*, j.title, j.company job_company FROM emails e LEFT JOIN jobs j ON j.id = e.job_id
    WHERE ${w} ORDER BY e.received_at DESC LIMIT ? OFFSET ?`, [...args, PAGE_SIZE, (p - 1) * PAGE_SIZE]);
  const apps = await all(db, `SELECT a.id, j.company, j.title FROM applications a JOIN jobs j ON j.id = a.job_id ORDER BY j.company LIMIT 500`);
  return { rows, total, page: p, apps };
}

const count = async (db, sql, args = []) => Number((await one(db, sql, args)).n);

export async function overview() {
  const db = await getDb();
  const appIn = async (set) => count(db, `SELECT count(*) n FROM applications WHERE status IN (${placeholders(set)})`, set);
  const [discovered, live, qualified, qualifiedHigh, ready, blocked, failed, applied, confirmed, assessment, interview, offer, rejected,
    outreachSent, replies, review, unknownSends] = await Promise.all([
    count(db, `SELECT count(*) n FROM jobs WHERE status != 'duplicate'`),
    count(db, `SELECT count(*) n FROM jobs WHERE status IN ('qualified','excluded','new')`),
    count(db, `SELECT count(*) n FROM jobs WHERE status = 'qualified'`),
    count(db, `SELECT count(*) n FROM jobs WHERE status = 'qualified' AND confidence = 'high'`),
    appIn(['ready']), appIn(['blocked']), appIn(['failed']), appIn(APPLIED), appIn(['confirmed']), appIn(['assessment']),
    appIn(['interview']), appIn(['offer']), appIn(['rejected']),
    count(db, `SELECT count(*) n FROM outreach WHERE status = 'sent'`),
    count(db, `SELECT count(*) n FROM outreach WHERE replied_at IS NOT NULL`),
    count(db, `SELECT count(*) n FROM emails WHERE needs_review = 1 AND reviewed = 0`),
    count(db, `SELECT count(*) n FROM outreach WHERE status = 'unknown'`),
  ]);
  return { discovered, live, qualified, qualifiedHigh, ready, blocked, failed, applied, confirmed, assessment, interview, offer, rejected,
    outreachSent, replies, review, unknownSends, pending: ready + blocked + failed + review + unknownSends };
}

// ---- Where applications go: the employer's own site (named by its application system), a job site,
// or email; and which companies. Every application counts, from ready to offer.

const PLACES = [
  [/myworkdayjobs\.com/i, 'Workday', 'workday.com'], [/greenhouse\.io/i, 'Greenhouse', 'greenhouse.io'],
  [/lever\.co/i, 'Lever', 'lever.co'], [/ashbyhq\.com/i, 'Ashby', 'ashbyhq.com'], [/bamboohr\.com/i, 'BambooHR', 'bamboohr.com'],
  [/smartrecruiters\.com/i, 'SmartRecruiters', 'smartrecruiters.com'], [/workable\.com/i, 'Workable', 'workable.com'],
  [/foundit\.in/i, 'foundit', 'foundit.in'], [/wellfound\.com/i, 'Wellfound', 'wellfound.com'],
  [/linkedin\.com/i, 'LinkedIn', 'linkedin.com'], [/naukri\.com/i, 'Naukri', 'naukri.com'],
];
const PLATFORMS = { foundit: ['foundit', 'foundit.in'], wellfound: ['Wellfound', 'wellfound.com'], linkedin: ['LinkedIn', 'linkedin.com'], naukri: ['Naukri', 'naukri.com'] };

export function placeOf({ method, url }) {
  if (String(method ?? '').startsWith('email')) return { label: 'Email', domain: null };
  const platform = /^platform:(\w+)/.exec(method ?? '')?.[1];
  if (platform) { const [label, domain] = PLATFORMS[platform] ?? [platform, null]; return { label, domain }; }
  const hit = PLACES.find(([re]) => re.test(url ?? ''));
  return hit ? { label: hit[1], domain: hit[2] } : { label: 'Company website', domain: null };
}

// Short all-letter names are acronyms from portal addresses ("Pwc", "Hpe"): show them as such.
export const displayCompany = (name) => (/^[a-z]{2,3}$/i.test(name ?? '') ? name.toUpperCase() : name);

// The company's own web domain, for its logo, only when there is evidence: the posting lives on the
// company's own site, or the posting names a site whose name is the company's. Otherwise none (initials).
const NOT_COMPANY_HOSTS = /myworkdayjobs|myworkday|greenhouse|lever\.co|ashbyhq|bamboohr|smartrecruiters|workable|foundit|wellfound|linkedin|naukri|indeed|instahyre|internshala|cutshort|mail\.google|google\.com/i;
const registrable = (host) => {
  const p = host.replace(/^www\./, '').split('.');
  return p.length > 2 && /^(co|com|org|net|ac|gov)$/.test(p.at(-2)) && p.at(-1).length === 2 ? p.slice(-3).join('.') : p.slice(-2).join('.');
};
export function companyDomain(company, url, description) {
  const key = String(company ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key.length < 2) return null;
  try { const h = new URL(url).hostname.toLowerCase(); if (!NOT_COMPANY_HOSTS.test(h) && registrable(h).split('.')[0].replace(/-/g, '') === key) return registrable(h); } catch { /* not a URL */ }
  for (const m of String(description ?? '').matchAll(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+)\.(co\.in|com|in|io|ai|org|net|co)\b/gi)) {
    if (m[1].toLowerCase().replace(/-/g, '') === key) return `${m[1]}.${m[2]}`.toLowerCase();
  }
  return null;
}

// The company's logo from the company itself: a Workday career site serves it at /<site>/assets/logo;
// otherwise the favicon of a domain the evidence above ties to the company; otherwise none (initials).
export function companyLogo(company, url, description) {
  try {
    const u = new URL(url);
    if (/\.wd\d+\.myworkdayjobs\.com$/i.test(u.hostname)) {
      const site = u.pathname.split('/').filter(Boolean).find((s) => !/^[a-z]{2}-[A-Z]{2}$/.test(s));
      if (site) return `https://${u.hostname}/${site}/assets/logo`;
    }
  } catch { /* not a URL */ }
  const domain = companyDomain(company, url, description);
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : null;
}
export const placeLogo = (domain) => (domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : null);

export async function applicationPlaces({ top = 5 } = {}) {
  const db = await getDb();
  const rows = await all(db, `SELECT a.method, a.status, j.url, j.company FROM applications a JOIN jobs j ON j.id = a.job_id`);
  const tally = (key) => {
    const m = new Map();
    for (const r of rows) { const k = key(r); const e = m.get(k.label) ?? { ...k, count: 0 }; e.count++; m.set(k.label, e); }
    return [...m.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  const fold = (list) => {
    const rest = list.slice(top);
    return { shown: list.slice(0, top), others: rest.length ? { count: rest.reduce((n, e) => n + e.count, 0), names: rest.length } : null };
  };
  const places = fold(tally(placeOf));
  for (const p of places.shown) p.logo = placeLogo(p.domain);
  const companies = fold(tally((r) => ({ label: r.company })));
  for (const c of companies.shown) {
    const j = await one(db, `SELECT j.url, j.description FROM jobs j JOIN applications a ON a.job_id = j.id WHERE j.company = ? ORDER BY length(coalesce(j.description, '')) DESC LIMIT 1`, [c.label]);
    c.logo = companyLogo(c.label, j?.url, j?.description);
    c.name = displayCompany(c.label);
  }
  return { total: rows.length, places, companies };
}

// The questions that keep applications blocked, each with how many applications it holds up, so one
// answer can be seen to unlock several. Blocked reasons list them after a colon, separated by "; ".
export function blockingQuestions(reasons) {
  const counts = new Map();
  for (const reason of reasons) {
    const m = /^(Needs your answer|No verified answer for|No verified match for|No matching option for):\s*(.+)$/s.exec(reason ?? '');
    if (!m) continue;
    for (const part of m[2].split(/;\s+(?=["A-Z])/)) {
      const q = part.replace(/^"|"$/g, '').replace(/\s*\(offered:.*$/s, '').trim();
      if (q) counts.set(q, (counts.get(q) ?? 0) + 1);
    }
  }
  return [...counts].map(([question, applications]) => ({ question, applications })).sort((a, b) => b.applications - a.applications);
}

export async function pendingQuestions() {
  const db = await getDb();
  const rows = await all(db, `SELECT blocked_reason FROM applications WHERE status = 'blocked' AND blocked_reason IS NOT NULL`);
  return blockingQuestions(rows.map((r) => r.blocked_reason));
}

export async function systemStatus() {
  const db = await getDb();
  const stages = ['discover', 'ai', 'gmail', 'prepare', 'outreach', 'digest'];
  const runs = Object.fromEntries(await Promise.all(stages.map(async (s) => [s, await kvGet(db, `run:${s}`)])));
  const boards = await one(db, `SELECT count(*) n, sum(enabled) enabled, sum(fail_count > 0) failing, sum(origin = 'discovered') discovered FROM boards`);
  return {
    last: await kvGet(db, 'run:last'),
    runs,
    gmail: await kvGet(db, 'gmail:status'),
    gmailLastSync: await kvGet(db, 'gmail:last_sync'),
    aggregator: await kvGet(db, 'aggregator:last_sweep'),
    boards,
    ai: await providerHealth(db),
  };
}

export async function analytics() {
  const db = await getDb();
  const funnel = await one(db, `SELECT
      (SELECT count(*) FROM jobs WHERE status != 'duplicate') discovered,
      (SELECT count(*) FROM jobs WHERE status = 'qualified') qualified,
      (SELECT count(*) FROM applications) prepared,
      (SELECT count(*) FROM applications WHERE status IN (${placeholders(APPLIED)})) applied,
      (SELECT count(*) FROM applications WHERE status IN (${placeholders(HEARD_BACK)})) responded,
      (SELECT count(*) FROM applications WHERE status IN ('interview','offer') OR id IN (SELECT entity_id FROM events WHERE entity = 'application' AND to_status = 'interview')) interviewed,
      (SELECT count(*) FROM applications WHERE status = 'offer') offers`, [...APPLIED, ...HEARD_BACK]);
  const groupBy = (expr) => all(db, `SELECT ${expr} k,
      count(DISTINCT j.id) qualified,
      count(DISTINCT CASE WHEN a.status IN (${placeholders(APPLIED)}) THEN a.id END) applied,
      count(DISTINCT CASE WHEN a.status IN (${placeholders(HEARD_BACK)}) THEN a.id END) responded,
      count(DISTINCT CASE WHEN a.status IN ('interview','offer') THEN a.id END) interviews
    FROM jobs j LEFT JOIN applications a ON a.job_id = j.id WHERE j.status = 'qualified' OR a.id IS NOT NULL
    GROUP BY k ORDER BY applied DESC, qualified DESC LIMIT 15`, [...APPLIED, ...HEARD_BACK]);
  const bySource = await groupBy('j.source');
  const byRole = await groupBy('j.role_category');
  const byResume = await all(db, `SELECT coalesce(a.resume_version, 'unknown') k, count(*) applied,
      sum(a.status IN (${placeholders(HEARD_BACK)})) responded, sum(a.status IN ('interview','offer')) interviews
    FROM applications a WHERE a.status IN (${placeholders(APPLIED)}) GROUP BY k`, [...HEARD_BACK, ...APPLIED]);
  const outreach = await one(db, `SELECT count(*) sent, sum(replied_at IS NOT NULL) replied FROM outreach WHERE status = 'sent' AND kind != 'followup'`);
  const weekly = await all(db, `SELECT substr(submitted_at, 1, 10) d, count(*) n FROM applications WHERE submitted_at >= ? GROUP BY d ORDER BY d`,
    [new Date(Date.now() - 28 * 864e5).toISOString()]);
  return { funnel, bySource, byRole, byResume, outreach, weekly };
}

export async function companyView(name) {
  const db = await getDb();
  const [jobs, apps, contacts, outreach] = await Promise.all([
    all(db, `SELECT id, title, location, status, score, url, first_seen FROM jobs WHERE company = ? AND status != 'duplicate' ORDER BY score DESC`, [name]),
    all(db, `SELECT a.id, a.status, a.submitted_at, j.title FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.company = ?`, [name]),
    all(db, `SELECT * FROM contacts WHERE lower(company) = lower(?)`, [name]),
    all(db, `SELECT o.id, o.kind, o.status, o.sent_at, o.subject, c.email FROM outreach o JOIN contacts c ON c.id = o.contact_id WHERE lower(c.company) = lower(?)`, [name]),
  ]);
  return { jobs, apps, contacts, outreach };
}
