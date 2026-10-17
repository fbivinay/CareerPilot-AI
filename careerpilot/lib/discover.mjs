// Job discovery from permitted public sources:
//  1. Tracked ATS boards (Greenhouse/Lever/Ashby/SmartRecruiters/Workable/... via career-ops providers).
//  2. A daily sweep of the public job-board-aggregator dataset (ATS postings across ~29k companies),
//     used to find Indian roles and to auto-add their employers' boards to (1).
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { loadProviders, resolveProvider } from '../../providers/_registry.mjs';
import { makeHttpCtx } from '../../providers/_http.mjs';
import { all, kvGet, kvSet, now, run } from './db.mjs';
import { canonicalUrl, expireMissing, jobId, touchKnown, upsertJob } from './jobs.mjs';
import { locationTier, roleFamily } from './match.mjs';
import { log } from './log.mjs';

const PROVIDERS_DIR = path.resolve(import.meta.dirname, '../../providers');
const AGGREGATOR = 'https://feashliaa.github.io/job-board-data/data';

let providersPromise;
const providers = () => (providersPromise ??= loadProviders(PROVIDERS_DIR));

const boardIdFor = (url) => url.toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');

export async function addBoard(db, { name, careers_url, origin }) {
  const id = boardIdFor(careers_url);
  await run(db, `INSERT INTO boards (id, name, careers_url, origin) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    [id, name, careers_url, origin]);
  return id;
}

export async function seedCuratedBoards(db, file = path.resolve(import.meta.dirname, '../config/companies.yml')) {
  const list = loadYaml(readFileSync(file, 'utf8'))?.companies ?? [];
  for (const c of list) await addBoard(db, { name: c.name, careers_url: c.careers_url, origin: 'curated' });
  return list.length;
}

// Cheap prefilter: keep postings that could be in India; everything else is irrelevant noise.
const maybeIndia = (loc, settings) => !loc || locationTier(loc, '', settings).tier != null || /remote/i.test(loc);

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// The places the candidate looks in, for providers that can filter by location (Workday's location facet).
export const placesFilter = (settings) => new RegExp(`\\b(${['india', ...settings.locations.primary, ...settings.locations.india]
  .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

// A request refused because the run's time is up. The 499 status makes the providers' retry layer give up at once.
class ScanDeadline extends Error { status = 499; }
// This many transport failures in a row from one provider means the vendor itself is down (Workday redirects
// every tenant to a maintenance page on weekends); its remaining boards wait for the next run.
const OUTAGE_AFTER = 5;

export async function scanBoards(db, settings, { limit = 400, staleHours = 5, deadline = Infinity } = {}) {
  const ps = await providers();
  const ctx = makeHttpCtx();
  ctx.locationFilter = placesFilter(settings);
  // Requests stop at the deadline even inside a board, so one large board cannot overrun the run.
  for (const m of ['fetchJson', 'fetchText', 'fetchResponse']) {
    const original = ctx[m];
    ctx[m] = (url, opts) => (Date.now() > deadline ? Promise.reject(new ScanDeadline('scan time budget reached')) : original(url, opts));
  }
  const outage = new Map(); // provider id -> transport failures in a row this run
  const cutoff = new Date(Date.now() - staleHours * 36e5).toISOString();
  // Least-recently scanned first, so a time-boxed run rotates through every board. A failing board backs
  // off (retried after fail_count x staleHours, at most 6x), so outages do not eat every run's time.
  const boards = (await all(db, `SELECT * FROM boards WHERE enabled = 1 AND (last_scan IS NULL OR last_scan < ?)
    ORDER BY last_scan IS NOT NULL, last_scan`, [cutoff]))
    .filter((b) => !b.fail_count || Date.now() - Date.parse(b.last_scan) > Math.min(b.fail_count, 6) * staleHours * 36e5)
    .slice(0, limit);
  const stats = { boards: boards.length, ok: 0, failed: 0, created: 0, qualified: 0, expired: 0 };

  await pool(boards, 6, async (b) => {
    if (Date.now() > deadline) return;
    const entry = { name: b.name, careers_url: b.careers_url };
    const started = now();
    const r = resolveProvider(entry, ps);
    const vendor = r?.provider?.id;
    if ((outage.get(vendor) ?? 0) >= OUTAGE_AFTER) { stats.deferred = (stats.deferred ?? 0) + 1; return; }
    try {
      if (!r?.provider) throw new Error(r?.error ?? 'no provider for this careers URL');
      const jobs = await r.provider.fetch(entry, ctx);
      outage.set(vendor, 0);
      // A location-filtered crawl returns only postings the employer files under an Indian place; say so
      // where the posting's own label does not ("Ind – Blr Sez 1", "2 Locations").
      const inIndia = (j) => (jobs.workdayNarrowed && String(j.location ?? '').search(ctx.locationFilter) === -1
        ? { ...j, location: j.location ? `${j.location}, India` : 'India' } : j);
      const relevant = jobs.map(inIndia).filter((j) => maybeIndia(j.location, settings)).map((j) => ({ ...j, company: b.name }));
      const { rest, seen } = await touchKnown(db, relevant);
      for (const j of rest) {
        const res = await upsertJob(db, j, { source: r.provider.id, ats: r.provider.id, boardId: b.id, settings });
        if (!res) continue;
        seen.add(res.id);
        if (res.duplicateOf) seen.add(res.duplicateOf);
        if (res.created) stats.created++;
        if (res.changed && res.status === 'qualified') stats.qualified++;
      }
      // Closed means "the employer no longer lists it", independent of our relevance filter. A partial
      // list (pagination cut short, or the run's time ran out) proves nothing about what is missing.
      for (const j of jobs) if (j.url) seen.add(jobId(canonicalUrl(j.url)));
      const cut = Date.now() > deadline;
      if (!jobs.workdayTruncated && !cut) {
        stats.expired += await expireMissing(db, b.id, seen, jobs.workdayNarrowed ? { places: ctx.locationFilter } : {});
      }
      // A board the deadline cut keeps its old last_scan, so it is first in line next run.
      if (cut) await run(db, 'UPDATE boards SET jobs_seen = ? WHERE id = ?', [jobs.length, b.id]);
      else {
        await run(db, `UPDATE boards SET last_scan = ?, last_ok = ?, fail_count = 0, last_error = NULL, jobs_seen = ? WHERE id = ?`,
          [started, started, jobs.length, b.id]);
      }
      stats.ok++;
    } catch (err) {
      if (err instanceof ScanDeadline) return; // not the board's fault; it is first in line next run
      if (err.status === undefined) outage.set(vendor, (outage.get(vendor) ?? 0) + 1);
      const fails = b.fail_count + 1;
      // "fetch failed" alone hides the reason; the cause says it ("unexpected redirect" = maintenance page).
      const error = err.cause?.message ? `${err.message}: ${err.cause.message}` : err.message;
      // Only a board that is repeatedly gone is disabled: 404/410 three times, or redirected away for days
      // (scans back off, so the sixth redirect comes ~3 days after the first, past any weekend maintenance).
      // Other network errors and vendor maintenance pages are transient.
      const gone = (/HTTP (404|410)/.test(error) && fails >= 3) || (/unexpected redirect/.test(error) && fails >= 6);
      await run(db, `UPDATE boards SET last_scan = ?, fail_count = ?, last_error = ?, enabled = ? WHERE id = ?`,
        [started, fails, error.slice(0, 300), gone ? 0 : 1, b.id]);
      stats.failed++;
      log.warn('board scan failed', { board: b.id, error });
    }
  });
  return stats;
}

// Map an aggregator posting URL to the employer's board URL a provider can scan.
export function boardFromPostingUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const seg = u.pathname.split('/').filter(Boolean);
  if (/(^|\.)greenhouse\.io$/.test(u.hostname) && seg[0]) return `https://job-boards.greenhouse.io/${seg[0]}`;
  if (u.hostname === 'jobs.lever.co' && seg[0]) return `https://jobs.lever.co/${seg[0]}`;
  if (u.hostname === 'jobs.ashbyhq.com' && seg[0]) return `https://jobs.ashbyhq.com/${seg[0]}`;
  if (u.hostname.endsWith('.myworkdayjobs.com') && seg[0]) {
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(seg[0]) ? seg[1] : seg[0];
    return site ? `https://${u.hostname}/${site}` : null;
  }
  return null;
}

// ATS slugs like "brillio-2" or "appen_2" carry a numeric suffix that is not part of the name.
const prettyCompany = (slug) => String(slug).replace(/[-_]\d+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export async function sweepAggregator(db, settings, { fetchImpl = fetch, minHours = 20 } = {}) {
  const last = await kvGet(db, 'aggregator:last_sweep');
  if (last && Date.now() - new Date(last).getTime() < minHours * 36e5) return { skipped: true };
  const meta = await (await fetchImpl(`${AGGREGATOR}/metadata.json`)).json();
  if (meta.last_updated && meta.last_updated === (await kvGet(db, 'aggregator:dataset_version'))) {
    await kvSet(db, 'aggregator:last_sweep', now());
    return { skipped: true, reason: 'dataset unchanged' };
  }
  const stats = { chunks: 0, india: 0, matched: 0, created: 0, boardsAdded: 0 };
  const seenAll = new Set();
  const knownBoards = new Set((await all(db, 'SELECT id FROM boards')).map((b) => b.id));
  for (let i = 0; ; i++) {
    const res = await fetchImpl(`${AGGREGATOR}/chunks/jobs_chunk_${i}.json.gz`);
    if (res.status === 404) break;
    if (!res.ok) throw new Error(`aggregator chunk ${i}: HTTP ${res.status}`);
    const rows = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'));
    stats.chunks++;
    const matched = [];
    for (const r of rows) {
      if (!r.url || !r.title || r.is_recruiter) continue;
      const tier = locationTier(r.location ?? '', '', settings);
      if (tier.tier == null) continue;
      stats.india++;
      if (!roleFamily(r.title).family || r.skill_level === 'senior') continue;
      stats.matched++;
      const boardUrl = boardFromPostingUrl(r.url);
      // Aggregator salary figures are modelled estimates, not employer disclosures: never stored as compensation.
      matched.push({ url: r.url, title: r.title, company: prettyCompany(r.company), location: r.location,
        postedAt: r.updated_at ?? r.first_seen, ats: (r.ats ?? '').toLowerCase() || null, boardUrl });
    }
    for (const m of matched) {
      if (m.boardUrl && !knownBoards.has(boardIdFor(m.boardUrl))) {
        await addBoard(db, { name: m.company, careers_url: m.boardUrl, origin: 'discovered' });
        knownBoards.add(boardIdFor(m.boardUrl));
        stats.boardsAdded++;
      }
    }
    const { rest, seen } = await touchKnown(db, matched);
    for (const id of seen) seenAll.add(id);
    for (const m of rest) {
      const out = await upsertJob(db, m, { source: 'aggregator', ats: m.ats, boardId: m.boardUrl ? boardIdFor(m.boardUrl) : null, settings });
      if (!out) continue;
      seenAll.add(out.id);
      if (out.duplicateOf) seenAll.add(out.duplicateOf);
      if (out.created) stats.created++;
    }
  }
  // Aggregator rows no employer board vouches for expire when a complete sweep no longer lists them.
  stats.expired = await expireMissing(db, null, seenAll);
  await kvSet(db, 'aggregator:last_sweep', now());
  await kvSet(db, 'aggregator:dataset_version', meta.last_updated ?? null);
  return stats;
}
