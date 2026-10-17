#!/usr/bin/env node
// Local application assistant for employer ATS portals (Greenhouse, Lever, Ashby, ...).
// Opens each "ready" application in your own Chrome, fills standard fields from your verified
// profile and attaches your master resume. It never ticks consent/declaration boxes, never solves
// CAPTCHAs and never clicks Submit. When you submit, it detects the confirmation page and records
// the application as submitted with that evidence. Close the tab to skip a job.
//   npm run apply:assist              next 5 ready applications
//   npm run apply:assist -- --limit 10
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { getDb, all, one } from '../lib/db.mjs';
import { transition } from '../lib/applications.mjs';
import { loadProfile, loadResumePdf } from '../lib/profile.mjs';
import { answerPack } from '../lib/prepare.mjs';

const envFile = path.resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const limit = Number(process.argv[process.argv.indexOf('--limit') + 1]) || 5;

const CONFIRMATION = /thank(s| you) for (applying|your application)|application (has been |was )?(submitted|received)|we('ve| have) received your application|successfully (applied|submitted)/i;

function applyUrl(url) {
  const u = new URL(url);
  if (u.hostname === 'jobs.lever.co' && !u.pathname.endsWith('/apply')) u.pathname = u.pathname.replace(/\/$/, '') + '/apply';
  if (u.hostname === 'jobs.ashbyhq.com' && !u.pathname.endsWith('/application')) u.pathname = u.pathname.replace(/\/$/, '') + '/application';
  return u.toString();
}

async function fill(page, labels, value) {
  if (value == null || value === '') return false;
  for (const re of labels) {
    const field = page.getByLabel(re).first();
    try {
      if (await field.isVisible({ timeout: 500 }) && !(await field.inputValue())) { await field.fill(String(value)); return true; }
    } catch { /* not on this form */ }
  }
  return false;
}

const db = await getDb();
const profile = await loadProfile(db);
const resume = await loadResumePdf(db);
if (!profile || !resume) throw new Error('Import your profile first: npm run setup -- profile');

const apps = await all(db, `SELECT a.*, j.url, j.title, j.company, j.employment_type FROM applications a JOIN jobs j ON j.id = a.job_id
  WHERE a.status = 'ready' AND a.method = 'portal' ORDER BY j.score DESC LIMIT ?`, [limit]);
if (!apps.length) { console.log('No portal applications are ready. Blocked ones list missing answers in the dashboard.'); process.exit(0); }

const dir = mkdtempSync(path.join(tmpdir(), 'careerpilot-'));
const resumePath = path.join(dir, `${profile.name.replace(/\s+/g, '_')}_Resume.pdf`);
writeFileSync(resumePath, resume);
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext();

try {
  for (const app of apps) {
    const f = answerPack(profile, app).fields;
    const page = await context.newPage();
    console.log(`\n${app.title} at ${app.company}\n  ${app.url}`);
    await page.goto(applyUrl(app.url), { waitUntil: 'domcontentloaded' });
    const filled = [
      await fill(page, [/^first name/i, /first\s*name/i], f.first_name),
      await fill(page, [/^last name/i, /last\s*name|surname/i], f.last_name),
      await fill(page, [/^full name/i, /^name\b/i], profile.name),
      await fill(page, [/^email/i, /e-?mail/i], f.email),
      await fill(page, [/^phone/i, /phone|mobile/i], f.phone),
      await fill(page, [/linkedin/i], f.linkedin),
      await fill(page, [/github/i], f.github),
      await fill(page, [/portfolio|website|personal site/i], f.portfolio),
      await fill(page, [/current location|^location|city/i], f.location),
    ].filter(Boolean).length;
    const upload = page.locator('input[type=file]').first();
    if (await upload.count()) await upload.setInputFiles(resumePath).catch(() => {});
    console.log(`  Prefilled ${filled} fields and attached the resume. Review every answer, complete the rest, then press Submit yourself.`);

    // Wait until the confirmation page appears or the tab is closed (skip).
    const outcome = await Promise.race([
      page.waitForFunction((re) => new RegExp(re, 'i').test(document.body?.innerText ?? ''), CONFIRMATION.source, { timeout: 30 * 60_000 })
        .then(() => 'confirmed').catch(() => 'timeout'),
      page.waitForEvent('close', { timeout: 30 * 60_000 }).then(() => 'closed').catch(() => 'timeout'),
    ]);
    if (outcome === 'confirmed') {
      const text = (await page.innerText('body')).match(CONFIRMATION)?.[0];
      const fresh = await one(db, 'SELECT * FROM applications WHERE id = ?', [app.id]);
      await transition(db, fresh, 'submitted', { evidence: { type: 'confirmation_page', url: page.url(), text }, reason: 'confirmation page seen after candidate submitted', by: 'apply-assist' });
      console.log('  Recorded as submitted (confirmation page detected).');
      await page.close();
    } else console.log(`  Not submitted (${outcome}); status unchanged.`);
  }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
