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
import { CONFIRMATION, applyUrl, prefillPage } from '../lib/prefill.mjs';

const envFile = path.resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const limit = Number(process.argv[process.argv.indexOf('--limit') + 1]) || 5;

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
    const page = await context.newPage();
    console.log(`\n${app.title} at ${app.company}\n  ${app.url}`);
    await page.goto(applyUrl(app.url), { waitUntil: 'domcontentloaded' });
    const { filled, resume: attached } = await prefillPage(page, answerPack(profile, app).fields, resumePath);
    console.log(`  Prefilled: ${filled.join(', ') || 'nothing recognised'}${attached ? '; resume attached' : '; attach the resume yourself'}.`);
    console.log('  Review every answer, complete the rest, then press Submit yourself. Close the tab to skip.');

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
