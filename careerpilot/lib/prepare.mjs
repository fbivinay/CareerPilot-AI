// Prepares applications for qualified jobs that are not handled by email:
//   portal jobs (Greenhouse/Lever/Ashby/Workday/...) -> 'ready' with a prefill answer pack, or
//   'blocked' when an answer the form needs is unknown. Candidate-side submission on these portals
//   needs the candidate (consent declarations, CAPTCHA, account login), so they are never auto-submitted.
//   job-board alerts (LinkedIn, Naukri, ...) -> 'ready' for applying on that platform.
import { all, kvGet, kvSet, now } from './db.mjs';
import { createApplication } from './applications.mjs';
import { applicationEmail } from './contacts.mjs';
import { loadProfile } from './profile.mjs';

const REQUIRED = {
  full_time: ['earliest_full_time_start', 'indian_work_authorization'],
  internship: ['internship_available_from', 'internship_duration_months', 'indian_work_authorization'],
  contract: ['indian_work_authorization'],
};

export function answerPack(profile, job) {
  const a = profile.answers ?? {};
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

export async function prepareApplications(db, settings, { env = process.env } = {}) {
  const profile = await loadProfile(db, env);
  if (!profile) return { skipped: 'profile not imported' };
  const jobs = await all(db, `SELECT j.* FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
    WHERE j.status = 'qualified' AND a.id IS NULL AND j.score >= ? ORDER BY j.score DESC LIMIT 200`, [settings.matching.autoActionScore]);
  const stats = { ready: 0, blocked: 0, email: 0 };
  for (const job of jobs) {
    if (applicationEmail(job.description)) { stats.email++; continue; } // handled by the outreach stage
    const pack = answerPack(profile, job);
    const platform = job.source.startsWith('alert:') ? job.source.slice(6) : null;
    const blocked = pack.missing.length ? `Missing answers: ${pack.missing.join(', ')} (fill them in private/profile.yml)` : null;
    await createApplication(db, job.id, {
      status: blocked ? 'blocked' : 'ready',
      method: platform ? `platform:${platform}` : 'portal',
      resumeVersion: profile.resume?.version,
      blockedReason: blocked ?? (platform ? `Apply on ${platform}; job boards do not permit automated applications`
        : 'Employer portal: submit yourself (consent declarations / CAPTCHA). Use the answer pack or npm run apply:assist'),
      answers: pack.fields,
    });
    blocked ? stats.blocked++ : stats.ready++;
  }
  return stats;
}

// Once a day, email the candidate a summary of what needs them. Uses the same gmail.send scope.
export async function sendDigest(db, gmail, settings, { env = process.env } = {}) {
  const today = now().slice(0, 10);
  if ((await kvGet(db, 'digest:last')) === today) return { skipped: 'already sent today' };
  const to = env.GMAIL_ADDRESS;
  if (!to) return { skipped: 'GMAIL_ADDRESS not set' };
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
  await gmail.send({ to, subject: `CareerPilot: ${ready.length} applications, ${review.length} emails need you`, text: lines.join('\n') });
  await kvSet(db, 'digest:last', today);
  return { sent: true, ready: ready.length, review: review.length };
}
