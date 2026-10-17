// Outbound email engine: employer-published application addresses, recruiter introductions and
// follow-ups, all through the candidate's Gmail. Every send passes the policy gate, is recorded
// before it is attempted (so a crash can never cause a silent duplicate), and is audited.
import { randomUUID } from 'node:crypto';
import { all, audit, now, one, run } from './db.mjs';
import { createApplication, getApplication, transition } from './applications.mjs';
import { applicationEmail, contactsFromJob, upsertContact } from './contacts.mjs';
import { composeEmail, followUpEmail } from './compose.mjs';
import { loadProfile, loadResumePdf } from './profile.mjs';
import { log } from './log.mjs';

// Local time in the configured zone, as {day: 0-6 (Sun=0), hour: fractional}.
export function zonedNow(tz, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(date).map((p) => [p.type, p.value]));
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday), hour: Number(parts.hour) + Number(parts.minute) / 60 };
}

export function inSendWindow(win, date = new Date()) {
  const { day, hour } = zonedNow(win.tz, date);
  return win.days.includes(day) && hour >= win.startHour && hour < win.endHour;
}

// Midnight today in the send-window zone, as an ISO instant (daily caps reset at local midnight).
function localDayStart(tz) {
  const d = new Date();
  const { hour } = zonedNow(tz, d);
  return new Date(d.getTime() - hour * 36e5).toISOString();
}

export async function sentToday(db, kinds, tz) {
  return Number((await one(db, `SELECT count(*) n FROM outreach WHERE kind IN (${kinds.map(() => '?').join(',')}) AND status = 'sent' AND sent_at >= ?`,
    [...kinds, localDayStart(tz)])).n);
}

// Why a job/contact pair may not be emailed automatically (null = allowed).
export async function blockReason(db, { job, contact, kind }, settings) {
  const s = settings;
  if (kind === 'application' && !s.automation.emailApplications) return 'email applications disabled';
  if (kind !== 'application' && !s.automation.outreach) return 'outreach disabled';
  if (job.status !== 'qualified') return `job is ${job.status}`;
  if ((job.score ?? 0) < s.matching.autoActionScore) return `score ${job.score} below auto-action threshold ${s.matching.autoActionScore}`;
  if (job.confidence !== 'high' && !s.automation.actOnUndisclosedComp) return 'low-confidence match (compensation unverified)';
  if (contact.opted_out) return 'contact opted out';
  if (contact.source_type !== 'inbound_email' && !contact.domain_match && kind !== 'application') return 'contact domain does not match the company';
  if (await one(db, `SELECT 1 FROM outreach WHERE contact_id = ? AND job_id = ? AND kind = ?`, [contact.id, job.id, kind])) return 'already sent for this job';
  const cooldown = new Date(Date.now() - s.limits.perCompanyCooldownDays * 864e5).toISOString();
  if (kind !== 'application') {
    if (await one(db, `SELECT 1 FROM outreach WHERE contact_id = ? AND kind = 'initial' AND created_at >= ?`, [contact.id, cooldown])) return 'contacted recently';
    const n = Number((await one(db, `SELECT count(DISTINCT o.contact_id) n FROM outreach o JOIN contacts c ON c.id = o.contact_id
      WHERE lower(c.company) = lower(?) AND o.created_at >= ? AND o.status = 'sent'`, [job.company, cooldown])).n);
    if (n >= s.limits.maxContactsPerCompany) return 'per-company contact limit reached';
  }
  if (!inSendWindow(s.limits.sendWindow)) return 'outside sending window';
  const cap = kind === 'application' ? s.limits.emailApplicationsPerDay : s.limits.outreachPerDay;
  if (await sentToday(db, kind === 'application' ? ['application'] : ['initial', 'followup'], s.limits.sendWindow.tz) >= cap) return 'daily limit reached';
  return null;
}

async function send(db, gmail, { contact, job, kind, subject, body, attach, threadId = null, inReplyTo = null, followupOf = null, composer }, profile, resume) {
  const id = randomUUID();
  await run(db, `INSERT INTO outreach (id, contact_id, job_id, kind, subject, body, status, followup_of, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?)`, [id, contact.id, job?.id ?? null, kind, subject, body, followupOf, now()]);
  try {
    const res = await gmail.send({
      to: contact.email,
      subject,
      text: body,
      threadId,
      inReplyTo,
      attachments: attach && resume ? [{ filename: `${profile.name.replace(/\s+/g, '_')}_Resume.pdf`, mimeType: 'application/pdf', content: resume }] : [],
    });
    await run(db, `UPDATE outreach SET status = 'sent', sent_at = ?, gmail_message_id = ?, gmail_thread_id = ? WHERE id = ?`, [now(), res.id, res.threadId, id]);
    await audit(db, 'outreach', id, 'sent', { to: 'sent', detail: { kind, contact: contact.email, jobId: job?.id, composer, gmailId: res.id } });
    return { ok: true, id, gmailId: res.id, threadId: res.threadId };
  } catch (err) {
    await run(db, `UPDATE outreach SET status = 'failed', error = ? WHERE id = ?`, [String(err.message).slice(0, 300), id]);
    await audit(db, 'outreach', id, 'failed', { to: 'failed', detail: { kind, error: err.message } });
    log.warn('send failed', { kind, error: err.message });
    return { ok: false, id, error: err.message };
  }
}

export async function runOutreach(db, gmail, settings, { deadline = Infinity, env = process.env } = {}) {
  const stats = { applications: 0, initial: 0, followups: 0, skipped: {}, failed: 0 };
  const skip = (r) => { stats.skipped[r] = (stats.skipped[r] ?? 0) + 1; };
  // A send that started but never finished (crash) is not retried blindly: it needs a human check.
  await run(db, `UPDATE outreach SET status = 'unknown', error = 'interrupted during send; check Gmail Sent before retrying'
    WHERE status = 'sending' AND created_at < ?`, [new Date(Date.now() - 30 * 60_000).toISOString()]);

  const profile = await loadProfile(db, env);
  const resume = await loadResumePdf(db, env);
  if (!profile || !resume) return { skipped: 'profile or resume not imported (npm run profile:import)' };

  const jobs = await all(db, `SELECT * FROM jobs WHERE status = 'qualified' AND description LIKE '%@%' AND score >= ?
    ORDER BY score DESC, first_seen DESC LIMIT 60`, [settings.matching.autoActionScore]);
  for (const job of jobs) {
    if (Date.now() > deadline) break;
    const contacts = await contactsFromJob(db, job);
    const appAddr = applicationEmail(job.description);
    for (const contact of contacts) {
      const kind = contact.email === appAddr ? 'application' : 'initial';
      const reason = await blockReason(db, { job, contact, kind }, settings);
      if (reason) { skip(reason); continue; }
      if (kind === 'application') {
        const app = await createApplication(db, job.id, { method: 'email', resumeVersion: profile.resume?.version });
        if (app.status !== 'ready' && app.status !== 'failed') { skip(`application already ${app.status}`); continue; }
      }
      const draft = await composeEmail(db, { profile, job, kind, contactName: contact.name }, settings);
      const r = await send(db, gmail, { contact, job, kind, ...draft, attach: true }, profile, resume);
      if (!r.ok) {
        stats.failed++;
        if (kind === 'application') await transition(db, await getApplication(db, job.id), 'failed', { reason: r.error });
        continue;
      }
      if (kind === 'application') {
        stats.applications++;
        const app = await getApplication(db, job.id);
        await run(db, 'UPDATE applications SET gmail_thread_id = ? WHERE id = ?', [r.threadId, app.id]);
        await transition(db, app, 'submitted', { evidence: { type: 'gmail_sent', gmailId: r.gmailId, threadId: r.threadId, recipient: contact.email }, reason: 'emailed to employer-published application address' });
      } else stats.initial++;
    }
  }

  if (settings.automation.followUps) {
    const due = await all(db, `SELECT o.*, c.email, c.name, c.opted_out, c.company c_company FROM outreach o JOIN contacts c ON c.id = o.contact_id
      WHERE o.status = 'sent' AND o.kind IN ('initial', 'application') AND o.replied_at IS NULL AND o.sent_at < ? AND c.opted_out = 0`,
    [new Date(Date.now() - settings.limits.followUpAfterDays * 864e5).toISOString()]);
    for (const o of due) {
      if (Date.now() > deadline) break;
      const n = Number((await one(db, `SELECT count(*) n FROM outreach WHERE followup_of = ?`, [o.id])).n);
      if (n >= settings.limits.maxFollowUps) continue;
      const job = await one(db, 'SELECT * FROM jobs WHERE id = ?', [o.job_id]);
      if (!job || job.status === 'expired') { skip('job closed; no follow-up'); continue; }
      const app = await getApplication(db, job.id);
      if (app && ['rejected', 'interview', 'offer', 'assessment', 'withdrawn'].includes(app.status)) continue;
      if (!inSendWindow(settings.limits.sendWindow)) { skip('outside sending window'); break; }
      if (await sentToday(db, ['initial', 'followup'], settings.limits.sendWindow.tz) >= settings.limits.outreachPerDay) { skip('daily limit reached'); break; }
      const original = await gmail.get(o.gmail_message_id);
      const f = followUpEmail({ profile, job, contactName: o.name });
      const contact = await one(db, 'SELECT * FROM contacts WHERE id = ?', [o.contact_id]);
      const r = await send(db, gmail, { contact, job, kind: 'followup', subject: /^re:/i.test(o.subject) ? o.subject : `Re: ${o.subject}`, body: f.body,
        attach: false, threadId: o.gmail_thread_id, inReplyTo: original.messageId, followupOf: o.id, composer: f.composer }, profile, resume);
      r.ok ? stats.followups++ : stats.failed++;
    }
  }
  return stats;
}

// Manual contact entry from the dashboard (e.g. a recruiter met at an event).
export async function addManualContact(db, { email, name, company }) {
  return upsertContact(db, { email, name, company, sourceType: 'manual', domainMatch: true });
}
