// Application lifecycle with an explicit, audited state machine.
//   ready      – qualified and prepared; waiting for submission (portal needs the candidate)
//   blocked    – cannot proceed automatically; blocked_reason says why
//   failed     – an automatic submission attempt failed (e.g. Gmail send error)
//   expired    – the posting closed before submission (reopens to ready/blocked if the posting returns)
//   submitted  – we have proof we sent it (Gmail message id / confirmation page)
//   confirmed  – employer acknowledged receipt (confirmation email)
//   assessment / interview / offer / rejected / withdrawn
// "Applied" in the dashboard means submitted or later, never ready/blocked/failed.
import { randomUUID } from 'node:crypto';
import { all, audit, now, one, run } from './db.mjs';

// Applications CareerPilot created (employer portals, emailed applications), whatever happened to them
// since: the ones mail is matched against. The candidate's own (job sites, other mail) are not its work;
// the dashboard shows only its work (the candidate's choice, 2026-10-18). `a` is applications.
export const CAREERPILOT_APP = `a.method IN ('portal', 'email')`;
// What the dashboard lists: the ones it queued, and the ones it sent itself (Workday) or filled for the
// candidate to submit (apply-assist, on forms with a CAPTCHA). A queued portal application the candidate
// then sent on their own (confirmed, but never submitted or filled by CareerPilot) is theirs.
export const SHOWN_APP = `(a.method = 'email' OR a.evidence LIKE '%"type":"workday"%' OR a.evidence LIKE '%"type":"confirmation_page"%'
  OR (a.method = 'portal' AND a.status IN ('ready','blocked','failed','expired','withdrawn')))`;
// Jobs CareerPilot found, not ones recorded from the candidate's own application mail.
export const SHOWN_JOB = `j.source NOT LIKE 'email%'`;
// Mail about CareerPilot's work: linked to an application the dashboard shows, in a thread CareerPilot
// started, or waiting for review because it could be about one of several of its applications. `e` is emails.
export const SHOWN_EMAIL = `(e.application_id IN (SELECT a.id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${SHOWN_APP})
  OR e.thread_id IN (SELECT gmail_thread_id FROM outreach WHERE gmail_thread_id IS NOT NULL)
  OR (e.needs_review = 1 AND e.application_id IS NULL
    AND lower(e.company) IN (SELECT lower(j.company) FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${SHOWN_APP})))`;

export const RANK = { ready: 0, blocked: 0, failed: 0, expired: 0, submitted: 1, confirmed: 2, assessment: 3, interview: 4, offer: 5 };
export const TERMINAL = new Set(['rejected', 'withdrawn']);
export const APPLIED = ['submitted', 'confirmed', 'assessment', 'interview', 'offer', 'rejected'];

// Allowed transitions. Evidence-driven jumps (e.g. an interview invite for an application the
// candidate submitted by hand) are allowed forward from any non-terminal state.
export function canTransition(from, to) {
  if (from === to) return false;
  if (to === 'withdrawn') return !TERMINAL.has(from);
  if (from === 'withdrawn' || from === 'rejected') return false;
  if (from === 'offer') return to === 'rejected'; // offer rescinded; declining is 'withdrawn' above
  if (to === 'rejected') return true;
  // A bounce proves an emailed application never arrived, so 'submitted' can still fall back to 'failed'.
  if (to === 'failed') return RANK[from] === 0 || from === 'submitted';
  if (to === 'blocked' || to === 'ready' || to === 'expired') return RANK[from] === 0;
  return (RANK[to] ?? -1) > (RANK[from] ?? -1);
}

export async function getApplication(db, jobId) {
  return one(db, 'SELECT * FROM applications WHERE job_id = ?', [jobId]);
}

export async function createApplication(db, jobId, { status = 'ready', method = null, resumeVersion = null, blockedReason = null, answers = null } = {}) {
  const existing = await getApplication(db, jobId);
  if (existing) return existing;
  const id = randomUUID();
  const ts = now();
  await run(db, `INSERT INTO applications (id, job_id, status, method, resume_version, blocked_reason, answers, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job_id) DO NOTHING`,
  [id, jobId, status, method, resumeVersion, blockedReason, answers && JSON.stringify(answers), ts, ts]);
  const created = await getApplication(db, jobId);
  if (created.id === id) await audit(db, 'application', id, 'created', { to: status, detail: { method, blockedReason } });
  return created;
}

// Returns true when the transition happened. Evidence is appended, never overwritten.
export async function transition(db, app, to, { evidence = null, reason = null, by = 'system', at = null } = {}) {
  if (!canTransition(app.status, to)) return false;
  const ts = now();
  const ev = evidence ? [...JSON.parse(app.evidence ?? '[]'), { ...evidence, to, at: at ?? ts }] : JSON.parse(app.evidence ?? '[]');
  await run(db, `UPDATE applications SET status = ?, evidence = ?, updated_at = ?,
      blocked_reason = CASE WHEN ? = 'blocked' THEN ? ELSE NULL END,
      submitted_at = CASE WHEN submitted_at IS NULL AND ? IN ('submitted','confirmed','assessment','interview','offer') THEN ? ELSE submitted_at END,
      confirmed_at = CASE WHEN confirmed_at IS NULL AND ? = 'confirmed' THEN ? ELSE confirmed_at END
    WHERE id = ? AND status = ?`,
  [to, JSON.stringify(ev), ts, to, reason, to, at ?? ts, to, at ?? ts, app.id, app.status]);
  await audit(db, 'application', app.id, 'status', { from: app.status, to, detail: { by, reason, evidence } });
  Object.assign(app, { status: to });
  return true;
}

export async function countSince(db, method, sinceIso) {
  return Number((await one(db, `SELECT count(*) n FROM applications WHERE method = ? AND submitted_at >= ?`, [method, sinceIso])).n);
}

export async function listApplications(db, where = '1=1', args = []) {
  return all(db, `SELECT a.*, j.company, j.title, j.url FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${where} ORDER BY a.updated_at DESC`, args);
}
