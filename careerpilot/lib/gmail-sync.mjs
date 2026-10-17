// Incremental Gmail sync: classify each new message, link it to an application, apply clear
// status changes automatically, queue ambiguous ones for review, record recruiter contacts and
// opt-outs, and turn job-alert emails into discovered jobs. Idempotent: emails.id is the Gmail id.
import { all, audit, kvGet, kvSet, now, one, run } from './db.mjs';
import { aiJson, AiUnavailable } from './ai.mjs';
import { createApplication, transition } from './applications.mjs';
import { classifyEmail, extractDetails, parseJobAlert, platformSender } from './email-intel.mjs';
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
const AUTO_CONFIDENCE = 0.85;
const NOREPLY = /^(no-?reply|do-?not-?reply|notifications?|jobs?|careers?|talent|recruiting|hr|hiring|info|alerts?|mailer-daemon|postmaster)[-.+@]/i;
const GENERIC_DOMAINS = /@(gmail|yahoo|outlook|hotmail|icloud|proton(mail)?|rediffmail)\./i;

const companyKey = (c) => String(c ?? '').toLowerCase()
  .replace(/\b(inc|llc|ltd|limited|pvt|private|technologies|technology|labs|software|solutions|india|corp|corporation|co)\b\.?/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

export function mentionsCompany(hay, company) {
  const k = companyKey(company);
  if (k.length < 3) return false;
  return new RegExp(`(^|[^a-z0-9])${k.replace(/ /g, '[^a-z0-9]?')}([^a-z0-9]|$)`).test(hay);
}

async function linkEmail(db, msg) {
  const byThread = await one(db, `SELECT a.id app_id, a.job_id FROM applications a WHERE a.gmail_thread_id = ?`, [msg.threadId])
    ?? await one(db, `SELECT o.job_id, a.id app_id FROM outreach o LEFT JOIN applications a ON a.job_id = o.job_id
      WHERE o.gmail_thread_id = ? AND o.job_id IS NOT NULL LIMIT 1`, [msg.threadId]);
  if (byThread) return { ...byThread, how: 'thread' };

  const hay = `${msg.fromName} ${msg.fromAddr.split('@')[1] ?? ''} ${msg.subject} ${(msg.text ?? '').slice(0, 3000)}`.toLowerCase();
  const apps = await all(db, `SELECT a.id app_id, a.job_id, j.company, j.title FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.status != 'withdrawn'`);
  const hits = apps.filter((a) => mentionsCompany(hay, a.company));
  const companies = new Set(hits.map((h) => companyKey(h.company)));
  if (companies.size !== 1) return companies.size > 1 ? { ambiguous: true, how: 'multiple companies' } : null;
  if (hits.length === 1) return { ...hits[0], how: 'company' };
  const byTitle = hits.filter((h) => hay.includes(h.title.toLowerCase()));
  return byTitle.length === 1 ? { ...byTitle[0], how: 'company+title' } : { ambiguous: true, company: hits[0].company, how: 'several roles at company' };
}

// "Thank you for applying to Acme" / "Your application to Data Analyst at Acme" / "Your application was sent to Acme".
export function companyFromSubject(subject) {
  const m = subject.match(/application (?:to|for) (.+?) at (.+?)(?:[!.|]|$)/i);
  if (m) return { title: m[1].trim(), company: m[2].trim() };
  const c = subject.match(/(?:applying (?:to|at|with)|application (?:was sent )?to|interest in) ([A-Z][\w&.' -]{1,60}?)(?:[!.|,]| -|$)/i);
  return c ? { title: null, company: c[1].trim() } : null;
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
    const sent = await recordBounce(db, { threadId: msg.threadId, text: msg.text, emailId: msg.id });
    if (sent?.job_id) {
      const app = await one(db, 'SELECT id FROM applications WHERE job_id = ?', [sent.job_id]);
      link = { app_id: app?.id ?? null, job_id: sent.job_id, how: 'bounce' };
    }
    result.review = !sent; // a bounce we cannot match to anything we sent needs a look
  } else {
    link = await linkEmail(db, msg);
    if ((cls.category === 'other' || cls.category === 'ats_update') && (link?.app_id || cls.category === 'ats_update')) {
      const ai = await aiClassify(db, msg, settings);
      if (ai && ai.category !== 'other') { cls = { category: ai.category, confidence: Math.min(ai.confidence, 0.84) }; classifiedBy = `ai:${ai._provider}`; }
    }
    result.category = cls.category;

    // A confirmation for something the candidate applied to by hand: record the application.
    if (!link && cls.category === 'application_confirmation') {
      const guess = companyFromSubject(msg.subject);
      // Only authenticated mail from a hiring platform or the company itself may create a record.
      if (guess && msg.authenticated && (platformSender(msg.fromAddr) || domainMatchesCompany(msg.fromAddr, guess.company))) {
        const first = companyKey(guess.company).split(' ')[0] ?? '';
        const candidates = first.length >= 3
          ? await all(db, `SELECT id, company, title FROM jobs WHERE status != 'duplicate' AND lower(company) LIKE ?`, [`%${first}%`])
          : [];
        const job = candidates.find((j) => mentionsCompany(guess.company.toLowerCase(), j.company)
          && (!guess.title || j.title.toLowerCase() === guess.title.toLowerCase()));
        const jobId = job?.id ?? (await upsertJob(db, { url: `https://mail.google.com/mail/u/0/#all/${msg.threadId}`, title: guess.title ?? 'Application (from email)',
          company: guess.company, location: '' }, { source: 'email', settings }))?.id;
        if (jobId) {
          const app = await createApplication(db, jobId, { status: 'ready', method: 'external' });
          link = { app_id: app.id, job_id: jobId, how: 'confirmation subject' };
        }
      }
    }

    const target = CATEGORY_STATUS[cls.category];
    if (target && link?.app_id) {
      const app = await one(db, 'SELECT a.*, j.company FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?', [link.app_id]);
      // Status changes only from mail we can trust: a reply in a thread we started, or mail that passed
      // Gmail's DKIM/SPF check and comes from a hiring platform or the company's own domain. Offers are
      // always confirmed by the candidate.
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
    // passing DKIM/SPF, becomes a verified contact.
    if (link?.job_id && !NOREPLY.test(msg.fromAddr) && !GENERIC_DOMAINS.test(msg.fromAddr) && cls.category !== 'opt_out'
      && (link.how === 'thread' || msg.authenticated)) {
      const job = await one(db, 'SELECT company FROM jobs WHERE id = ?', [link.job_id]);
      if (job && domainMatchesCompany(msg.fromAddr, job.company)) {
        await upsertContact(db, { email: msg.fromAddr, name: msg.fromName, company: job.company, sourceType: 'inbound_email', sourceRef: msg.id, domainMatch: true });
      }
    }
  }

  const relevant = cls.category !== 'other' || link?.app_id;
  if (relevant) {
    await run(db, `INSERT INTO emails (id, thread_id, from_addr, from_name, subject, snippet, received_at, category, confidence, classified_by,
        company, job_id, application_id, extracted, needs_review, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.threadId, msg.fromAddr, msg.fromName, msg.subject, (msg.snippet ?? '').slice(0, 240), msg.date, cls.category, cls.confidence,
      classifiedBy, link?.company ?? null, link?.job_id ?? null, link?.app_id ?? null, JSON.stringify({ ...details, link: link?.how ?? null }),
      result.review ? 1 : 0, now()]);
  } else {
    // Irrelevant mail is remembered only by id so it is not fetched again; no content is stored.
    await run(db, `INSERT INTO emails (id, category, processed_at) VALUES (?, 'ignored', ?)`, [msg.id, now()]);
  }
  return result;
}

export async function syncGmail(db, gmail, settings, { lookbackDays = 30, max = 300, deadline = Infinity } = {}) {
  const last = await kvGet(db, 'gmail:last_sync');
  const after = last ? Math.floor(new Date(last).getTime() / 1000) - 3600 : Math.floor(Date.now() / 1000) - lookbackDays * 86400;
  const ids = await gmail.listIds(`after:${after} -in:sent -in:chats -in:drafts -category:promotions -category:social`, max);
  const known = new Set((await all(db, `SELECT id FROM emails WHERE id IN (${ids.map(() => '?').join(',') || "''"})`, ids)).map((r) => r.id));
  const ourThreadIds = new Set((await all(db, `SELECT gmail_thread_id t FROM outreach WHERE gmail_thread_id IS NOT NULL
    UNION SELECT gmail_thread_id FROM applications WHERE gmail_thread_id IS NOT NULL`)).map((r) => r.t));
  const stats = { listed: ids.length, processed: 0, alerts: 0, jobsFromAlerts: 0, transitions: 0, review: 0 };
  let newest = last;
  for (const id of ids.reverse()) {
    if (known.has(id)) continue;
    if (Date.now() > deadline) break;
    const msg = await gmail.get(id);
    const r = await processMessage(db, msg, settings, { ourThreadIds });
    stats.processed++;
    if (r.category === 'job_alert') { stats.alerts++; stats.jobsFromAlerts += r.jobs; }
    if (r.transitioned) stats.transitions++;
    if (r.review) stats.review++;
    if (msg.date && (!newest || msg.date > newest)) newest = msg.date;
  }
  if (newest) await kvSet(db, 'gmail:last_sync', newest);
  await kvSet(db, 'gmail:status', { ok: true, at: now() });
  return stats;
}

export { linkEmail };
