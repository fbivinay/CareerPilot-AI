#!/usr/bin/env node
// Pipeline entry point, used by GitHub Actions and locally:
//   node scripts/run.mjs [all | discover,ai,gmail,prepare,outreach,digest]
// Stages are idempotent and time-boxed. A failing stage is logged and recorded for the dashboard;
// the remaining stages still run. Work that cannot be done now (quota, auth) stays queued.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getDb, kvGet, kvSet, now } from '../lib/db.mjs';
import { getSettings } from '../lib/settings.mjs';
import { scanBoards, seedCuratedBoards, sweepAggregator } from '../lib/discover.mjs';
import { describeMissing, reevaluateAll } from '../lib/jobs.mjs';
import { RULES_VERSION } from '../lib/match.mjs';
import { aiScoreJobs } from '../lib/ai-match.mjs';
import { GmailAuthError } from '../lib/gmail.mjs';
import { connectionStatus, gmailClient, markAuthFailure } from '../lib/gmail-oauth.mjs';
import { syncGmail } from '../lib/gmail-sync.mjs';
import { prepareApplications, sendBlockedAlert, sendDigest } from '../lib/prepare.mjs';
import { runOutreach } from '../lib/outreach.mjs';
import { log } from '../lib/log.mjs';

const envFile = path.resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const BUDGET_MS = Number(process.env.RUN_BUDGET_MINUTES ?? 7) * 60_000;
const deadline = Date.now() + BUDGET_MS;
let gmail = null;
let gmailStatus = null;
// Reading needs a connected mailbox; sending also needs the send permission and a passed read-only test.
const needsGmail = (fn) => async (db, settings) => (gmail && gmailStatus.canRead ? fn(db, settings)
  : { skipped: 'Gmail not connected (Settings → Gmail → Connect Gmail)' });
const needsSending = (fn) => async (db, settings) => (gmail && gmailStatus.canSend ? fn(db, settings)
  : { skipped: gmailStatus?.canRead ? 'Sending not enabled (Settings → Gmail: read-only test, then Enable sending)' : 'Gmail not connected' });

const STAGES = {
  async discover(db, settings) {
    await seedCuratedBoards(db);
    const rulesKey = JSON.stringify([RULES_VERSION, settings.compensation, settings.matching, settings.locations, settings.timeline]);
    const rescored = rulesKey !== (await kvGet(db, 'rules:key')) ? await reevaluateAll(db, settings) : 0;
    await kvSet(db, 'rules:key', rulesKey);
    const aggregator = await sweepAggregator(db, settings);
    // Board scans get what is left after leaving ~2.5 min for Gmail, AI scoring and outreach.
    const boards = await scanBoards(db, settings, { deadline: deadline - 150_000 });
    return { rescored, aggregator, boards };
  },
  // Descriptions for qualified jobs found without one, so their requirements are checked (and AI-scored).
  describe: (db, settings) => describeMissing(db, settings, { deadline: deadline - 140_000 }),
  // Free-tier token limits make scoring ~10 s a job; stop early so Gmail and outreach always run.
  ai: (db, settings) => aiScoreJobs(db, settings, { deadline: deadline - 120_000 }),
  gmail: needsGmail((db, settings) => syncGmail(db, gmail, settings, { deadline: deadline - 90_000 })),
  prepare: (db, settings) => prepareApplications(db, settings),
  outreach: needsSending((db, settings) => runOutreach(db, gmail, settings, { deadline: deadline - 60_000 })),
  // Blocked applications are emailed on every run; the digest goes once a day.
  digest: needsSending(async (db, settings) => ({ blocked: await sendBlockedAlert(db, gmail, { to: gmailStatus.email }),
    digest: await sendDigest(db, gmail, settings, { to: gmailStatus.email }) })),
};

async function main() {
  const which = process.argv[2] ?? 'all';
  const names = which === 'all' ? Object.keys(STAGES) : which.split(',');
  const db = await getDb();
  const settings = await getSettings(db);
  gmailStatus = await connectionStatus(db);
  gmail = gmailStatus.canRead ? await gmailClient(db) : null;
  let failed = false;
  for (const name of names) {
    if (!STAGES[name]) throw new Error(`unknown stage: ${name}`);
    if (Date.now() > deadline) { log.warn('time budget exhausted, deferring stage', { stage: name }); continue; }
    const t0 = Date.now();
    try {
      const result = await STAGES[name](db, settings);
      log.info('stage done', { stage: name, ms: Date.now() - t0, result });
      await kvSet(db, `run:${name}`, { ok: true, at: now(), ms: Date.now() - t0, result });
    } catch (err) {
      failed = true;
      if (err instanceof GmailAuthError) await markAuthFailure(db, err.message);
      log.error('stage failed', { stage: name, error: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') });
      await kvSet(db, `run:${name}`, { ok: false, at: now(), error: String(err.message).slice(0, 500) });
    }
  }
  await kvSet(db, 'run:last', { at: now(), stages: names, failed });
  process.exitCode = failed ? 1 : 0;
}

await main();
