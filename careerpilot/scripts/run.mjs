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
import { reevaluateAll } from '../lib/jobs.mjs';
import { RULES_VERSION } from '../lib/match.mjs';
import { aiScoreJobs } from '../lib/ai-match.mjs';
import { createGmail, gmailConfigured, GmailAuthError } from '../lib/gmail.mjs';
import { syncGmail } from '../lib/gmail-sync.mjs';
import { prepareApplications, sendDigest } from '../lib/prepare.mjs';
import { runOutreach } from '../lib/outreach.mjs';
import { log } from '../lib/log.mjs';

const envFile = path.resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const BUDGET_MS = Number(process.env.RUN_BUDGET_MINUTES ?? 12) * 60_000;
const deadline = Date.now() + BUDGET_MS;
const gmail = gmailConfigured() ? createGmail() : null;
const needsGmail = (fn) => async (db, settings) => (gmail ? fn(db, settings) : { skipped: 'Gmail not authorized (npm run gmail:auth)' });

const STAGES = {
  async discover(db, settings) {
    await seedCuratedBoards(db);
    const rulesKey = JSON.stringify([RULES_VERSION, settings.compensation, settings.matching, settings.locations]);
    const rescored = rulesKey !== (await kvGet(db, 'rules:key')) ? await reevaluateAll(db, settings) : 0;
    await kvSet(db, 'rules:key', rulesKey);
    const aggregator = await sweepAggregator(db, settings);
    const boards = await scanBoards(db, settings, { deadline: deadline - 5 * 60_000 });
    return { rescored, aggregator, boards };
  },
  ai: (db, settings) => aiScoreJobs(db, settings),
  gmail: needsGmail((db, settings) => syncGmail(db, gmail, settings, { deadline: deadline - 3 * 60_000 })),
  prepare: (db, settings) => prepareApplications(db, settings),
  outreach: needsGmail((db, settings) => runOutreach(db, gmail, settings, { deadline: deadline - 60_000 })),
  digest: needsGmail((db, settings) => sendDigest(db, gmail, settings)),
};

async function main() {
  const which = process.argv[2] ?? 'all';
  const names = which === 'all' ? Object.keys(STAGES) : which.split(',');
  const db = await getDb();
  const settings = await getSettings(db);
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
      if (err instanceof GmailAuthError) await kvSet(db, 'gmail:status', { ok: false, at: now(), error: err.message });
      log.error('stage failed', { stage: name, error: err.message, stack: err.stack?.split('\n').slice(0, 4).join(' | ') });
      await kvSet(db, `run:${name}`, { ok: false, at: now(), error: String(err.message).slice(0, 500) });
    }
  }
  await kvSet(db, 'run:last', { at: now(), stages: names, failed });
  process.exitCode = failed ? 1 : 0;
}

await main();
