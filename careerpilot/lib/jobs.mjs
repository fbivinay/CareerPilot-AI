// Idempotent job persistence: canonical-URL identity, cross-source duplicate detection by
// fingerprint, repost detection, and expiry by set difference (what the employer's board no
// longer lists). last_seen is refreshed at most daily, to stay well inside the free write quota.
import { createHash } from 'node:crypto';
import { normalizeUrl } from '../../url-key.mjs';
import { fetchJdViaKnownApi } from '../../browser-extract.mjs';
import { JD_TEXT_API_ATS, resolveAtsApi } from '../../liveness-api.mjs';
import { all, audit, now, one, run } from './db.mjs';
import { fingerprint } from './match.mjs';
import { applyEvaluation, auditStmt, batchChunks, evaluationStatements } from './evaluate.mjs';

export { applyEvaluation };

export const canonicalUrl = (url) => normalizeUrl(url) || String(url).trim();
export const jobId = (canonical) => createHash('sha1').update(canonical).digest('hex').slice(0, 16);

const LAST_SEEN_REFRESH_MS = 20 * 36e5;

const toIso = (v) => {
  if (v == null || v === '') return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// job: {url, title, company, location, description?, postedAt?, salary?, externalId?}
// Returns {id, created, changed, status, duplicateOf}.
export async function upsertJob(db, job, { source, ats = null, boardId = null, settings }) {
  const canonical = canonicalUrl(job.url);
  if (!canonical || !job.title) return null;
  const id = jobId(canonical);
  const ts = now();
  const existing = await one(db, 'SELECT * FROM jobs WHERE id = ?', [id]);
  const description = job.description ?? '';

  if (existing) {
    // The aggregator lags by up to a day; the employer's own board is authoritative on closure.
    if (source === 'aggregator' && existing.board_id && existing.status === 'expired') {
      return { id, created: false, changed: false, status: 'expired', duplicateOf: null };
    }
    const better = description.length > (existing.description?.length ?? 0);
    const revived = existing.status === 'expired';
    await run(db, `UPDATE jobs SET last_seen = ?, expired_at = NULL,
        description = CASE WHEN ? THEN ? ELSE description END,
        posted_at = COALESCE(posted_at, ?), board_id = COALESCE(board_id, ?), ats = COALESCE(ats, ?),
        external_id = COALESCE(external_id, ?)
      WHERE id = ?`,
    [ts, better ? 1 : 0, description, toIso(job.postedAt), boardId, ats, job.externalId ?? null, id]);
    if (better || revived) {
      const row = await one(db, 'SELECT * FROM jobs WHERE id = ?', [id]);
      const status = row.status === 'duplicate' ? 'duplicate' : await applyEvaluation(db, row, settings, job.salary);
      if (revived) await audit(db, 'job', id, 'revived', { from: 'expired', to: status });
      return { id, created: false, changed: true, status, duplicateOf: existing.duplicate_of };
    }
    return { id, created: false, changed: false, status: existing.status, duplicateOf: existing.duplicate_of };
  }

  const fp = fingerprint(job);
  // Same company+title+city already tracked under another URL: a cross-source duplicate,
  // unless the earlier one expired, in which case this is a repost and is evaluated normally.
  const twin = await one(db, `SELECT id, status, length(coalesce(description, '')) dl FROM jobs WHERE fingerprint = ? AND status != 'duplicate'
    ORDER BY first_seen LIMIT 1`, [fp]);
  const duplicateOf = twin && twin.status !== 'expired' ? twin.id : null;
  const repostOf = twin && twin.status === 'expired' ? twin.id : null;

  await run(db, `INSERT INTO jobs (id, canonical_url, url, source, ats, external_id, board_id, company, title, location,
      description, posted_at, status, fingerprint, duplicate_of, repost_of, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, canonical, job.url, source, ats, job.externalId ?? null, boardId, job.company || 'Unknown', job.title.trim(),
    job.location ?? '', description, toIso(job.postedAt), duplicateOf ? 'duplicate' : 'new', fp, duplicateOf, repostOf, ts, ts]);

  if (duplicateOf) {
    await audit(db, 'job', id, 'duplicate', { to: 'duplicate', detail: { of: duplicateOf, source } });
    // Keep the richer description on the canonical row and re-judge it with the new text.
    if (description.length > Number(twin.dl)) {
      await run(db, 'UPDATE jobs SET description = ?, last_seen = ? WHERE id = ?', [description, ts, duplicateOf]);
      await applyEvaluation(db, await one(db, 'SELECT * FROM jobs WHERE id = ?', [duplicateOf]), settings, job.salary);
    }
    return { id, created: true, changed: true, status: 'duplicate', duplicateOf };
  }
  const row = await one(db, 'SELECT * FROM jobs WHERE id = ?', [id]);
  const status = await applyEvaluation(db, row, settings, job.salary);
  await audit(db, 'job', id, 'discovered', { to: status, detail: { source, repostOf } });
  return { id, created: true, changed: true, status, duplicateOf: null };
}

// Fast path for repeat scans: postings already stored, still live and not richer than before need no
// per-row work. Returns the postings that need a full upsertJob() and the ids this scan has proven live
// (each posting's own row and, for a duplicate, the canonical row it points to).
export async function touchKnown(db, postings) {
  const keyed = postings.map((p) => ({ p, id: p.url && jobId(canonicalUrl(p.url)) })).filter((x) => x.id);
  const known = new Map();
  for (let i = 0; i < keyed.length; i += 300) {
    const ids = keyed.slice(i, i + 300).map((x) => x.id);
    for (const r of await all(db, `SELECT id, status, duplicate_of, last_seen, length(coalesce(description, '')) dl FROM jobs
      WHERE id IN (${ids.map(() => '?').join(',')})`, ids)) known.set(r.id, r);
  }
  const seen = new Set();
  const stale = new Set();
  const rest = [];
  const cutoff = new Date(Date.now() - LAST_SEEN_REFRESH_MS).toISOString();
  for (const { p, id } of keyed) {
    const k = known.get(id);
    if (k && k.status !== 'expired' && (p.description ?? '').length <= Number(k.dl)) {
      seen.add(id);
      if (k.duplicate_of) seen.add(k.duplicate_of);
      if (k.last_seen < cutoff) stale.add(id);
    } else rest.push(p);
  }
  const ids = [...stale];
  const ts = now();
  await batchChunks(db, Array.from({ length: Math.ceil(ids.length / 300) }, (_, i) => {
    const chunk = ids.slice(i * 300, i * 300 + 300);
    return { sql: `UPDATE jobs SET last_seen = ? WHERE id IN (${chunk.map(() => '?').join(',')})`, args: [ts, ...chunk] };
  }));
  return { rest, seen, touched: ids.length };
}

// Postings a successful scan did not list have closed. `seen` holds the ids the scan proved live.
// boardId null = aggregator rows after a complete aggregator sweep, for postings whose employer board
// cannot vouch for them (no board, or a board that has never been scanned successfully).
// Applications still waiting on the candidate move to 'expired' with the posting.
// `places`: the scan only covered postings in these places (a location-filtered crawl), so only jobs
// located there can be judged missing.
export async function expireMissing(db, boardId, seen, { places = null } = {}) {
  const rows = boardId == null
    ? await all(db, `SELECT id, status, location FROM jobs WHERE source = 'aggregator' AND status NOT IN ('expired', 'duplicate')
        AND (board_id IS NULL OR board_id IN (SELECT id FROM boards WHERE last_ok IS NULL))`)
    : await all(db, `SELECT id, status, location FROM jobs WHERE board_id = ? AND status NOT IN ('expired', 'duplicate')`, [boardId]);
  const gone = rows.filter((r) => !seen.has(r.id) && (!places || String(r.location ?? '').search(places) !== -1));
  if (!gone.length) return 0;
  const ts = now();
  const apps = [];
  for (let i = 0; i < gone.length; i += 300) {
    const ids = gone.slice(i, i + 300).map((j) => j.id);
    apps.push(...await all(db, `SELECT id, status FROM applications WHERE status IN ('ready', 'blocked', 'failed')
      AND job_id IN (${ids.map(() => '?').join(',')})`, ids));
  }
  await batchChunks(db, [
    ...gone.flatMap((j) => [
      { sql: `UPDATE jobs SET status = 'expired', expired_at = ? WHERE id = ?`, args: [ts, j.id] },
      auditStmt('job', j.id, 'expired', { from: j.status, to: 'expired', detail: { boardId } }),
    ]),
    ...apps.flatMap((a) => [
      { sql: `UPDATE applications SET status = 'expired', blocked_reason = 'Posting closed before submission', updated_at = ? WHERE id = ? AND status = ?`,
        args: [ts, a.id, a.status] },
      auditStmt('application', a.id, 'status', { from: a.status, to: 'expired', detail: { reason: 'posting closed' } }),
    ]),
  ]);
  return gone.length;
}

// Board listings (Workday's in particular) carry no description, so a job can qualify with its experience
// and pay requirements unchecked. These read the description from the ATS's public job API and judge the
// job again. describeJob returns the description, or null when it could not be read.
// `fromPage`, when given, reads the description off the job page when the API cannot.
export async function describeJob(db, row, settings, fetchJd = fetchJdViaKnownApi, fromPage = null) {
  const text = (await fetchJd(row.url).catch(() => null))?.text ?? (fromPage && await fromPage(row.url).catch(() => null));
  if (!text) return null;
  await run(db, 'UPDATE jobs SET description = ? WHERE id = ?', [text, row.id]);
  await applyEvaluation(db, { ...row, description: text }, settings);
  return text;
}
const describable = (url) => { try { return JD_TEXT_API_ATS.has(resolveAtsApi(url)?.ats); } catch { return false; } };
export async function describeMissing(db, settings, { deadline = Infinity, limit = 60, fetchJd = fetchJdViaKnownApi } = {}) {
  const ids = (await all(db, `SELECT id, url FROM jobs WHERE status = 'qualified' AND coalesce(description, '') = '' ORDER BY score DESC`))
    .filter((r) => describable(r.url)).slice(0, limit);
  let described = 0;
  for (const { id } of ids) {
    if (Date.now() > deadline) break;
    if (await describeJob(db, await one(db, 'SELECT * FROM jobs WHERE id = ?', [id]), settings, fetchJd)) described++;
  }
  return { missing: ids.length, described };
}

// Re-run rules over every live job, e.g. after settings change. A page at a time: one read of every
// job's text (11 MB at 18k jobs) makes Turso close the connection, and the next request fails.
export async function reevaluateAll(db, settings, page = 1000) {
  let count = 0;
  for (let after = ''; ;) {
    const rows = await all(db, `SELECT * FROM jobs WHERE status IN ('new', 'qualified', 'excluded') AND id > ? ORDER BY id LIMIT ?`, [after, page]);
    if (!rows.length) return count;
    await batchChunks(db, rows.flatMap((row) => evaluationStatements(row, settings).stmts));
    count += rows.length;
    after = rows.at(-1).id;
  }
}
