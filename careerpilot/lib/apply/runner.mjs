// Submits prepared portal applications through the employer's Workday site (lib/apply/workday.mjs) and
// records each outcome on the application, so the dashboard shows what happened and what is needed.
//   submitted  -> status 'submitted' with Workday's confirmation as evidence
//   blocked    -> status 'blocked' with the exact questions or problem; retried only after the
//                 candidate's answers change (answersKey), never on every run
//   needs_you  -> 'blocked' too (a CAPTCHA): the candidate submits that one themselves
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { all, audit, kvGet, kvSet, now, one } from '../db.mjs';
import { getApplication, transition } from '../applications.mjs';
import { draftAnswer } from '../compose.mjs';
import { describeJob } from '../jobs.mjs';
import { loadProfile, loadResumePdf } from '../profile.mjs';
import { log } from '../log.mjs';
import { applyWorkday, portalHost } from './workday.mjs';

const PER_COMPANY = 3;
const companyKey = (c) => String(c ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isWorkday = (url) => { try { portalHost(url); return true; } catch { return false; } };
// Start of today in India, for the daily cap.
const todayIST = () => new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) + 'T00:00:00+05:30').toISOString();

export async function autoApply(db, settings, { launch, submit = false, limit = 5, deadline = Infinity, gmail = null, shots = null, retry = false, only = null, env = process.env } = {}) {
  if (!settings.automation.portalApplications) return { skipped: 'portal applications are turned off in Settings' };
  const profile = await loadProfile(db, env);
  const resume = await loadResumePdf(db, env);
  if (!profile || !resume) return { skipped: 'profile or resume not imported (npm run setup -- profile)' };
  const answersKey = createHash('sha256').update(JSON.stringify(profile.answers ?? {})).digest('hex').slice(0, 16);

  const sentToday = Number((await one(db, `SELECT count(*) n FROM applications WHERE method = 'portal' AND submitted_at >= ?`, [todayIST()])).n);
  const budget = Math.min(limit, Math.max(0, settings.limits.portalApplicationsPerDay - sentToday));
  const stats = { considered: 0, attempted: 0, submitted: 0, review: 0, blocked: 0, needsYou: 0, errors: 0, skippedCompanyCap: 0,
    skippedNoDescription: 0, requalifiedOut: 0, budget };
  if (!budget) return { ...stats, skipped: 'daily limit reached' };

  const candidates = await all(db, `SELECT a.id app_id, a.status app_status, a.blocked_reason, j.* FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.method = 'portal' AND j.status = 'qualified' AND j.score >= ?
      AND (a.status = 'ready' OR (a.status = 'blocked' AND a.blocked_reason NOT LIKE 'Missing answers%'))
    ORDER BY j.score DESC, coalesce(j.ai_score, 0) DESC, j.first_seen DESC`, [settings.matching.autoActionScore]);
  const applied = new Map();
  for (const r of await all(db, `SELECT j.company, count(*) n FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.status IN ('submitted', 'confirmed', 'assessment', 'interview', 'offer') GROUP BY j.company`)) applied.set(companyKey(r.company), Number(r.n));

  const dir = mkdtempSync(path.join(tmpdir(), 'careerpilot-'));
  const resumePath = path.join(dir, `${profile.name.split(/\s+/).join('_')}_Resume.pdf`);
  writeFileSync(resumePath, resume);
  const browser = await launch();
  try {
    for (const job of candidates) {
      if (stats.attempted >= budget || Date.now() > deadline) break;
      if (!isWorkday(job.url)) continue; // other portals are not automated yet
      if (only && !only.includes(companyKey(job.company))) continue;
      stats.considered++;
      const last = await kvGet(db, `apply:last:${job.app_id}`);
      if (!retry && last && last.answersKey === answersKey && ['blocked', 'needs_you', 'unconfirmed'].includes(last.stop)) continue;
      const key = companyKey(job.company);
      if ((applied.get(key) ?? 0) >= PER_COMPANY) { stats.skippedCompanyCap++; continue; }
      // A job qualified without its description has unchecked experience and pay requirements: read the
      // description and judge the job again first (the pipeline's describe stage usually has already).
      if (!job.description) {
        const jd = await describeJob(db, job, settings);
        if (!jd) { stats.skippedNoDescription++; continue; }
        const judged = await one(db, 'SELECT status, score FROM jobs WHERE id = ?', [job.id]);
        if (judged.status !== 'qualified' || judged.score < settings.matching.autoActionScore) { stats.requalifiedOut++; continue; }
        job.description = jd;
      }

      stats.attempted++;
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, locale: 'en-US' });
      const page = await context.newPage();
      // Screenshots only on a local run that asks for them (they show the candidate's details).
      const shot = shots ? async (name) => page.screenshot({ path: path.join(shots, `${companyKey(job.company).replace(/ /g, '-')}-${job.app_id.slice(0, 6)}-${name.replace(/[^\w-]+/g, '_')}.png`), fullPage: true }).catch(() => {}) : undefined;
      let r;
      try {
        // Open questions are drafted only with the candidate's say-so (answers.draft_open_answers).
        const draft = profile.answers?.draft_open_answers ? (question) => draftAnswer(db, { profile, job, question }, settings) : null;
        r = await applyWorkday({ page, job, profile, resumePath, db, gmail, dryRun: !submit, draft, shot });
      } catch (err) {
        r = { stop: 'error', reason: String(err.message).split('\n')[0].slice(0, 300) };
        await shot?.('error');
      } finally {
        await context.close().catch(() => {});
      }
      await record(db, job, r, answersKey);
      log.info('apply', { company: job.company, title: job.title, stop: r.stop, reason: r.reason?.slice(0, 300) });
      if (r.stop === 'submitted') { stats.submitted++; applied.set(key, (applied.get(key) ?? 0) + 1); }
      else if (r.stop === 'review') stats.review++;
      else if (r.stop === 'needs_you') stats.needsYou++;
      else if (r.stop === 'error') stats.errors++;
      else stats.blocked++;
    }
  } finally {
    await browser.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
  return stats;
}

// What each outcome does to the application. Employer-question answers go to the audit trail (questions
// and the short answers given), never the profile's personal values.
async function record(db, job, r, answersKey) {
  const app = await getApplication(db, job.id);
  const answered = (r.trail ?? []).flatMap((t) => (Array.isArray(t.filled) ? t.filled : []));
  if (r.stop === 'submitted') {
    await transition(db, app, 'submitted', { evidence: { type: 'workday', ...r.evidence }, reason: 'submitted on the employer’s Workday site by CareerPilot' });
    if (answered.length) await audit(db, 'application', app.id, 'answers', { detail: { questions: answered } });
  } else if (r.stop === 'review') {
    // A practice run that reaches Review clears an earlier block: nothing is left unanswered.
    if (app.status === 'blocked') await transition(db, app, 'ready', { reason: 'Filled up to Review in a practice run' });
  } else if (r.stop !== 'error') {
    const reason = r.stop === 'needs_you' ? `Needs you: ${r.reason}. Open the posting and submit it yourself.` : r.reason ?? 'Stopped';
    if (app.status === 'blocked') await one(db, 'UPDATE applications SET blocked_reason = ?, updated_at = ? WHERE id = ? RETURNING id', [reason, now(), app.id]);
    else await transition(db, app, 'blocked', { reason });
  } else if (r.stop === 'error') {
    const attempts = ((await kvGet(db, `apply:last:${app.id}`))?.errors ?? 0) + 1;
    if (attempts >= 3) await transition(db, app, 'blocked', { reason: `Automation failed ${attempts} times: ${r.reason}` });
    await kvSet(db, `apply:last:${app.id}`, { at: now(), stop: 'error', reason: r.reason, errors: attempts, answersKey: attempts >= 3 ? answersKey : null });
    return;
  }
  await kvSet(db, `apply:last:${app.id}`, { at: now(), stop: r.stop, reason: r.reason ?? null, step: r.step ?? null, answersKey });
}
