// Prepares applications for qualified jobs that are not handled by email:
//   portal jobs (Greenhouse/Lever/Ashby/Workday/...) -> 'ready' with a prefill answer pack, or
//   'blocked' when an answer the form needs is unknown. Candidate-side submission on these portals
//   needs the candidate (consent declarations, CAPTCHA, account login), so they are never auto-submitted.
//   job-board alerts (LinkedIn, Naukri, ...) -> 'ready' for applying on that platform.
import { all, kvGet, kvSet, now, run } from './db.mjs';
import { createApplication, transition } from './applications.mjs';
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
      graduation: a.graduation_month,
      ...Object.fromEntries(Object.entries(a).filter(([, v]) => v != null)),
    },
  };
}

// What an application for this job needs next: 'blocked' when an answer is missing, otherwise 'ready'
// with a note on how it gets submitted.
export function nextStep(job, pack) {
  if (pack.missing.length) {
    return { status: 'blocked', reason: `Missing answers: ${pack.missing.join(', ')} (fill them in private/profile.yml, then npm run setup -- profile)` };
  }
  const platform = job.source?.startsWith('alert:') ? job.source.slice(6) : null;
  return { status: 'ready', reason: platform ? `Apply on ${platform}; job boards do not permit automated applications`
    : 'Employer portal: submit yourself (consent declarations / CAPTCHA). Use the answer pack or npm run apply:assist' };
}

export async function prepareApplications(db, settings, { env = process.env } = {}) {
  const profile = await loadProfile(db, env);
  if (!profile) return { skipped: 'profile not imported' };
  const stats = { ready: 0, blocked: 0, email: 0, unblocked: 0, reopened: 0, withdrawn: 0 };

  const jobs = await all(db, `SELECT j.* FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
    WHERE j.status = 'qualified' AND a.id IS NULL AND j.score >= ? ORDER BY j.score DESC LIMIT 200`, [settings.matching.autoActionScore]);
  for (const job of jobs) {
    if (applicationEmail(job.description)) { stats.email++; continue; } // handled by the outreach stage
    const step = nextStep(job, answerPack(profile, job));
    const platform = job.source.startsWith('alert:') ? job.source.slice(6) : null;
    // Answers are not copied into the database; the answer pack is rebuilt from the encrypted profile when shown.
    await createApplication(db, job.id, { status: step.status, method: platform ? `platform:${platform}` : 'portal',
      resumeVersion: profile.resume?.version, blockedReason: step.reason });
    stats[step.status]++;
  }

  // Not-yet-submitted applications this stage prepared, for jobs that no longer qualify (rules or settings
  // changed), are withdrawn with the reason. Applications you track yourself or that came from email stay.
  const stale = await all(db, `SELECT a.*, j.exclusion_reason FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.status IN ('ready', 'blocked', 'failed') AND j.status = 'excluded' AND a.method != 'manual' AND j.source NOT LIKE 'email%'`);
  for (const app of stale) {
    if (await transition(db, app, 'withdrawn', { reason: `No longer matches your criteria: ${app.exclusion_reason}`, by: 'system' })) stats.withdrawn++;
  }

  // Applications blocked on answers you have since provided, and ones whose posting reopened.
  const recheck = await all(db, `SELECT a.*, j.employment_type, j.source FROM applications a JOIN jobs j ON j.id = a.job_id
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
export async function sendDigest(db, gmail, settings, { to, env = process.env } = {}) {
  const today = now().slice(0, 10);
  if ((await kvGet(db, 'digest:last')) === today) return { skipped: 'already sent today' };
  if (!to) return { skipped: 'connected mailbox unknown' };
  const ready = await all(db, `SELECT j.title, j.company, j.url, a.status, a.blocked_reason FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.status IN ('ready', 'blocked', 'failed') ORDER BY j.score DESC LIMIT 25`);
  const review = await all(db, `SELECT subject, from_addr, category FROM emails WHERE needs_review = 1 AND reviewed = 0 ORDER BY received_at DESC LIMIT 15`);
  const upcoming = await all(db, `SELECT subject, extracted FROM emails WHERE category IN ('interview', 'assessment') AND received_at >= ? ORDER BY received_at DESC LIMIT 10`,
    [new Date(Date.now() - 7 * 864e5).toISOString()]);
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
