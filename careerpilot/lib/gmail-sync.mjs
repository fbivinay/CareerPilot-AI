// Incremental Gmail sync: classify each new message, link it to an application, apply clear
// status changes automatically, queue ambiguous ones for review, record recruiter contacts and
// opt-outs, turn job-alert emails into discovered jobs, and record applications the candidate made
// elsewhere (platform confirmations, assessment invites, their own sent application emails).
// Idempotent: emails.id is the Gmail id.
import { all, audit, kvGet, kvSet, now, one, run } from './db.mjs';
import { aiJson, AiUnavailable } from './ai.mjs';
import { createApplication, transition } from './applications.mjs';
import { alertPlatform, applicationDetails, classifyEmail, extractDetails, parseJobAlert, platformSender, sentApplication } from './email-intel.mjs';
import { upsertJob } from './jobs.mjs';
import { domainMatchesCompany, upsertContact } from './contacts.mjs';
import { parseFrom } from './gmail.mjs';
import { recordBounce } from './outreach.mjs';
import { log } from './log.mjs';

const CATEGORY_STATUS = {
  application_confirmation: 'confirmed',
  assessment: 'assessment',
  interview: 'interview',
  rejection: 'rejected',
  offer: 'offer',
};
// Categories that may create a tracked application when nothing matches yet. Rejections and offers
// for something we have no record of go to review instead.
const CREATES_APPLICATION = new Set(['application_confirmation', 'assessment', 'interview']);
const AUTO_CONFIDENCE = 0.85;
const NOREPLY = /^(no-?reply|do-?not-?reply|notifications?|jobs?|careers?|talent|recruiting|hr|hiring|info|alerts?|mailer-daemon|postmaster)[-.+@]/i;
const GENERIC_DOMAINS = /@(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|proton(mail)?|rediffmail|ymail)\./i;
const mailLink = (id) => `https://mail.google.com/mail/u/0/#all/${id}`;

const companyKey = (c) => String(c ?? '').toLowerCase()
  .replace(/\b(inc|llc|ltd|limited|pvt|private|technologies|technology|labs|software|solutions|india|corp|corporation|co)\b\.?/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

export function mentionsCompany(hay, company) {
  const k = companyKey(company);
  if (k.length < 3) return false;
  return new RegExp(`(^|[^a-z0-9])${k.replace(/ /g, '[^a-z0-9]?')}([^a-z0-9]|$)`).test(hay);
}

const host = (u) => { try { return new URL(u).host; } catch { return null; } };
const sameCompany = (x, y) => {
  const a = companyKey(x), b = companyKey(y);
  return a.length >= 3 && b.length >= 3 && (a === b || mentionsCompany(a, y) || mentionsCompany(b, x));
};
// Whether a tracked job is the posting a confirmation names. Two postings on one job site are different
// even with the same title (foundit lists "Analyst I" at Aon under two ids).
function samePosting(job, stated) {
  if (stated.url && job.url === stated.url) return true;
  if (stated.url && job.url && host(job.url) === host(stated.url)) return false;
  if (!stated.company || !sameCompany(job.company, stated.company)) return false;
  return !stated.title || job.title.toLowerCase() === stated.title.toLowerCase();
}

async function linkEmail(db, msg, { stated = applicationDetails(msg), creates = false } = {}) {
  const byThread = await one(db, `SELECT a.id app_id, a.job_id FROM applications a WHERE a.gmail_thread_id = ?`, [msg.threadId])
    ?? await one(db, `SELECT o.job_id, a.id app_id FROM outreach o LEFT JOIN applications a ON a.job_id = o.job_id
      WHERE o.gmail_thread_id = ? AND o.job_id IS NOT NULL LIMIT 1`, [msg.threadId]);
  if (byThread) return { ...byThread, how: 'thread' };

  const apps = await all(db, `SELECT a.id app_id, a.job_id, j.company, j.title, j.url FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.status != 'withdrawn'`);
  // A confirmation or invite that names its posting is matched on that, not on every company the body
  // mentions: foundit mails also advertise other employers' jobs.
  if (stated.company || stated.url) {
    const named = apps.filter((a) => samePosting(a, stated));
    if (named.length === 1) return { ...named[0], how: 'stated' };
    if (named.length) return { ambiguous: true, company: named[0].company, how: 'several roles at company' };
    // A confirmation for a posting we do not track yet becomes its own application (recordExternalApplication);
    // a rejection or update naming a slightly different title still falls back to the company below.
    if (creates) return null;
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

// An application the candidate made outside CareerPilot, evidenced by trusted mail: find the matching
// job if we track it, otherwise record the job from the email itself.
async function recordExternalApplication(db, msg, cls, settings) {
  const d = applicationDetails(msg);
  const platform = alertPlatform(msg.fromAddr);
  if (!msg.authenticated || !(platformSender(msg.fromAddr) || (d.company && domainMatchesCompany(msg.fromAddr, d.company)))) return null;
  if (!d.company && !d.title) return null;
  const first = companyKey(d.company).split(' ')[0] ?? '';
  const candidates = await all(db, `SELECT id, company, title, url FROM jobs WHERE status != 'duplicate' AND (url = ? OR lower(company) LIKE ?)`,
    [d.url ?? '', first.length >= 3 ? `%${first}%` : '']);
  const job = candidates.find((j) => samePosting(j, d));
  const jobId = job?.id ?? (await upsertJob(db, {
    url: d.url ?? mailLink(msg.id),
    title: d.title ?? `${cls.category === 'assessment' ? 'Assessment' : 'Application'} (from email)`,
    company: d.company ?? `Confidential employer${platform ? ` (${platform})` : ''}`,
    location: '',
  }, { source: platform ? `email:${platform}` : 'email', settings }))?.id;
  if (!jobId) return null;
  const app = await createApplication(db, jobId, { status: 'ready', method: platform ? `platform:${platform}` : 'external' });
  return { app_id: app.id, job_id: jobId, company: d.company, how: 'trusted confirmation' };
}

export async function processMessage(db, msg, settings, { ourThreadIds }) {
  if (await one(db, 'SELECT 1 FROM emails WHERE id = ?', [msg.id])) return { skipped: true };
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
    result.review = !sent; // a bounce we cannot match to anything we sent needs a look
  } else {
    link = await linkEmail(db, msg, { creates: CREATES_APPLICATION.has(cls.category) });
    if ((cls.category === 'other' || cls.category === 'ats_update') && (link?.app_id || cls.category === 'ats_update')) {
      const ai = await aiClassify(db, msg, settings);
      if (ai && ai.category !== 'other') { cls = { category: ai.category, confidence: Math.min(ai.confidence, 0.84) }; classifiedBy = `ai:${ai._provider}`; }
    }
    result.category = cls.category;

    // A confirmation, assessment or interview for something applied to elsewhere: record the application.
    if (!link && CREATES_APPLICATION.has(cls.category) && cls.confidence >= AUTO_CONFIDENCE) {
      link = await recordExternalApplication(db, msg, cls, settings);
    }

    const target = CATEGORY_STATUS[cls.category];
    if (target && link?.app_id) {
      const app = await one(db, 'SELECT a.*, j.company FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?', [link.app_id]);
      // Status changes only from mail we can trust: a reply in a thread we started, or mail that passed
      // Gmail's DMARC/DKIM check and comes from a hiring platform or the company's own domain. Offers
      // are always confirmed by the candidate.
      const trusted = link.how === 'thread' || (msg.authenticated && (platformSender(msg.fromAddr) || domainMatchesCompany(msg.fromAddr, app.company ?? link.company ?? '')));
      if (trusted && target !== 'offer' && cls.confidence >= AUTO_CONFIDENCE && !link.ambiguous) {
        result.transitioned = await transition(db, app, target, {
          evidence: { type: 'email', emailId: msg.id, threadId: msg.threadId, subject: msg.subject, from: msg.fromAddr },
          reason: `${cls.category} email (${classifiedBy}, ${cls.confidence})`, at: msg.date,
        });
      } else result.review = true;
    } else if (target) result.review = true;

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

  await storeEmail(db, msg, cls, { link, details, classifiedBy, review: result.review });
  return result;
}

async function storeEmail(db, msg, cls, { link, details, classifiedBy, review }) {
  if (cls.category !== 'other' || link?.app_id) {
    await run(db, `INSERT INTO emails (id, thread_id, from_addr, from_name, subject, snippet, received_at, category, confidence, classified_by,
        company, job_id, application_id, extracted, needs_review, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.threadId ?? null, msg.fromAddr ?? null, msg.fromName ?? null, msg.subject ?? null, (msg.snippet ?? '').slice(0, 240), msg.date ?? null, cls.category, cls.confidence,
      classifiedBy, link?.company ?? null, link?.job_id ?? null, link?.app_id ?? null, JSON.stringify({ ...details, link: link?.how ?? null }),
      review ? 1 : 0, now()]);
  } else {
    // Irrelevant mail is remembered only by id so it is not fetched again; no content is stored.
    await run(db, `INSERT INTO emails (id, category, processed_at) VALUES (?, 'ignored', ?)`, [msg.id, now()]);
  }
}

// The candidate's own application emails are proof of submission. Messages CareerPilot sent itself are
// already tracked through the outreach table and are skipped here.
export async function processSentMessage(db, msg, settings, { selfAddress }) {
  if (await one(db, 'SELECT 1 FROM emails WHERE id = ?', [msg.id])) return { skipped: true };
  const ours = await one(db, 'SELECT 1 FROM outreach WHERE gmail_message_id = ?', [msg.id]);
  const to = parseFrom(String(msg.to ?? '').split(',')[0]).addr;
  const sent = !ours && to && to !== selfAddress?.toLowerCase() ? sentApplication(msg) : null;
  if (!sent) {
    await run(db, `INSERT INTO emails (id, category, processed_at) VALUES (?, 'ignored', ?)`, [msg.id, now()]);
    return { recorded: false };
  }
  const domain = to.split('@')[1];
  const company = GENERIC_DOMAINS.test(to) ? `via ${to}` : domain.split('.').slice(-2, -1)[0].replace(/\b\w/g, (c) => c.toUpperCase());
  const job = await upsertJob(db, { url: mailLink(msg.id), title: sent.title ?? msg.subject, company, location: '' }, { source: 'email:sent', settings });
  const app = await createApplication(db, job.id, { status: 'ready', method: 'email:manual' });
  await run(db, 'UPDATE applications SET gmail_thread_id = COALESCE(gmail_thread_id, ?) WHERE id = ?', [msg.threadId, app.id]);
  await transition(db, app, 'submitted', { evidence: { type: 'gmail_sent', gmailId: msg.id, threadId: msg.threadId, recipient: to },
    reason: 'application email sent by you', by: 'candidate', at: msg.date });
  await storeEmail(db, msg, { category: 'sent_application', confidence: 1 }, { link: { app_id: app.id, job_id: job.id, company, how: 'sent' },
    details: extractDetails(msg), classifiedBy: 'rules', review: false });
  return { recorded: true };
}

export async function syncGmail(db, gmail, settings, { lookbackDays = 30, max = 5000, deadline = Infinity, selfAddress } = {}) {
  const last = await kvGet(db, 'gmail:last_sync');
  const after = last ? Math.floor(new Date(last).getTime() / 1000) - 3600 : Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  // Gmail lists newest first, so a capped list silently skips the oldest mail: list everything since the
  // checkpoint (max is only a safety bound) and let the deadline limit the processing. Every tab is read;
  // Promotions and Social occasionally hold real job mail.
  const ids = await gmail.listIds(`after:${after} -in:sent -in:chats -in:drafts`, max);
  const sentIds = await gmail.listIds(`after:${after} in:sent`, max);
  const all_ = [...ids, ...sentIds];
  const known = new Set((await all(db, `SELECT id FROM emails WHERE id IN (${all_.map(() => '?').join(',') || "''"})`, all_)).map((r) => r.id));
  const ourThreadIds = new Set((await all(db, `SELECT gmail_thread_id t FROM outreach WHERE gmail_thread_id IS NOT NULL
    UNION SELECT gmail_thread_id FROM applications WHERE gmail_thread_id IS NOT NULL`)).map((r) => r.t));
  const stats = { listed: ids.length, sentListed: sentIds.length, processed: 0, alerts: 0, jobsFromAlerts: 0, transitions: 0, review: 0, sentApplications: 0 };
  let newest = last;
  let cut = false;
  // Sent mail first, so replies arriving in the same run already find the application by thread.
  for (const id of [...sentIds].reverse()) {
    if (known.has(id)) continue;
    if (Date.now() > deadline) { cut = true; break; }
    const msg = await gmail.get(id);
    const r = await processSentMessage(db, msg, settings, { selfAddress });
    if (r.recorded) { stats.sentApplications++; if (msg.threadId) ourThreadIds.add(msg.threadId); }
    if (msg.date && (!newest || msg.date > newest)) newest = msg.date;
  }
  for (const id of [...ids].reverse()) {
    if (known.has(id)) continue;
    if (Date.now() > deadline) { cut = true; break; }
    const msg = await gmail.get(id);
    const r = await processMessage(db, msg, settings, { ourThreadIds });
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
