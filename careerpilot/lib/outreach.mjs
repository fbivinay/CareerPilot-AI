// Outbound email engine: employer-published application addresses, recruiter introductions and
// follow-ups, all through the candidate's Gmail. Every send passes the policy gate, is recorded
// before it is attempted (so a crash can never cause a silent duplicate), and is audited.
// With CAREERPILOT_DRY_RUN=1 nothing is sent or recorded: drafts go to private/outreach-preview.md.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { all, audit, kvGet, kvSet, now, one, run } from './db.mjs';
import { createApplication, getApplication, transition } from './applications.mjs';
import { applicationEmail, contactsFromJob, forRecruiting, upsertContact } from './contacts.mjs';
import { composeEmail, followUpEmail } from './compose.mjs';
import { loadProfile, loadResumePdf } from './profile.mjs';
import { log } from './log.mjs';

const MAX_SEND_ATTEMPTS = 3;

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
  return Number((await one(db, `SELECT count(*) n FROM outreach WHERE kind IN (${kinds.map(() => '?').join(',')}) AND status IN ('sent', 'bounced') AND sent_at >= ?`,
    [...kinds, localDayStart(tz)])).n);
}

// Why a job/contact pair may not be emailed automatically (null = allowed).
export async function blockReason(db, { job, contact, kind }, settings, { ignoreWindow = false } = {}) {
  const s = settings;
  if (kind === 'application' && !s.automation.emailApplications) return 'email applications disabled';
  if (kind !== 'application' && !s.automation.outreach) return 'outreach disabled';
  if (job.status !== 'qualified') return `job is ${job.status}`;
  if ((job.score ?? 0) < s.matching.autoActionScore) return `score ${job.score} below auto-action threshold ${s.matching.autoActionScore}`;
  if (job.confidence !== 'high' && !s.automation.actOnUndisclosedComp) return 'low-confidence match (compensation unverified)';
  if (contact.opted_out) return 'contact opted out or address bounced';
  // Resume and personal details only go to addresses on the employer's own domain (or a person who wrote to us from it).
  if (contact.source_type !== 'inbound_email' && !contact.domain_match) return 'address domain does not match the company (add it manually to approve)';
  const prior = await one(db, `SELECT sum(status IN ('sent', 'sending', 'unknown', 'bounced')) done, sum(status = 'failed') failed
    FROM outreach WHERE contact_id = ? AND job_id = ? AND kind = ?`, [contact.id, job.id, kind]);
  if (Number(prior?.done ?? 0) > 0) return 'already sent for this job';
  if (Number(prior?.failed ?? 0) >= MAX_SEND_ATTEMPTS) return 'send failed repeatedly; check Gmail authorization';
  const cooldown = new Date(Date.now() - s.limits.perCompanyCooldownDays * 864e5).toISOString();
  if (kind !== 'application') {
    if (await one(db, `SELECT 1 FROM outreach WHERE contact_id = ? AND kind = 'initial' AND status = 'sent' AND created_at >= ?`, [contact.id, cooldown])) return 'contacted recently';
    const n = Number((await one(db, `SELECT count(DISTINCT o.contact_id) n FROM outreach o JOIN contacts c ON c.id = o.contact_id
      WHERE lower(c.company) = lower(?) AND o.created_at >= ? AND o.status = 'sent'`, [job.company, cooldown])).n);
    if (n >= s.limits.maxContactsPerCompany) return 'per-company contact limit reached';
  } else {
    const n = Number((await one(db, `SELECT count(*) n FROM outreach WHERE contact_id = ? AND kind = 'application' AND status = 'sent' AND created_at >= ?`,
      [contact.id, cooldown])).n);
    if (n >= s.limits.maxApplicationsPerAddress) return 'application limit for this employer address reached';
  }
  if (!ignoreWindow && !inSendWindow(s.limits.sendWindow)) return 'outside sending window';
  const cap = kind === 'application' ? s.limits.emailApplicationsPerDay : s.limits.outreachPerDay;
  if (await sentToday(db, kind === 'application' ? ['application'] : ['initial', 'followup'], s.limits.sendWindow.tz) >= cap) return 'daily limit reached';
  return null;
}

async function send(db, gmail, { contact, job, kind, subject, body, html = null, attach, threadId = null, inReplyTo = null, references = null, followupOf = null, composer }, profile, resume) {
  const id = randomUUID();
  await run(db, `INSERT INTO outreach (id, contact_id, job_id, kind, subject, body, status, followup_of, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?)`, [id, contact.id, job?.id ?? null, kind, subject, body, followupOf, now()]);
  try {
    const res = await gmail.send({
      to: contact.email,
      subject,
      text: body,
      html,
      threadId,
      inReplyTo,
      references,
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

function writePreview(previews, env) {
  const file = env.CAREERPILOT_PREVIEW_FILE ?? path.resolve(import.meta.dirname ? path.join(import.meta.dirname, '..') : process.cwd(), 'private', 'outreach-preview.md');
  const md = previews.map((p) => [`## ${p.kind}: ${p.job.title} at ${p.job.company}`, `To: ${p.to}`, `Subject: ${p.subject}`,
    `Composer: ${p.composer}${p.note ? ` (${p.note})` : ''}`, `Attachment: ${p.attach ? 'master resume PDF' : 'none'}`, '', '```', p.body, '```', ''].join('\n')).join('\n');
  writeFileSync(file, `# Outreach preview (dry run, nothing was sent)\n\nGenerated ${now()}\n\n${md}`);
  return file;
}

export async function runOutreach(db, gmail, settings, { deadline = Infinity, env = process.env } = {}) {
  const dryRun = env.CAREERPILOT_DRY_RUN === '1';
  // `blocked` counts why individual emails were held back; a stage-level `skipped` is a reason string.
  const stats = { dryRun, applications: 0, initial: 0, followups: 0, previews: 0, blocked: {}, failed: 0 };
  const skip = (r) => { stats.blocked[r] = (stats.blocked[r] ?? 0) + 1; };
  const previews = [];
  // A send that started but never finished (crash) is not retried blindly: it needs a human check.
  if (!dryRun) {
    await run(db, `UPDATE outreach SET status = 'unknown', error = 'interrupted during send; check Gmail Sent before retrying'
      WHERE status = 'sending' AND created_at < ?`, [new Date(Date.now() - 30 * 60_000).toISOString()]);
  }

  const profile = await loadProfile(db, env);
  const resume = await loadResumePdf(db, env);
  if (!profile || !resume) return { skipped: 'profile or resume not imported (npm run setup -- profile)' };
  // The candidate's own email, sent unchanged to every recipient (their choice of 2026-10-19): its subject,
  // text and HTML exactly, with the resume; only the address differs.
  const template = await kvGet(db, 'outreach:template');

  const jobs = await all(db, `SELECT * FROM jobs WHERE status = 'qualified' AND description LIKE '%@%' AND score >= ?
    ORDER BY score DESC, first_seen DESC LIMIT 60`, [settings.matching.autoActionScore]);
  for (const job of jobs) {
    if (Date.now() > deadline) break;
    const contacts = await contactsFromJob(db, job);
    const appAddr = applicationEmail(job.description);
    for (const contact of contacts) {
      const kind = contact.email === appAddr ? 'application' : 'initial';
      const reason = await blockReason(db, { job, contact, kind }, settings, { ignoreWindow: dryRun });
      if (reason) { skip(reason); continue; }
      if (kind === 'application') {
        const existing = await getApplication(db, job.id);
        if (existing && !['ready', 'failed', 'blocked'].includes(existing.status)) { skip(`application already ${existing.status}`); continue; }
      }
      const draft = template?.subject && template?.text
        ? { subject: template.subject, body: template.text, html: template.html ?? null, composer: 'template:candidate' }
        : await composeEmail(db, { profile, job, kind, contactName: contact.name }, settings);
      if (dryRun) {
        previews.push({ kind, job, to: contact.email, ...draft, attach: true });
        stats.previews++;
        continue;
      }
      const app = kind === 'application' ? await createApplication(db, job.id, { method: 'email', resumeVersion: profile.resume?.version }) : null;
      const r = await send(db, gmail, { contact, job, kind, ...draft, attach: true }, profile, resume);
      if (!r.ok) {
        stats.failed++;
        if (app) await transition(db, await getApplication(db, job.id), 'failed', { reason: r.error });
        continue;
      }
      if (app) {
        stats.applications++;
        const fresh = await getApplication(db, job.id);
        await run(db, 'UPDATE applications SET gmail_thread_id = ?, method = ? WHERE id = ?', [r.threadId, 'email', fresh.id]);
        await transition(db, fresh, 'submitted', { evidence: { type: 'gmail_sent', gmailId: r.gmailId, threadId: r.threadId, recipient: contact.email },
          reason: 'emailed to employer-published application address' });
      } else stats.initial++;
    }
  }

  if (settings.automation.followUps) {
    const due = await all(db, `SELECT o.*, c.email, c.name, c.opted_out FROM outreach o JOIN contacts c ON c.id = o.contact_id
      WHERE o.status = 'sent' AND o.kind IN ('initial', 'application') AND o.replied_at IS NULL AND o.sent_at < ? AND c.opted_out = 0`,
    [new Date(Date.now() - settings.limits.followUpAfterDays * 864e5).toISOString()]);
    for (const o of due) {
      if (Date.now() > deadline) break;
      const n = Number((await one(db, `SELECT count(*) n FROM outreach WHERE followup_of = ? AND status != 'failed'`, [o.id])).n);
      if (n >= settings.limits.maxFollowUps) continue;
      const job = await one(db, 'SELECT * FROM jobs WHERE id = ?', [o.job_id]);
      if (!job || job.status === 'expired') { skip('job closed; no follow-up'); continue; }
      // An address the posting prints for something else (accommodations) gets no second email.
      if (job.description?.toLowerCase().includes(o.email) && !forRecruiting(job.description, o.email)) { skip('address is not for recruiting'); continue; }
      const app = await getApplication(db, job.id);
      if (app && ['rejected', 'interview', 'offer', 'assessment', 'withdrawn', 'failed'].includes(app.status)) continue;
      const f = followUpEmail({ profile, job, contactName: o.name });
      const subject = /^re:/i.test(o.subject) ? o.subject : `Re: ${o.subject}`;
      if (dryRun) { previews.push({ kind: 'followup', job, to: o.email, subject, ...f, attach: false }); stats.previews++; continue; }
      if (!inSendWindow(settings.limits.sendWindow)) { skip('outside sending window'); break; }
      if (await sentToday(db, ['initial', 'followup'], settings.limits.sendWindow.tz) >= settings.limits.outreachPerDay) { skip('daily limit reached'); break; }
      const original = await gmail.get(o.gmail_message_id);
      const contact = await one(db, 'SELECT * FROM contacts WHERE id = ?', [o.contact_id]);
      const r = await send(db, gmail, { contact, job, kind: 'followup', subject, body: f.body, attach: false, threadId: o.gmail_thread_id,
        inReplyTo: original.messageId, references: original.references, followupOf: o.id, composer: f.composer }, profile, resume);
      r.ok ? stats.followups++ : stats.failed++;
    }
  }
  if (dryRun && previews.length) stats.previewFile = writePreview(previews, env);
  return stats;
}

// A delivery failure notice for one of our messages: mark it bounced, never email that address
// again, and (for an email application) record that the application did not arrive.
// Matched by Gmail thread only (Gmail files the notice in the original thread); never by body text.
export async function recordBounce(db, { threadId, emailId }) {
  const sent = await one(db, `SELECT o.*, c.email FROM outreach o JOIN contacts c ON c.id = o.contact_id WHERE o.gmail_thread_id = ? AND o.status = 'sent'
    ORDER BY o.sent_at DESC LIMIT 1`, [threadId]);
  if (!sent) return null;
  await run(db, `UPDATE outreach SET status = 'bounced', error = 'delivery failed (bounce notice)' WHERE id = ?`, [sent.id]);
  await run(db, 'UPDATE contacts SET opted_out = 1 WHERE id = ?', [sent.contact_id]);
  await audit(db, 'outreach', sent.id, 'bounced', { from: 'sent', to: 'bounced', detail: { emailId, address: sent.email } });
  if (sent.kind === 'application' && sent.job_id) {
    const app = await getApplication(db, sent.job_id);
    if (app) await transition(db, app, 'failed', { evidence: { type: 'bounce', emailId }, reason: `email to ${sent.email} bounced` });
  }
  return sent;
}

// Addresses pasted on the Email page, in any form (one per line, commas, "Name <a@b.com>"), deduplicated.
export const DAILY_CAP = 499; // Gmail's limit is 500 in any 24 hours; past it Gmail stops all sending for about a day
const DAY = 24 * 3600_000;
const RATE_LIMITED = /Gmail API (429|403)\b[\s\S]*(rate ?limit|quota exceeded)/i;
export const MAX_BULK = 50; // Gmail send quota is ~54 a minute; a batch must finish inside one request
const SENT_SINCE = `FROM outreach WHERE status IN ('sent', 'bounced', 'sending', 'unknown') AND created_at >= ?`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function parseAddresses(raw) {
  return [...new Set((String(raw ?? '').match(/[^\s@<>,;:"'()[\]]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi) ?? []).map((a) => a.toLowerCase()))];
}
export const PRIORITY_RESERVE = 50; // of the 24-hour cap, kept for Priority send (Email page)
const RESERVE_LEAD = 30 * 60_000;

// Whether one more email fits the 24-hour cap now (`window`: send times, oldest first, all within 24 hours).
// Priority emails may use the whole cap; the others stop `reserve` short of it, except in the last half hour before
// the window frees room for them again, when they may use what Priority send left unused. `reserve` ({ from, until })
// marks that use: until those emails leave the window (24 hours after `from`) the others stop at the lower count, so
// Priority send has its room back for the rest of the day.
// Returns { ok, reserve } or { resumeAt } (ms).
export function bulkRoom({ window, cap, keep, priority, reserve = null, t = Date.now() }) {
  const free = (n) => Date.parse(window[window.length - n]) + DAY + 1000; // when the count drops below n
  const bulkCap = cap - keep;
  if (window.length < (priority ? cap : bulkCap)) return { ok: true, reserve };
  if (priority) return { resumeAt: free(cap) };
  const end = free(bulkCap);
  const using = reserve && t >= reserve.from && t < reserve.until;
  const usable = reserve && !using ? reserve.from + DAY : 0; // when the last use has left the window
  if (window.length < cap && t >= end - RESERVE_LEAD && (using || t >= usable)) return { ok: true, reserve: using ? reserve : { from: t, until: end } };
  const at = Math.max(end - RESERVE_LEAD, usable, window.length < cap ? 0 : free(cap));
  return { resumeAt: at < end ? at : end };
}

// Send times (ISO, oldest first) of the emails that count toward the 24-hour cap.
const sentWindow = async (db) => (await all(db, `SELECT created_at ${SENT_SINCE} ORDER BY created_at`, [new Date(Date.now() - DAY).toISOString()]))
  .map((r) => r.created_at);

// The candidate's own email (outreach:template, with the resume) to addresses they paste on the Email page:
// one Gmail message per address, so no recipient ever sees another. An address already emailed (by CareerPilot
// or from the candidate's Gmail), or one that bounced, is skipped.
// `window` is the 24-hour send log, kept up to date here as emails go out. With a `deadline`, the run stops in
// time (returning `more`), and waits for room in the 24-hour window itself when that comes before the deadline.
export async function sendBulk(db, gmail, raw, env = process.env, onResult = async () => {},
  { window = null, deadline = Infinity, interrupt = () => false, priority = new Set() } = {}) {
  const addresses = parseAddresses(raw);
  if (!addresses.length) return { error: 'No email addresses found.' };
  if (addresses.length > MAX_BULK) return { error: `${addresses.length} addresses: send at most ${MAX_BULK} at a time.` };
  const template = await kvGet(db, 'outreach:template');
  const profile = await loadProfile(db, env);
  const resume = await loadResumePdf(db, env);
  if (!template?.subject || !template?.text || !profile || !resume) return { error: 'The email template, profile or resume is missing.' };
  const results = [];
  const add = async (x) => { results.push(x); await onResult(x); };
  const cap = Number(env.BULK_DAILY_CAP ?? DAILY_CAP);
  const keep = Math.min(Number(env.BULK_PRIORITY_RESERVE ?? PRIORITY_RESERVE), cap - 1);
  window ??= await sentWindow(db);
  let reserve;
  for (const email of addresses) {
    if (Date.now() > deadline) return { results, more: true };
    if (interrupt()) return { results };
    // Stop short of Gmail's limit, leaving the rest queued: sending resumes when the window has room (bulkRoom).
    for (;;) {
      while (window.length && Date.parse(window[0]) < Date.now() - DAY) window.shift();
      if (window.length < cap - keep) break; // the common case, with no read of bulk:reserve
      if (reserve === undefined) reserve = await kvGet(db, 'bulk:reserve', null);
      const room = bulkRoom({ window, cap, keep, priority: priority.has(email), reserve });
      if (room.ok) {
        if (room.reserve !== reserve) await kvSet(db, 'bulk:reserve', (reserve = room.reserve));
        break;
      }
      if (Number.isFinite(deadline) && room.resumeAt < deadline - 10_000) { await sleep(room.resumeAt - Date.now()); continue; }
      return { results, resumeAt: new Date(room.resumeAt).toISOString(),
        paused: `${window.length} emails sent in the last 24 hours (limit ${cap}, Gmail's is 500; ${keep} kept for Priority send until the last half hour).` };
    }
    const contact = await upsertContact(db, { email, sourceType: 'manual', domainMatch: true });
    if (contact.opted_out) { await add({ email, ok: false, error: 'bounced before or opted out' }); continue; }
    // Never a second email: not after any CareerPilot email to this address (this box, outreach, applications),
    // nor after one the candidate sent from Gmail themselves.
    if (await one(db, `SELECT 1 FROM outreach WHERE contact_id = ? AND status IN ('sent', 'sending', 'unknown', 'bounced')`, [contact.id])) {
      await add({ email, ok: false, error: 'already sent' });
      continue;
    }
    if ((await gmail.listIds(`in:sent to:${email}`, 1)).length) { await add({ email, ok: false, error: 'already emailed from your Gmail' }); continue; }
    const r = await send(db, gmail, { contact, job: null, kind: 'direct', subject: template.subject, body: template.text, html: template.html ?? null,
      attach: true, composer: 'template:candidate' }, profile, resume);
    if (!r.ok && RATE_LIMITED.test(r.error ?? '')) {
      return { results, resumeAt: /Retry after (\S+?Z)/.exec(r.error)?.[1] ?? null, paused: "Gmail's daily sending limit was reached." };
    }
    if (r.ok) window.push(now());
    await add({ email, ok: r.ok, error: r.error });
  }
  return { results };
}

// The dashboard host holds no Gmail or encryption key (scripts/setup.mjs), so the Email page only queues the
// addresses and starts careerpilot-bulk.yml on GitHub, whose `bulk` stage sends them (every pipeline run drains
// the queue too, if that start fails). `priority` puts the addresses at the front of the queue (moving any already
// queued), so they go out before everything else; a run already sending switches to them after its current email.
export async function queueBulk(db, raw, { priority = false } = {}) {
  const addresses = parseAddresses(raw);
  if (!addresses.length) return { error: 'No email addresses found.' };
  if (addresses.length > MAX_BULK) return { error: `${addresses.length} addresses: send at most ${MAX_BULK} at a time.` };
  const queue = await kvGet(db, 'bulk:queue', []);
  await kvSet(db, 'bulk:queue', [...new Set(priority ? [...addresses, ...queue] : [...queue, ...addresses])]);
  // Priority addresses may use the reserved part of the 24-hour cap (bulkRoom).
  if (priority) await kvSet(db, 'bulk:priority', [...new Set([...(await kvGet(db, 'bulk:priority', [])), ...addresses])]);
  return { queued: addresses.length, ...(priority && { priority: true }) };
}

// ponytail: queue is one kv value; an address queued in the instant between the read and the write below is
// kept (the write removes only what was sent), but two runs at once could both send it. The workflow's
// concurrency group keeps runs one at a time.
// A run out of time with addresses left calls `onMore` (careerpilot-bulk.yml starts its next run).
export async function sendQueued(db, gmail, env = process.env, { deadline = Infinity, onMore = null } = {}) {
  const done = [];
  const startedAt = now();
  const total = (await kvGet(db, 'bulk:queue', [])).length;
  if (!total) return { sent: 0, skipped: 0 };
  const window = await sentWindow(db);
  const cap = Number(env.BULK_DAILY_CAP ?? DAILY_CAP);
  // bulk:last is the Email page's live progress: each address leaves the queue and joins the results as soon as
  // it is tried, so a run cut off mid-batch neither re-tries nor loses one. `sentTimes` and `cap` feed the page's
  // finish-time estimate (lib/bulk-eta.mjs).
  const progress = (extra) => kvSet(db, 'bulk:last', { at: now(), startedAt, total: Math.max(total, done.length), results: done, cap, sentTimes: window, ...extra });
  // Every tried address leaves the queue, so its head is the batch's next address, unless priority addresses were
  // put in front of it (queueBulk): then the batch stops and the next one starts from the new head.
  let batch = [];
  let tried = 0;
  let jumped = false;
  let priority = new Set();
  const onResult = async (r) => {
    done.push(r);
    const queue = (await kvGet(db, 'bulk:queue', [])).filter((a) => a !== r.email);
    await kvSet(db, 'bulk:queue', queue);
    if (priority.delete(r.email)) await kvSet(db, 'bulk:priority', (await kvGet(db, 'bulk:priority', [])).filter((a) => a !== r.email));
    jumped = ++tried < batch.length && queue.length > 0 && queue[0] !== batch[tried];
    await progress({ running: true });
  };
  await progress({ running: true });
  let res = {};
  while (!res.paused && !res.more && (batch = (await kvGet(db, 'bulk:queue', [])).slice(0, MAX_BULK)).length) {
    tried = 0;
    jumped = false;
    priority = new Set(await kvGet(db, 'bulk:priority', []));
    res = await sendBulk(db, gmail, batch.join(' '), env, onResult, { window, deadline, interrupt: () => jumped, priority });
    if (res.error) { await kvSet(db, 'bulk:last', { at: now(), error: res.error }); return res; }
  }
  // resumeAt lets the Email page restart the sender itself once the 24-hour window has room again.
  await progress(res.paused ? { paused: res.paused, resumeAt: res.resumeAt } : {});
  if (res.more && onMore) await onMore().catch((err) => log.warn('could not start the next bulk run', { error: err.message }));
  return { sent: done.filter((r) => r.ok).length, skipped: done.filter((r) => !r.ok).length, ...(res.more && { more: true }) };
}

// The Email page restarts a batch paused at the sending limit once its resume time has passed: one start per
// pause (the run it starts writes a fresh state). Returns the state for the page to show.
export async function resumeBulkIfDue(db, dispatch, nowMs = Date.now()) {
  const last = await kvGet(db, 'bulk:last');
  if (!last?.paused || last.restartedAt || Date.parse(last.resumeAt) > nowMs || !(await kvGet(db, 'bulk:queue', [])).length) return last;
  if (!(await dispatch().catch(() => null))?.ok) return last;
  const next = { ...last, restartedAt: now() };
  await kvSet(db, 'bulk:last', next);
  return next;
}

// Manual contact entry from the dashboard (e.g. a recruiter met at an event).
export async function addManualContact(db, { email, name, company }) {
  return upsertContact(db, { email, name, company, sourceType: 'manual', domainMatch: true });
}
