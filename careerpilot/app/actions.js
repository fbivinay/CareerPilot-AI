'use server';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { audit, getDb, now, one, run } from '@/lib/db.mjs';
import { COOKIE, MAX_AGE, createSession, verifySession } from '@/lib/session.mjs';
import { createApplication, transition } from '@/lib/applications.mjs';
import { applyEvaluation } from '@/lib/evaluate.mjs';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '@/lib/settings.mjs';
import { addManualContact } from '@/lib/outreach.mjs';

const readOnly = () => process.env.DASHBOARD_READONLY === '1';

async function requireSession({ write = true } = {}) {
  if (!(await verifySession((await cookies()).get(COOKIE)?.value))) redirect('/login');
  if (write && readOnly()) throw new Error('This dashboard is deployed read-only.');
}

function checkPassword(password) {
  const stored = process.env.DASHBOARD_PASSWORD_HASH;
  if (!stored || !password) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

export async function login(_prev, formData) {
  const ok = checkPassword(String(formData.get('password') ?? ''));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 1200)); // slows guessing
    return { error: process.env.DASHBOARD_PASSWORD_HASH ? 'Incorrect password.' : 'No password configured. Run: npm run setup -- password' };
  }
  (await cookies()).set(COOKIE, await createSession(), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: MAX_AGE, path: '/',
  });
  redirect(safeNext(formData.get('next')));
}

// Only same-origin paths; "//host", "/\host" and absolute URLs resolve to another origin and are refused.
function safeNext(raw) {
  try {
    const u = new URL(String(raw ?? '/'), 'http://local.invalid');
    return u.origin === 'http://local.invalid' ? u.pathname + u.search : '/';
  } catch {
    return '/';
  }
}

export async function logout() {
  (await cookies()).delete(COOKIE);
  redirect('/login');
}

const MANUAL_STATUSES = ['submitted', 'confirmed', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn', 'ready', 'blocked'];

export async function setApplicationStatus(formData) {
  await requireSession();
  const db = await getDb();
  const app = await one(db, 'SELECT * FROM applications WHERE id = ?', [String(formData.get('id'))]);
  const to = String(formData.get('status'));
  const note = String(formData.get('note') ?? '').slice(0, 500);
  if (!app || !MANUAL_STATUSES.includes(to)) throw new Error('Invalid application or status');
  const ok = await transition(db, app, to, { evidence: { type: 'manual', note: note || null }, reason: note || 'set in dashboard', by: 'candidate' });
  if (!ok) throw new Error(`Cannot move from ${app.status} to ${to}`);
  revalidatePath('/', 'layout');
}

export async function startApplication(formData) {
  await requireSession();
  const db = await getDb();
  const jobId = String(formData.get('jobId'));
  const app = await createApplication(db, jobId, { status: 'ready', method: 'manual' });
  redirect(`/applications/${app.id}`);
}

export async function setJobStatus(formData) {
  await requireSession();
  const db = await getDb();
  const job = await one(db, 'SELECT * FROM jobs WHERE id = ?', [String(formData.get('id'))]);
  const action = String(formData.get('action'));
  if (!job) throw new Error('Unknown job');
  if (action === 'exclude') {
    await run(db, `UPDATE jobs SET status = 'excluded', exclusion_reason = ? WHERE id = ?`, ['Excluded by you in the dashboard', job.id]);
    await audit(db, 'job', job.id, 'reevaluated', { from: job.status, to: 'excluded', detail: { by: 'candidate' } });
  } else if (action === 'reevaluate') {
    await applyEvaluation(db, { ...job, status: 'new', ai_score: null }, await getSettings(db));
  }
  revalidatePath('/', 'layout');
}

export async function markEmailReviewed(formData) {
  await requireSession();
  const db = await getDb();
  await run(db, 'UPDATE emails SET reviewed = 1, needs_review = 0 WHERE id = ?', [String(formData.get('id'))]);
  revalidatePath('/', 'layout');
}

export async function linkEmailToApplication(formData) {
  await requireSession();
  const db = await getDb();
  const app = await one(db, 'SELECT * FROM applications WHERE id = ?', [String(formData.get('applicationId'))]);
  const email = await one(db, 'SELECT * FROM emails WHERE id = ?', [String(formData.get('id'))]);
  if (!app || !email) throw new Error('Unknown email or application');
  await run(db, 'UPDATE emails SET application_id = ?, job_id = ?, reviewed = 1, needs_review = 0 WHERE id = ?', [app.id, app.job_id, email.id]);
  await audit(db, 'email', email.id, 'linked', { detail: { applicationId: app.id, by: 'candidate' } });
  revalidatePath('/', 'layout');
}

export async function addContact(formData) {
  await requireSession();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new Error('Invalid email');
  await addManualContact(await getDb(), { email, name: String(formData.get('name') ?? '') || null, company: String(formData.get('company') ?? '') || null });
  revalidatePath('/outreach');
}

const num = (v, min, max) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Value ${v} out of range`); return n; };

export async function updateSettings(formData) {
  await requireSession();
  const db = await getDb();
  const d = DEFAULT_SETTINGS;
  const list = (v) => String(v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const on = (k) => formData.get(k) === 'on';
  const s = {
    compensation: { fullTimeMinLpa: num(formData.get('fullTimeMinLpa'), 0, 100), internshipMinMonthly: num(formData.get('internshipMinMonthly'), 0, 500000) },
    matching: { ...d.matching, qualifyScore: num(formData.get('qualifyScore'), 0, 100), autoActionScore: num(formData.get('autoActionScore'), 0, 100),
      maxExperienceYears: num(formData.get('maxExperienceYears'), 0, 10), includeInternships: on('includeInternships') },
    locations: { primary: list(formData.get('primary')), india: list(formData.get('india')) },
    automation: { emailApplications: on('emailApplications'), outreach: on('outreach'), followUps: on('followUps'), actOnUndisclosedComp: on('actOnUndisclosedComp') },
    limits: { ...d.limits, outreachPerDay: num(formData.get('outreachPerDay'), 0, 100), emailApplicationsPerDay: num(formData.get('emailApplicationsPerDay'), 0, 100),
      perCompanyCooldownDays: num(formData.get('perCompanyCooldownDays'), 1, 365), maxContactsPerCompany: num(formData.get('maxContactsPerCompany'), 1, 10),
      followUpAfterDays: num(formData.get('followUpAfterDays'), 1, 60), maxFollowUps: num(formData.get('maxFollowUps'), 0, 3),
      sendWindow: { ...d.limits.sendWindow, startHour: num(formData.get('startHour'), 0, 24), endHour: num(formData.get('endHour'), 0, 24) } },
    ai: { ...d.ai, order: list(formData.get('aiOrder')).filter((p) => d.ai.order.includes(p)), maxCallsPerHour: num(formData.get('maxCallsPerHour'), 0, 500) },
  };
  if (!s.locations.primary.length) throw new Error('At least one primary location is required');
  await saveSettings(db, s);
  await audit(db, 'settings', 'settings', 'updated', { detail: { at: now() } });
  revalidatePath('/', 'layout');
  redirect('/settings?saved=1');
}
