#!/usr/bin/env node
// Submits prepared applications on employer Workday sites (lib/apply/runner.mjs).
//   node scripts/auto-apply.mjs                 dry run: fills each application up to Review, submits nothing
//   node scripts/auto-apply.mjs --submit        submits
//   --limit N        at most N applications this run (default 5; the daily limit in Settings still applies)
//   --retry          also retry applications blocked earlier with the same answers (after a code fix)
//   --shots DIR      save a screenshot of every step (local debugging only: screenshots show your details)
// Outcomes land on each application in the dashboard: submitted with Workday's confirmation, or blocked
// with the exact questions that need your answer.
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { getDb, kvSet, now } from '../lib/db.mjs';
import { getSettings } from '../lib/settings.mjs';
import { connectionStatus, gmailClient } from '../lib/gmail-oauth.mjs';
import { autoApply } from '../lib/apply/runner.mjs';
import { log } from '../lib/log.mjs';

const envFile = path.resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const submit = process.argv.includes('--submit');
const limit = Number(arg('--limit')) || 5;
const shots = arg('--shots');
if (shots) mkdirSync(shots, { recursive: true });
const deadline = Date.now() + Number(process.env.RUN_BUDGET_MINUTES ?? 30) * 60_000;

const db = await getDb();
const settings = await getSettings(db);
const status = await connectionStatus(db);
const gmail = status.canRead ? await gmailClient(db) : null; // reads Workday's account-verification emails
// GitHub Actions has Playwright's own Chromium; a local run uses the installed Chrome.
const launch = () => chromium.launch(process.env.CI ? { headless: true } : { channel: 'chrome', headless: true });
const t0 = Date.now();
const result = await autoApply(db, settings, { launch, submit, limit, deadline, gmail, shots, retry: process.argv.includes('--retry') });
log.info('stage done', { stage: 'apply', ms: Date.now() - t0, submit, result });
await kvSet(db, 'run:apply', { ok: !result.errors, at: now(), ms: Date.now() - t0, result });
