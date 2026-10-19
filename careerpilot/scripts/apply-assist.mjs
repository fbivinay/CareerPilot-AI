#!/usr/bin/env node
// Local application assistant for employer ATS portals (Greenhouse, Lever, Ashby, ...), whose forms carry
// CAPTCHAs, so a person submits them. Opens each "ready" application in your own Chrome, fills your details,
// attaches your resume and answers the employer's questions from your profile (the same rules as Workday
// applications). It never solves CAPTCHAs and never clicks Submit: you check the form, finish anything it
// lists as left, and submit. It then detects the confirmation page and records the application as
// submitted with that evidence. Close the tab to skip a job. (Workday applications are submitted by
// scripts/auto-apply.mjs.)
//   npm run apply:assist              next 5 ready applications
//   npm run apply:assist -- --limit 10
//   npm run apply:assist -- --limit 21 --parallel   every form filled in its own tab without waiting for you;
//                                                   submit them in any order while the rest fill
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { getDb, all, one } from '../lib/db.mjs';
import { transition } from '../lib/applications.mjs';
import { loadProfile, loadResumePdf } from '../lib/profile.mjs';
import { answerPack } from '../lib/prepare.mjs';
import { CONFIRMATION, answerQuestions, applyUrl, prefillPage } from '../lib/prefill.mjs';
import { askContext } from '../lib/apply/workday.mjs';
import { draftAnswer } from '../lib/compose.mjs';
import { getSettings } from '../lib/settings.mjs';

const envFile = path.resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const limit = Number(process.argv[process.argv.indexOf('--limit') + 1]) || 5;
const parallel = process.argv.includes('--parallel');
const timeout = (parallel ? 90 : 30) * 60_000;

const db = await getDb();
const profile = await loadProfile(db);
const resume = await loadResumePdf(db);
if (!profile || !resume) throw new Error('Import your profile first: npm run setup -- profile');

const settings = await getSettings(db);
const apps = await all(db, `SELECT a.*, j.id job_id, j.url, j.title, j.company, j.location, j.source, j.description, j.employment_type
  FROM applications a JOIN jobs j ON j.id = a.job_id
  WHERE a.status = 'ready' AND a.submitted_at IS NULL AND a.method = 'portal' AND j.url NOT LIKE '%.myworkdayjobs.com/%' ORDER BY j.score DESC LIMIT ?`, [limit]);
if (!apps.length) { console.log('No portal applications are ready. Blocked ones list missing answers in the dashboard.'); process.exit(0); }

const dir = mkdtempSync(path.join(tmpdir(), 'careerpilot-'));
const resumePath = path.join(dir, `${profile.name.replace(/\s+/g, '_')}_Resume.pdf`);
writeFileSync(resumePath, resume);
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext();

// Waits until the confirmation page appears or the tab is closed (skip), and records a submission. Polled
// every second rather than per frame, since a tab you are not looking at draws no frames.
async function finish(page, app) {
  const outcome = await Promise.race([
    page.waitForFunction((re) => new RegExp(re, 'i').test(document.body?.innerText ?? ''), CONFIRMATION.source, { timeout, polling: 1000 })
      .then(() => 'confirmed').catch(() => 'timeout'),
    page.waitForEvent('close', { timeout }).then(() => 'closed').catch(() => 'timeout'),
  ]);
  if (outcome !== 'confirmed') return console.log(`  ${app.title} at ${app.company}: not submitted (${outcome}); status unchanged.`);
  // Never throws: in --parallel a failure here would end the run and close the tabs still being filled in.
  try {
    const text = (await page.innerText('body')).match(CONFIRMATION)?.[0];
    const fresh = await one(db, 'SELECT * FROM applications WHERE id = ?', [app.id]);
    await transition(db, fresh, 'submitted', { evidence: { type: 'confirmation_page', url: page.url(), text }, reason: 'confirmation page seen after candidate submitted', by: 'apply-assist' });
    console.log(`  ${app.title} at ${app.company}: recorded as submitted (confirmation page detected).`);
    await page.close();
  } catch (err) {
    console.log(`  ${app.title} at ${app.company}: confirmation seen, but NOT recorded (${err.message.split('\n')[0]}); mark it submitted in the dashboard.`);
  }
}

try {
  const open = [];
  for (const app of apps) {
    const page = await context.newPage();
    console.log(`\n${app.title} at ${app.company}\n  ${app.url}`);
    try {
      await page.goto(applyUrl(app.url), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000); // the form renders after the page loads
      // BambooHR shows its form only after "Apply for This Job" (Saltmine, LJI).
      if (await page.getByRole('button', { name: /^apply for this job$/i }).first().click({ timeout: 2000 }).then(() => true, () => false)) await page.waitForTimeout(2500);
      const { filled, resume: attached } = await prefillPage(page, answerPack(profile, app).fields, resumePath);
      console.log(`  Prefilled: ${filled.join(', ') || 'nothing recognised'}${attached ? '; resume attached' : '; attach the resume yourself'}.`);
      const ctx = await askContext(db, { ...app, id: app.job_id }, profile);
      if (profile.answers?.draft_open_answers) ctx.draft = (question) => draftAnswer(db, { profile, job: app, question }, settings);
      const { answered, left } = await answerQuestions(page, ctx);
      console.log(`  Answered ${answered.length} of the employer's questions.`);
      if (left.length) console.log(`  Still needed from you:\n    - ${left.join('\n    - ')}`);
      console.log('  Check every answer, complete anything left, tick the CAPTCHA if shown, then press Submit. Close the tab to skip.');
    } catch (err) {
      console.log(`  Could not fill this form (${err.message.split('\n')[0]}). The tab stays open: fill it yourself, or close it to skip.`);
    }
    const done = finish(page, app);
    if (parallel) open.push(done); else await done;
  }
  await Promise.all(open);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}
