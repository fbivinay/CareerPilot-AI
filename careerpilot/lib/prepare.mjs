// Prepares applications for qualified jobs that are not handled by email:
//   portal jobs (Greenhouse/Lever/Ashby/Workday/...) -> 'ready' with a prefill answer pack, or
//   'blocked' when an answer the form needs is unknown. Candidate-side submission on these portals
//   needs the candidate (consent declarations, CAPTCHA, account login), so they are never auto-submitted.
//   job-board alerts (LinkedIn, Naukri, ...) -> 'ready' for applying on that platform.
import { all, audit, kvGet, kvSet, now, run } from './db.mjs';
import { createApplication, SHOWN_APP, SHOWN_EMAIL, transition } from './applications.mjs';
import { applicationEmail } from './contacts.mjs';
import { loadProfile } from './profile.mjs';

const REQUIRED = {
  full_time: ['earliest_full_time_start', 'indian_work_authorization'],
  internship: ['internship_available_from', 'internship_duration_months', 'indian_work_authorization'],
  contract: ['indian_work_authorization'],
};

// YAML dates arrive as Date objects (or ISO strings after the encrypted round trip); forms want YYYY-MM-DD.
const plain = (v) => (v instanceof Date ? v.toISOString().slice(0, 10)
  : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(v) ? v.slice(0, 10) : v);

export function answerPack(profile, job) {
  const a = Object.fromEntries(Object.entries(profile.answers ?? {}).map(([k, v]) => [k, plain(v)]));
  const missing = (REQUIRED[job.employment_type] ?? []).filter((k) => a[k] == null || a[k] === '');
  // A job still going ("May 2026 - Present"); a finished internship is no current employer.
  const current = (profile.experience ?? []).find((e) => /[-–]\s*(present|current|now)\b/i.test(e.dates ?? ''));
  return {
    missing,
    fields: {
      first_name: profile.name.split(' ').slice(0, -1).join(' ') || profile.name,
      last_name: profile.name.split(' ').slice(-1)[0],
      email: profile.email,
      phone: profile.phone,
      location: profile.location,
      linkedin: profile.links?.linkedin,
      github: profile.links?.github,
      portfolio: profile.links?.portfolio,
      current_education: `${profile.education?.[0]?.degree}, ${profile.education?.[0]?.institution}`,
      current_company: current?.company.replace(/,[^,]*$/, '').trim(), // "ComedKares, Bengaluru" -> "ComedKares"
      graduation: a.graduation_month,
      ...Object.fromEntries(Object.entries(a).filter(([, v]) => v != null)),
    },
  };
}

// What an application for this job needs next: 'blocked' when an answer is missing, otherwise 'ready'
// with a note on how it gets submitted.
export const CAPTCHA_FORM = 'CAPTCHA form';

export function nextStep(job, pack) {
  if (pack.missing.length) {
    return { status: 'blocked', reason: `Missing answers: ${pack.missing.join(', ')} (fill them in private/profile.yml, then npm run setup -- profile)` };
  }
  const platform = job.source?.startsWith('alert:') ? job.source.slice(6) : null;
  if (platform) return { status: 'ready', reason: `Apply on ${platform}; job boards do not permit automated applications` };
  // Ready means CareerPilot submits it (Workday). Other portals carry a CAPTCHA, and Lever rejects any
  // submit from an automated browser: those wait for the candidate, who is emailed (the candidate's
  // choice, 2026-10-19).
  return /\.myworkdayjobs\.com\//.test(job.url ?? '') ? { status: 'ready', reason: null }
    : { status: 'blocked', reason: `${CAPTCHA_FORM}: CareerPilot cannot submit it. Get its answer sheet (or npm run apply:assist) and submit it yourself` };
}

export async function prepareApplications(db, settings, { env = process.env } = {}) {
  const profile = await loadProfile(db, env);
  if (!profile) return { skipped: 'profile not imported' };
  const stats = { ready: 0, blocked: 0, email: 0, unblocked: 0, reopened: 0, withdrawn: 0, reinstated: 0 };

  const jobs = await all(db, `SELECT j.* FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
    WHERE j.status = 'qualified' AND a.id IS NULL AND j.score >= ? ORDER BY j.score DESC LIMIT 200`, [settings.matching.autoActionScore]);
  for (const job of jobs) {
    if (applicationEmail(job.description)) { stats.email++; continue; } // handled by the outreach stage
    // A job-site posting is the candidate's to apply to (job sites forbid automation): not CareerPilot's work.
    if (job.source.startsWith('alert:')) continue;
    const step = nextStep(job, answerPack(profile, job));
    // Answers are not copied into the database; the answer pack is rebuilt from the encrypted profile when shown.
    await createApplication(db, job.id, { status: step.status, method: 'portal', resumeVersion: profile.resume?.version, blockedReason: step.reason });
    stats[step.status]++;
  }

  // Not-yet-submitted applications this stage prepared, for jobs that no longer qualify (rules or settings
  // changed), are withdrawn with the reason. Applications you track yourself or that came from email stay.
  const stale = await all(db, `SELECT a.*, j.exclusion_reason FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.status IN ('ready', 'blocked', 'failed') AND j.status = 'excluded' AND a.method != 'manual' AND j.source NOT LIKE 'email%'`);
  for (const app of stale) {
    if (await transition(db, app, 'withdrawn', { reason: `No longer matches your criteria: ${app.exclusion_reason}`, by: 'system' })) stats.withdrawn++;
  }

  // Applications this stage withdrew come back when their job qualifies again (rules or profile changed).
  // Ones the candidate withdrew themselves stay withdrawn.
  const back = await all(db, `SELECT a.*, j.employment_type, j.source, j.url FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.status = 'withdrawn' AND j.status = 'qualified'
      AND a.id IN (SELECT entity_id FROM events WHERE entity = 'application' AND to_status = 'withdrawn' AND detail LIKE '%"by":"system"%')
      AND a.id NOT IN (SELECT entity_id FROM events WHERE entity = 'application' AND to_status = 'withdrawn' AND detail LIKE '%"by":"candidate"%')`);
  for (const app of back) {
    const step = nextStep(app, answerPack(profile, app));
    await run(db, `UPDATE applications SET status = ?, blocked_reason = ?, updated_at = ? WHERE id = ? AND status = 'withdrawn'`,
      [step.status, step.reason, now(), app.id]);
    await audit(db, 'application', app.id, 'status', { from: 'withdrawn', to: step.status, detail: { reason: 'matches your criteria again', by: 'system' } });
    stats.reinstated++;
  }

  // Applications blocked on answers you have since provided, and ones whose posting reopened.
  const recheck = await all(db, `SELECT a.*, j.employment_type, j.source, j.url FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE (a.status = 'blocked' AND a.blocked_reason LIKE 'Missing answers%') OR (a.status = 'expired' AND j.status = 'qualified')`);
  for (const app of recheck) {
    const step = nextStep(app, answerPack(profile, app));
    if (step.status !== app.status) {
      const from = app.status;
      await transition(db, app, step.status, { reason: from === 'expired' ? 'posting reopened' : 'answers now provided' });
      if (from === 'expired') stats.reopened++; else stats.unblocked++;
    }
    await run(db, 'UPDATE applications SET blocked_reason = ? WHERE id = ?', [step.reason, app.id]);
  }
  return stats;
}

// Once a day, email the candidate a summary of what needs them. Uses the same gmail.send scope.
// An email as soon as applications need the candidate (a CAPTCHA form, missing answers, a question only they
// can answer), so nothing waits unseen while the rest is applied to automatically (the candidate's choice,
// 2026-10-19). Each blocked application is reported once per reason.
export async function sendBlockedAlert(db, gmail, { to, env = process.env } = {}) {
  if (!to) return { skipped: 'connected mailbox unknown' };
  const told = await kvGet(db, 'notify:blocked', {});
  const rows = await all(db, `SELECT a.id, a.blocked_reason, j.title, j.company, j.url FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.status IN ('blocked', 'failed') AND ${SHOWN_APP} ORDER BY a.updated_at`);
  const fresh = rows.filter((r) => told[r.id] !== (r.blocked_reason ?? ''));
  if (!fresh.length) return { skipped: 'nothing new' };
  const s = fresh.length > 1 ? 's' : '';
  const lines = [`CareerPilot could not finish ${fresh.length} application${s}; ${fresh.length > 1 ? 'they need' : 'it needs'} you:`, '',
    ...fresh.flatMap((r) => [`- ${r.title} at ${r.company}`, `  ${r.blocked_reason ?? 'Blocked'}`, `  ${r.url}`, '']),
    'Everything else is applied to automatically. The dashboard lists every blocked application (Overview → Blocked).'];
  if (env.CAREERPILOT_DRY_RUN === '1') return { dryRun: true, wouldSend: fresh.length };
  await gmail.send({ to, subject: `CareerPilot: ${fresh.length} blocked application${s} need${s ? '' : 's'} you`, text: lines.join('\n') });
  await kvSet(db, 'notify:blocked', Object.fromEntries(rows.map((r) => [r.id, r.blocked_reason ?? ''])));
  return { sent: fresh.length };
}

export async function sendDigest(db, gmail, settings, { to, env = process.env } = {}) {
  const today = now().slice(0, 10);
  if ((await kvGet(db, 'digest:last')) === today) return { skipped: 'already sent today' };
  if (!to) return { skipped: 'connected mailbox unknown' };
  // CareerPilot's own work only (the candidate's choice, 2026-10-18).
  const ready = await all(db, `SELECT j.title, j.company, j.url, a.status, a.blocked_reason FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.status IN ('blocked', 'failed') AND ${SHOWN_APP} ORDER BY j.score DESC LIMIT 25`); // ready ones CareerPilot submits itself
  const review = await all(db, `SELECT e.subject, e.from_addr, e.category FROM emails e WHERE e.needs_review = 1 AND e.reviewed = 0 AND ${SHOWN_EMAIL}
    ORDER BY e.received_at DESC LIMIT 15`);
  const upcoming = await all(db, `SELECT e.subject, e.extracted FROM emails e WHERE e.category IN ('interview', 'assessment') AND e.received_at >= ? AND ${SHOWN_EMAIL}
    ORDER BY e.received_at DESC LIMIT 10`, [new Date(Date.now() - 7 * 864e5).toISOString()]);
  if (!ready.length && !review.length && !upcoming.length) { await kvSet(db, 'digest:last', today); return { skipped: 'nothing pending' }; }
  const lines = ['CareerPilot daily digest', ''];
  if (upcoming.length) lines.push('Interviews / assessments (last 7 days):', ...upcoming.map((u) => `- ${u.subject} ${(JSON.parse(u.extracted ?? '{}').dates ?? []).join(', ')}`), '');
  if (review.length) lines.push('Emails needing your review:', ...review.map((r) => `- [${r.category}] ${r.subject}`), '');
  if (ready.length) lines.push('Applications waiting for you:', ...ready.map((r) => `- ${r.title} at ${r.company} (${r.status}): ${r.url}`), '');
  lines.push('Open the dashboard for details.');
  if (env.CAREERPILOT_DRY_RUN === '1') return { dryRun: true, wouldSend: lines.length, ready: ready.length, review: review.length };
  await gmail.send({ to, subject: `CareerPilot: ${ready.length} applications, ${review.length} emails need you`, text: lines.join('\n') });
  await kvSet(db, 'digest:last', today);
  return { sent: true, ready: ready.length, review: review.length };
}
