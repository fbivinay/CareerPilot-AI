// Incremental Gmail sync, for CareerPilot's own work only (the candidate's choice, 2026-10-18): classify
// each new message, link it to an application CareerPilot made, apply clear status changes
// automatically, queue ambiguous ones for review, record recruiter contacts and opt-outs, and turn
// job-alert emails into discovered jobs. Mail about applications the candidate made themselves is
// remembered by id only, so it is not fetched again. Idempotent: emails.id is the Gmail id.
// The one exception: the candidate's own job emails and the replies to them are kept for the Email page
// (sent_mail, their choice, 2026-10-20), apart from everything else and never linked to an application.
import { all, audit, kvGet, kvSet, now, one, run } from './db.mjs';
import { aiJson, AiUnavailable } from './ai.mjs';
import { CAREERPILOT_APP, transition } from './applications.mjs';
import { alertPlatform, applicationDetails, classifyEmail, extractDetails, isJobEmail, laterReply, parseJobAlert, platformSender, unwrap } from './email-intel.mjs';
import { upsertJob } from './jobs.mjs';
import { domainMatchesCompany, upsertContact } from './contacts.mjs';
import { recordBounce } from './outreach.mjs';
import { log } from './log.mjs';

const CATEGORY_STATUS = {
  application_confirmation: 'confirmed',
  assessment: 'assessment',
  interview: 'interview',
  rejection: 'rejected',
  offer: 'offer',
};
// Mail that names its own posting: one CareerPilot did not apply to is about a different application,
// even at a company where it did (see linkEmail).
const NAMES_POSTING = new Set(['application_confirmation', 'assessment', 'interview']);
const AUTO_CONFIDENCE = 0.85;
const NOREPLY = /^(no-?reply|do-?not-?reply|notifications?|jobs?|careers?|talent|recruiting|hr|hiring|info|alerts?|mailer-daemon|postmaster)[-.+@]/i;
const GENERIC_DOMAINS = /@(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|proton(mail)?|rediffmail|ymail)\./i;

const companyKey = (c) => String(c ?? '').toLowerCase()
  .replace(/\b(inc|llc|ltd|limited|pvt|private|technologies|technology|labs|software|solutions|india|corp|corporation|co)\b\.?/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

export function mentionsCompany(hay, company) {
  const k = companyKey(company);
  if (k.length < 3) return false;
  return new RegExp(`(^|[^a-z0-9])${k.replace(/ /g, '[^a-z0-9]?')}([^a-z0-9]|$)`).test(hay);
}

const host = (u) => { try { return new URL(u).host; } catch { return null; } };
// A job board's name can carry a suffix the employer's own mail leaves out: headoutcareers is Headout (2026-10-20).
const boardKey = (c) => companyKey(c).replace(/ /g, '').replace(/(careers?|jobs?)$/, '');
const sameCompany = (x, y) => {
  const a = companyKey(x), b = companyKey(y), k = boardKey(x);
  return a.length >= 3 && b.length >= 3 && (a === b || mentionsCompany(a, y) || mentionsCompany(b, x) || (k.length >= 3 && k === boardKey(y)));
};
// Whether a tracked job is the posting a confirmation names. Two postings on one job site are different
// even with the same title (foundit lists "Analyst I" at Aon under two ids).
function samePosting(job, stated) {
  if (stated.url && job.url === stated.url) return true;
  if (stated.url && job.url && host(job.url) === host(stated.url)) return false;
  if (!stated.company || !sameCompany(job.company, stated.company)) return false;
  return !stated.title || job.title.toLowerCase() === stated.title.toLowerCase();
}

// Workday mail names the employer's portal: <tenant>@myworkday.com (amgen@myworkday.com for
// amgen.wd1.myworkdayjobs.com), or a domain named after the tenant. Among that portal's submitted
// applications it is the one named by requisition id or exact title, the only one, or, for mail that
// names neither (HPE's "Thank you for your online submission"), the one submitted just before it arrived.
// Mail from Workday under another name of the employer (workday@sciplay.com for Light & Wonder's lnw
// portal) needs the exact title and a submission just before it. Linking is not trust: a status changes
// on its own only for mail from @myworkday.com or the company's own domain (see processMessage).
const SUBMITTED = new Set(['submitted', 'confirmed', 'assessment', 'interview', 'offer', 'rejected']);
const tenantOf = (url) => { const h = host(url) ?? ''; return /\.myworkdayjobs\.com$/i.test(h) ? h.split('.')[0].toLowerCase() : null; };
const reqIdOf = (url) => { const m = /_([a-z]*-?\d[\w-]*)\/?$/i.exec(url ?? ''); return m && m[1].length >= 5 ? m[1].toLowerCase() : null; };
export function workdayLink(apps, msg) {
  const [local = '', domain = ''] = String(msg.fromAddr ?? '').toLowerCase().split('@');
  const sender = domain === 'myworkday.com' ? local : domain.split('.').slice(-2)[0];
  const submitted = apps.filter((a) => SUBMITTED.has(a.status) && tenantOf(a.url));
  const hay = `${msg.subject ?? ''}\n${unwrap(msg.text)}`.toLowerCase();
  const at = new Date(msg.date ?? 0).getTime();
  const one = (list, how) => (list.length === 1 ? { ...list[0], how } : null);
  // The longest title the mail names ("Data Scientist / Data Engineer" over "Data Scientist").
  const titled = (list) => { const hit = list.filter((a) => hay.includes(a.title.toLowerCase())); const n = Math.max(0, ...hit.map((a) => a.title.length)); return hit.filter((a) => a.title.length === n); };
  // The confirmation is sent once the submission is recorded: seconds after it, never before.
  const justBefore = (list) => list.filter((a) => { const t = new Date(a.submitted_at ?? 0).getTime(); return t <= at + 5_000 && at - t <= 15 * 60_000; })
    .sort((x, y) => new Date(y.submitted_at) - new Date(x.submitted_at)).slice(0, 1);
  const mine = submitted.filter((a) => tenantOf(a.url) === sender);
  if (mine.length) {
    return one(mine.filter((a) => { const r = reqIdOf(a.url); return r && hay.includes(r); }), 'workday req id')
      ?? one(titled(mine), 'workday title') ?? one(mine, 'workday portal') ?? one(justBefore(mine), 'workday time')
      ?? { ambiguous: true, company: mine[0].company, how: 'several roles at portal' };
  }
  return domain === 'myworkday.com' || local === 'workday' ? one(justBefore(titled(submitted)), 'workday title+time') : null;
}

// A hiring platform's mail names the employer as it calls itself, which can be just the start of the board
// name CareerPilot knows it by (Greenhouse's "Mico" for the micoworks board, 2026-10-20): among the
// applications on that platform, the one whose company starts with that name is meant.
// ponytail: a name prefix on one platform; keep each board's display name if two employers ever collide.
const PLATFORM_BOARDS = [[/(^|\.)greenhouse(-mail)?\.io$/i, 'greenhouse.io'], [/(^|\.)lever\.co$/i, 'lever.co'], [/(^|\.)ashbyhq\.com$/i, 'ashbyhq.com']];
const onDomain = (h, d) => h === d || String(h ?? '').endsWith(`.${d}`);
function boardNamed(apps, msg, stated) {
  const board = platformSender(msg.fromAddr) && PLATFORM_BOARDS.find(([re]) => re.test(String(msg.fromAddr ?? '').split('@')[1] ?? ''))?.[1];
  const k = companyKey(stated.company).replace(/ /g, '');
  if (!board || k.length < 3) return null;
  const hits = apps.filter((a) => onDomain(host(a.url), board) && companyKey(a.company).replace(/ /g, '').startsWith(k));
  return hits.length === 1 ? { ...hits[0], how: 'platform name' } : hits.length ? { ambiguous: true, company: hits[0].company, how: 'several boards on platform' } : null;
}

async function linkEmail(db, msg, { stated = applicationDetails(msg), strict = false } = {}) {
  const byThread = await one(db, `SELECT a.id app_id, a.job_id FROM applications a WHERE a.gmail_thread_id = ? AND ${CAREERPILOT_APP}`, [msg.threadId])
    ?? await one(db, `SELECT o.job_id, a.id app_id FROM outreach o LEFT JOIN applications a ON a.job_id = o.job_id
      WHERE o.gmail_thread_id = ? AND o.job_id IS NOT NULL LIMIT 1`, [msg.threadId]);
  if (byThread) return { ...byThread, how: 'thread' };

  const apps = await all(db, `SELECT a.id app_id, a.job_id, a.status, a.submitted_at, j.company, j.title, j.url FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.status != 'withdrawn' AND ${CAREERPILOT_APP}`);
  const byPortal = workdayLink(apps, msg);
  if (byPortal) return byPortal;
  // A confirmation or invite that names its posting is matched on that, not on every company the body
  // mentions: foundit mails also advertise other employers' jobs.
  if (stated.company || stated.url) {
    const named = apps.filter((a) => samePosting(a, stated));
    if (named.length === 1) return { ...named[0], how: 'stated' };
    if (named.length) return { ambiguous: true, company: named[0].company, how: 'several roles at company' };
    const onBoard = boardNamed(apps, msg, stated);
    if (onBoard) return onBoard;
    // A confirmation naming a posting CareerPilot did not apply to is about another application (perhaps
    // the candidate's own); a rejection or update naming a slightly different title still falls back to
    // the company below.
    if (strict) return null;
  }

  // Job-board mail and bulk mail (newsletters, promotions: they carry List-Unsubscribe) are full of other
  // companies' names, so only their sender and subject say which company they are about.
  const body = alertPlatform(msg.fromAddr) || msg.listUnsubscribe ? '' : (msg.text ?? '').slice(0, 3000);
  const hay = `${msg.fromName} ${msg.fromAddr.split('@')[1] ?? ''} ${msg.subject} ${body}`.toLowerCase();
  const hits = apps.filter((a) => mentionsCompany(hay, a.company));
  const companies = new Set(hits.map((h) => companyKey(h.company)));
  if (companies.size !== 1) return companies.size > 1 ? { ambiguous: true, how: 'multiple companies' } : null;
  if (hits.length === 1) return { ...hits[0], how: 'company' };
  const byTitle = hits.filter((h) => hay.includes(h.title.toLowerCase()));
  return byTitle.length === 1 ? { ...byTitle[0], how: 'company+title' } : { ambiguous: true, company: hits[0].company, how: 'several roles at company' };
}

async function aiClassify(db, msg, settings) {
  try {
    return await aiJson(db, {
      name: 'email-classify',
      tier: 'fast',
      dataClass: 'email',
      system: 'You classify job-search emails. Reply with JSON only: {"category": one of "application_confirmation","assessment","interview","rejection","offer","recruiter_reply","job_alert","other", "confidence": number 0-1, "next_step": short string or ""}. Use only what the email says.',
      user: `From: ${msg.fromName} <${msg.fromAddr}>\nSubject: ${msg.subject}\n\n${(msg.text ?? '').slice(0, 4000)}`,
      shape: { category: 'string', confidence: 'number' },
      maxTokens: 200,
    }, { settings });
  } catch (err) {
    if (err instanceof AiUnavailable) return null;
    throw err;
  }
}

// A reply in the conversation of one of the candidate's own job emails becomes that email's reply
// (laterReply). Nothing else happens: they are not CareerPilot's applications.
async function recordReply(db, msg) {
  const row = await one(db, 'SELECT sent_at, reply_category, reply_at FROM sent_mail WHERE thread_id = ?', [msg.threadId]);
  if (!row || !msg.date || msg.date <= row.sent_at) return;
  const reply = { category: classifyEmail(msg, { ourThreadIds: new Set([msg.threadId]) }).category, at: msg.date };
  if (laterReply(row.reply_category && { category: row.reply_category, at: row.reply_at }, reply) !== reply) return;
  await run(db, 'UPDATE sent_mail SET reply_category = ?, reply_at = ?, reply_from = ? WHERE thread_id = ?',
    [reply.category, reply.at, msg.fromName || msg.fromAddr || null, msg.threadId]);
}

export async function processMessage(db, msg, settings, { ourThreadIds, userThreadIds = new Set() }) {
  if (await one(db, 'SELECT 1 FROM emails WHERE id = ?', [msg.id])) return { skipped: true };
  if (userThreadIds.has(msg.threadId)) {
    await recordReply(db, msg);
    await run(db, `INSERT INTO emails (id, category, processed_at) VALUES (?, 'ignored', ?)`, [msg.id, now()]);
    return { category: 'own_reply', jobs: 0, transitioned: false, review: false };
  }
  let cls = classifyEmail(msg, { ourThreadIds });
  let classifiedBy = 'rules';
  const details = extractDetails(msg);
  let link = null;
  const result = { category: cls.category, jobs: 0, transitioned: false, review: false };

  if (cls.category === 'job_alert') {
    const parsed = parseJobAlert(msg);
    for (const j of parsed) {
      const r = await upsertJob(db, { ...j, company: j.company || `Unknown (${cls.platform})` }, { source: `alert:${cls.platform}`, settings });
      if (r?.created) result.jobs++;
    }
    if (!parsed.length) log.warn('job alert had no parseable job links', { platform: cls.platform });
  } else if (cls.category === 'bounce') {
    // Only Google's own, authenticated delivery-failure notice in the thread of a message we sent counts;
    // a look-alike "bounce" from anyone else could otherwise block contacts or fail applications.
    const genuine = msg.authenticated && /@(googlemail|google)\.com$/i.test(msg.fromAddr ?? '');
    const sent = genuine ? await recordBounce(db, { threadId: msg.threadId, emailId: msg.id }) : null;
    if (sent?.job_id) {
      const app = await one(db, 'SELECT id FROM applications WHERE job_id = ?', [sent.job_id]);
      link = { app_id: app?.id ?? null, job_id: sent.job_id, how: 'bounce' };
    }
    // A bounce we cannot match to anything we sent needs a look when it is in a thread CareerPilot started.
    result.review = !sent && ourThreadIds.has(msg.threadId);
  } else if (alertPlatform(msg.fromAddr)) {
    // Other job-site mail is about the candidate's own applications there: CareerPilot never applies
    // through job sites, so it is not linked to anything.
  } else {
    link = await linkEmail(db, msg, { strict: NAMES_POSTING.has(cls.category) });
    // A rule that is sure (a code to finish submitting) is not second-guessed by the AI.
    if ((cls.category === 'other' || cls.category === 'ats_update') && cls.confidence < 0.9 && link?.app_id) {
      const ai = await aiClassify(db, msg, settings);
      if (ai && ai.category !== 'other') { cls = { category: ai.category, confidence: Math.min(ai.confidence, 0.84) }; classifiedBy = `ai:${ai._provider}`; }
    }
    result.category = cls.category;

    const target = CATEGORY_STATUS[cls.category];
    if (target && link?.app_id) {
      const app = await one(db, 'SELECT a.*, j.company FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?', [link.app_id]);
      // Status changes only from mail we can trust: a reply in a thread we started, or mail that passed
      // Gmail's DMARC/DKIM check and comes from a hiring platform or the company's own domain. Offers
      // are always confirmed by the candidate.
      // (Workday mail from @myworkday.com is a platform sender. Mail linked through a domain merely named like
      // a tenant or brand — workday@sciplay.com — is linked, but only reviewed: anyone can register such a domain.)
      const trusted = link.how === 'thread' || (msg.authenticated && (platformSender(msg.fromAddr) || domainMatchesCompany(msg.fromAddr, app.company ?? link.company ?? '')));
      if (trusted && target !== 'offer' && cls.confidence >= AUTO_CONFIDENCE && !link.ambiguous) {
        result.transitioned = await transition(db, app, target, {
          evidence: { type: 'email', emailId: msg.id, threadId: msg.threadId, subject: msg.subject, from: msg.fromAddr },
          reason: `${cls.category} email (${classifiedBy}, ${cls.confidence})`, at: msg.date,
        });
      } else result.review = true;
    } else if (target && link) result.review = true; // several of CareerPilot's applications could be meant

    if (cls.category === 'recruiter_reply' || cls.category === 'opt_out' || target) {
      await run(db, `UPDATE outreach SET replied_at = COALESCE(replied_at, ?) WHERE gmail_thread_id = ?`, [msg.date, msg.threadId]);
    }
    if (cls.category === 'opt_out') {
      await run(db, 'UPDATE contacts SET opted_out = 1 WHERE email = ?', [msg.fromAddr]);
      await audit(db, 'contact', msg.fromAddr, 'opted_out', { detail: { emailId: msg.id } });
    }
    // A real person writing about an application, from the company's own domain, in our thread or with
    // passing DMARC/DKIM, becomes a verified contact.
    if (link?.job_id && !NOREPLY.test(msg.fromAddr) && !GENERIC_DOMAINS.test(msg.fromAddr) && cls.category !== 'opt_out'
      && (link.how === 'thread' || msg.authenticated)) {
      const job = await one(db, 'SELECT company FROM jobs WHERE id = ?', [link.job_id]);
      if (job && domainMatchesCompany(msg.fromAddr, job.company)) {
        await upsertContact(db, { email: msg.fromAddr, name: msg.fromName, company: job.company, sourceType: 'inbound_email', sourceRef: msg.id, domainMatch: true });
      }
    }
  }

  // Kept: mail about CareerPilot's applications or in its threads, and job alerts (they feed discovery).
  const keep = link || result.review || cls.category === 'job_alert' || ourThreadIds.has(msg.threadId);
  await storeEmail(db, msg, cls, { link, details, classifiedBy, review: result.review, keep });
  return result;
}

async function storeEmail(db, msg, cls, { link, details, classifiedBy, review, keep }) {
  if (keep && (cls.category !== 'other' || link?.app_id)) {
    await run(db, `INSERT INTO emails (id, thread_id, from_addr, from_name, subject, snippet, received_at, category, confidence, classified_by,
        company, job_id, application_id, extracted, needs_review, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.threadId ?? null, msg.fromAddr ?? null, msg.fromName ?? null, msg.subject ?? null, (msg.snippet ?? '').slice(0, 240), msg.date ?? null, cls.category, cls.confidence,
      classifiedBy, link?.company ?? null, link?.job_id ?? null, link?.app_id ?? null, JSON.stringify({ ...details, link: link?.how ?? null }),
      review ? 1 : 0, now()]);
  } else {
    // Other mail is remembered only by id so it is not fetched again; no content is stored.
    await run(db, `INSERT INTO emails (id, category, processed_at) VALUES (?, 'ignored', ?)`, [msg.id, now()]);
  }
}

// The candidate's own job emails, for the Email page: the first one they sent in each conversation. Not
// CareerPilot's sends (the outreach table has those), nor mail to themselves (CareerPilot's alerts), nor a
// conversation CareerPilot started; other sent mail is remembered by id only. Replies that came before an
// email was first seen are read from its conversation; later ones arrive through processMessage.
async function syncSent(db, gmail, { me, after, max, deadline, ourThreadIds }) {
  const ids = await gmail.listIds(`after:${after} in:sent`, max);
  const marks = ids.map(() => '?').join(',') || "''";
  // Only what this pass kept or set aside: an email the version that logged the candidate's own applications
  // recorded (category sent_application, before 2026-10-18) is looked at again.
  const known = new Set((await all(db, `SELECT id FROM emails WHERE id IN (${marks}) AND category = 'ignored'
    UNION SELECT id FROM sent_mail WHERE id IN (${marks})`, [...ids, ...ids])).map((r) => r.id));
  // CareerPilot's sends, by Gmail id, or by subject and recipient for one interrupted before its id was kept.
  const ours = new Set((await all(db, 'SELECT o.gmail_message_id id, o.subject, lower(c.email) email FROM outreach o JOIN contacts c ON c.id = o.contact_id'))
    .flatMap((r) => [r.id, `${r.subject}\n${r.email}`]));
  const result = { tracked: 0, newest: null, cut: false };
  for (const id of [...ids].reverse()) { // oldest first, so a conversation's first email is the one kept
    if (known.has(id) || ours.has(id)) continue;
    if (Date.now() > deadline) { result.cut = true; break; }
    const msg = await gmail.get(id);
    if (msg.date && (!result.newest || msg.date > result.newest)) result.newest = msg.date;
    const raw = String(msg.to ?? '');
    const to = raw.match(/[^\s<>",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+/i)?.[0].toLowerCase() ?? ''; // the first recipient
    const toName = raw.includes('<') ? raw.split('<')[0].replace(/"/g, '').trim() : '';
    if (to && to !== me && isJobEmail(msg.subject) && !ourThreadIds.has(msg.threadId) && !ours.has(`${msg.subject}\n${to}`)
      && !(await one(db, 'SELECT 1 FROM sent_mail WHERE thread_id = ?', [msg.threadId]))) {
      await run(db, 'INSERT INTO sent_mail (id, thread_id, to_addr, to_name, subject, sent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, msg.threadId, to, toName && !toName.includes('@') ? toName : null, msg.subject, msg.date, now()]);
      result.tracked++;
      for (const m of await gmail.thread(msg.threadId)) if (!m.labelIds?.includes('SENT')) await recordReply(db, await gmail.get(m.id));
    } else await run(db, `INSERT OR IGNORE INTO emails (id, category, processed_at) VALUES (?, 'ignored', ?)`, [id, now()]);
  }
  return result;
}

// A lease in kv: free when its time has passed, so one held by a run that died frees itself.
async function takeLease(db, ms) {
  const t = now();
  const r = await run(db, `INSERT INTO kv (key, value, updated_at) VALUES ('lock:gmail', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE kv.value < ?`,
  [JSON.stringify(new Date(Date.now() + ms).toISOString()), t, JSON.stringify(t)]);
  return r.rowsAffected > 0;
}

// Gmail push (the candidate's choice, 2026-10-20): Gmail tells a Pub/Sub topic about new mail, Pub/Sub tells
// the dashboard (/api/gmail/push), and the dashboard starts careerpilot-gmail.yml. A watch lasts 7 days, so
// it is renewed once a day, and at once after it failed. The error stays in kv, out of the public log.
async function renewWatch(db, gmail, topic) {
  const w = await kvGet(db, 'gmail:watch');
  if (w?.topic === topic && !w.error && Date.now() - Date.parse(w.at) < 864e5) return;
  try {
    const r = await gmail.watch(topic);
    await kvSet(db, 'gmail:watch', { topic, at: now(), expiration: new Date(Number(r.expiration)).toISOString() });
  } catch (err) {
    log.warn('Gmail push watch failed', { error: String(err.message).split(':')[0] });
    await kvSet(db, 'gmail:watch', { topic, at: now(), error: String(err.message).slice(0, 300) });
  }
}

// One Gmail sync at a time: the pipeline's and one a Gmail push started can overlap, and both would process
// the same new mail. A sync that finds the lease taken waits up to `waitMs` for it.
export async function syncGmail(db, gmail, settings, { waitMs = 120_000, pushTopic = null, ...opts } = {}) {
  for (const start = Date.now(); !(await takeLease(db, 10 * 60_000));) {
    if (Date.now() - start >= waitMs) return { skipped: 'another Gmail sync is running' };
    await new Promise((r) => setTimeout(r, 5_000));
  }
  try {
    if (pushTopic) await renewWatch(db, gmail, pushTopic);
    return await syncMail(db, gmail, settings, opts);
  } finally {
    await kvSet(db, 'lock:gmail', new Date(0).toISOString());
  }
}

// `me` is the connected Gmail address: without it the sent folder is not read, since CareerPilot's alerts
// to the candidate would look like job emails.
async function syncMail(db, gmail, settings, { lookbackDays = 30, max = 5000, deadline = Infinity, me = null } = {}) {
  const since = (last) => (last ? Math.floor(new Date(last).getTime() / 1000) - 3600 : Math.floor(Date.now() / 1000) - lookbackDays * 86400);
  const ourThreadIds = new Set((await all(db, `SELECT gmail_thread_id t FROM outreach WHERE gmail_thread_id IS NOT NULL
    UNION SELECT a.gmail_thread_id FROM applications a WHERE a.gmail_thread_id IS NOT NULL AND ${CAREERPILOT_APP}`)).map((r) => r.t));
  const sent = me ? await syncSent(db, gmail, { me: me.toLowerCase(), after: since(await kvGet(db, 'gmail:last_sent_sync')), max, deadline, ourThreadIds }) : null;
  if (sent?.newest && !sent.cut) await kvSet(db, 'gmail:last_sent_sync', sent.newest);
  const userThreadIds = new Set((await all(db, 'SELECT thread_id t FROM sent_mail')).map((r) => r.t));

  const last = await kvGet(db, 'gmail:last_sync');
  // Gmail lists newest first, so a capped list silently skips the oldest mail: list everything since the
  // checkpoint (max is only a safety bound) and let the deadline limit the processing. Every tab is read;
  // Promotions and Social occasionally hold real job mail.
  const ids = await gmail.listIds(`after:${since(last)} -in:sent -in:chats -in:drafts`, max);
  const known = new Set((await all(db, `SELECT id FROM emails WHERE id IN (${ids.map(() => '?').join(',') || "''"})`, ids)).map((r) => r.id));
  const stats = { listed: ids.length, processed: 0, alerts: 0, jobsFromAlerts: 0, transitions: 0, review: 0, sentTracked: sent?.tracked ?? 0 };
  let newest = last;
  let cut = false;
  for (const id of [...ids].reverse()) {
    if (known.has(id)) continue;
    if (Date.now() > deadline) { cut = true; break; }
    const msg = await gmail.get(id);
    const r = await processMessage(db, msg, settings, { ourThreadIds, userThreadIds });
    stats.processed++;
    if (r.category === 'job_alert') { stats.alerts++; stats.jobsFromAlerts += r.jobs; }
    if (r.transitioned) stats.transitions++;
    if (r.review) stats.review++;
    if (msg.date && (!newest || msg.date > newest)) newest = msg.date;
  }
  // A run cut short keeps the old checkpoint; already-processed ids are skipped next time.
  if (newest && !cut) await kvSet(db, 'gmail:last_sync', newest);
  await kvSet(db, 'gmail:status', { ok: true, at: now() });
  return stats;
}

export { linkEmail };
