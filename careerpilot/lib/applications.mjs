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
// candidate to submit (apply-assist, on forms with a CAPTCHA). A ready portal application the candidate
// then sent on their own (confirmed, but never submitted or filled by CareerPilot) is theirs; one sent from
// CareerPilot's answer sheet is its work (evidence "answer_sheet": Lever rejects any submit from an automated
// browser, so the candidate pastes CareerPilot's answers into their own, 2026-10-19). So is one it blocked
// that the candidate then finished themselves: marked done, or acknowledged by the employer before they did
// (the candidate's choice, 2026-10-20). A posting that closed before it was applied to is not shown at all
// (the candidate's choice, 2026-10-19); the row stays, so the scanners and de-duplication still know it.
export const APPLIED = ['submitted', 'confirmed', 'assessment', 'interview', 'offer', 'rejected'];
const APPLIED_SQL = APPLIED.map((s) => `'${s}'`).join(',');
export const SHOWN_APP = `((a.method = 'email' OR a.evidence LIKE '%"type":"workday"%' OR a.evidence LIKE '%"type":"confirmation_page"%'
  OR a.evidence LIKE '%"type":"answer_sheet"%'
  OR a.id IN (SELECT entity_id FROM events WHERE entity = 'application' AND from_status = 'blocked' AND to_status IN (${APPLIED_SQL}))
  OR (a.method = 'portal' AND a.status IN ('ready','blocked','failed','withdrawn'))) AND a.status != 'expired')`;
// Jobs CareerPilot found, not ones recorded from the candidate's own application mail, nor closed ones
// unless CareerPilot applied there: an application does not vanish when its posting closes.
export const SHOWN_JOB = `(j.source NOT LIKE 'email%' AND (j.status != 'expired'
  OR EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id AND a.status IN (${APPLIED_SQL}) AND ${SHOWN_APP})))`;
// What the dashboard calls qualified, so that Qualified = Applied + still to apply: jobs CareerPilot applied
// to (whatever became of the posting since), and qualified jobs it can still apply to. Ones the candidate
// withdrew or applied to themselves are not counted (the candidate's choice, 2026-10-19).
export const QUALIFIED_JOB = `(EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id AND a.status IN (${APPLIED_SQL}) AND ${SHOWN_APP})
  OR (j.status = 'qualified' AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id
    AND (a.status NOT IN ('ready','blocked','failed') OR NOT ${SHOWN_APP}))))`;
// Mail about CareerPilot's work: linked to an application the dashboard shows, in a thread CareerPilot
// started, or waiting for review because it could be about one of several of its applications. `e` is emails.
export const SHOWN_EMAIL = `(e.application_id IN (SELECT a.id FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${SHOWN_APP})
  OR e.thread_id IN (SELECT gmail_thread_id FROM outreach WHERE gmail_thread_id IS NOT NULL)
  OR (e.needs_review = 1 AND e.application_id IS NULL
    AND lower(e.company) IN (SELECT lower(j.company) FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${SHOWN_APP})))`;

export const RANK = { ready: 0, blocked: 0, failed: 0, expired: 0, submitted: 1, confirmed: 2, assessment: 3, interview: 4, offer: 5 };
export const TERMINAL = new Set(['rejected', 'withdrawn']);

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

// A role is applied to once per posting. The same company and title already applied to under another link
// of the same posting (or another spelling of the city) makes this job a duplicate, never a second
// application. The role posted again is applied to afresh: a posting dated after that application, or,
// with no posting date, one found after the first posting closed. A role the candidate dropped stays
// dropped, reposts included (the candidate's rules, 2026-10-19). Returns the earlier application, or null.
export const roleKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export async function sameRole(db, job) {
  const rows = await all(db, `SELECT a.id, a.status, a.job_id, a.submitted_at, a.updated_at, j.title, j.status job_status
    FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.job_id != ? AND lower(j.company) = lower(?) AND (a.status IN (${APPLIED.map(() => '?').join(',')})
      OR (a.status = 'withdrawn' AND a.id IN (SELECT entity_id FROM events WHERE entity = 'application' AND to_status = 'withdrawn'
        AND detail LIKE '%"by":"candidate"%')))`, [job.id, job.company, ...APPLIED]);
  const posted = Date.parse(job.posted_at ?? '');
  return rows.find((r) => {
    if (roleKey(r.title) !== roleKey(job.title)) return false;
    if (r.status === 'withdrawn') return true; // dropped: permanent
    if (Number.isFinite(posted)) return posted <= Date.parse(r.submitted_at ?? r.updated_at); // posted again after it?
    return r.job_status !== 'expired'; // undated: a repost only once the first posting has closed
  }) ?? null;
}

// Dropping a job from the dashboard is permanent: its application (one is made if it had none) is withdrawn
// by the candidate, so the job is never applied to and a repost of the role is a duplicate (sameRole).
export async function dropJob(db, jobId) {
  if (!(await one(db, 'SELECT id FROM jobs WHERE id = ?', [jobId]))) throw new Error('Unknown job');
  const app = (await getApplication(db, jobId)) ?? await createApplication(db, jobId, { status: 'ready', method: 'portal' });
  const fresh = await one(db, 'SELECT * FROM applications WHERE id = ?', [app.id]);
  return fresh.status === 'withdrawn' || transition(db, fresh, 'withdrawn', { reason: 'Dropped by you in the dashboard', by: 'candidate' });
}

// "Done" on a blocked application: the candidate applied themselves (2026-10-20). It counts as applied from
// then on (SHOWN_APP), and the employer's acknowledgement confirms it like any other. One whose
// acknowledgement came first is already past blocked and stays as it is.
export async function markDone(db, id) {
  const app = await one(db, 'SELECT * FROM applications WHERE id = ?', [id]);
  if (!app) throw new Error('Unknown application');
  if (APPLIED.includes(app.status)) return true;
  return app.status === 'blocked'
    && transition(db, app, 'submitted', { evidence: { type: 'done', note: 'Applied by you' }, reason: 'Marked done by you in the dashboard', by: 'candidate' });
}

export async function markDuplicate(db, job, prior) {
  await run(db, `UPDATE jobs SET status = 'duplicate', duplicate_of = ? WHERE id = ?`, [prior.job_id, job.id]);
  await audit(db, 'job', job.id, 'duplicate', { from: job.status, to: 'duplicate',
    detail: { of: prior.job_id, reason: prior.status === 'withdrawn' ? 'role dropped by the candidate' : `role already applied to (${prior.status})` } });
}

export async function countSince(db, method, sinceIso) {
  return Number((await one(db, `SELECT count(*) n FROM applications WHERE method = ? AND submitted_at >= ?`, [method, sinceIso])).n);
}

export async function listApplications(db, where = '1=1', args = []) {
  return all(db, `SELECT a.*, j.company, j.title, j.url FROM applications a JOIN jobs j ON j.id = a.job_id WHERE ${where} ORDER BY a.updated_at DESC`, args);
}
