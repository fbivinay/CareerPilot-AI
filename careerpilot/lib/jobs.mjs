// Idempotent job persistence: canonical-URL identity, cross-source duplicate
// detection by fingerprint, repost detection, and board-based expiry.
import { createHash } from 'node:crypto';
import { normalizeUrl } from '../../url-key.mjs';
import { all, audit, now, one, run } from './db.mjs';
import { fingerprint } from './match.mjs';
import { applyEvaluation, auditStmt, batchChunks, evaluationStatements } from './evaluate.mjs';

export { applyEvaluation };

export const canonicalUrl = (url) => normalizeUrl(url) || String(url).trim();
export const jobId = (canonical) => createHash('sha1').update(canonical).digest('hex').slice(0, 16);

const toIso = (v) => {
  if (v == null || v === '') return null;
  const d = new Date(typeof v === 'number' ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// job: {url, title, company, location, description?, postedAt?, salary?, externalId?}
// Returns {id, created, changed, status}.
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
      return { id, created: false, changed: false, status: 'expired' };
    }
    const better = description.length > (existing.description?.length ?? 0);
    const revived = existing.status === 'expired';
    await run(db, `UPDATE jobs SET last_seen = ?, expired_at = NULL,
        description = CASE WHEN ? THEN ? ELSE description END,
        posted_at = COALESCE(posted_at, ?), board_id = COALESCE(board_id, ?), ats = COALESCE(ats, ?),
        external_id = COALESCE(external_id, ?)
      WHERE id = ?`,
    [ts, better ? 1 : 0, description, toIso(job.postedAt), boardId, ats, job.externalId ?? null, id]);
    // A live duplicate proves its canonical twin is live too, so the twin must not expire.
    if (existing.duplicate_of) await run(db, 'UPDATE jobs SET last_seen = ? WHERE id = ?', [ts, existing.duplicate_of]);
    if (better || revived) {
      const row = await one(db, 'SELECT * FROM jobs WHERE id = ?', [id]);
      const status = await applyEvaluation(db, row, settings, job.salary);
      if (revived) await audit(db, 'job', id, 'revived', { from: 'expired', to: status });
      return { id, created: false, changed: true, status };
    }
    return { id, created: false, changed: false, status: existing.status };
  }

  const fp = fingerprint(job);
  // Same company+title+city already tracked under another URL: a cross-source duplicate,
  // unless the earlier one expired, in which case this is a repost and is evaluated normally.
  const twin = await one(db, `SELECT id, status FROM jobs WHERE fingerprint = ? AND status != 'duplicate'
    ORDER BY first_seen LIMIT 1`, [fp]);
  const duplicateOf = twin && twin.status !== 'expired' ? twin.id : null;
  const repostOf = twin && twin.status === 'expired' ? twin.id : null;

  await run(db, `INSERT INTO jobs (id, canonical_url, url, source, ats, external_id, board_id, company, title, location,
      description, posted_at, status, fingerprint, duplicate_of, repost_of, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, canonical, job.url, source, ats, job.externalId ?? null, boardId, job.company || 'Unknown', job.title.trim(),
    job.location ?? '', description, toIso(job.postedAt), duplicateOf ? 'duplicate' : 'new', fp, duplicateOf, repostOf, ts, ts]);

  if (duplicateOf) {
    await run(db, 'UPDATE jobs SET last_seen = ? WHERE id = ?', [ts, duplicateOf]);
    await audit(db, 'job', id, 'duplicate', { to: 'duplicate', detail: { of: duplicateOf, source } });
    // Keep the richer description on the canonical row.
    if (description) await run(db, `UPDATE jobs SET description = ? WHERE id = ? AND length(coalesce(description,'')) < ?`, [description, duplicateOf, description.length]);
    return { id, created: true, changed: true, status: 'duplicate' };
  }
  const row = await one(db, 'SELECT * FROM jobs WHERE id = ?', [id]);
  const status = await applyEvaluation(db, row, settings, job.salary);
  await audit(db, 'job', id, 'discovered', { to: status, detail: { source, repostOf } });
  return { id, created: true, changed: true, status };
}

// After a board scan that succeeded, anything from that board not seen in it has closed.
// boardId null = aggregator rows after a complete aggregator sweep, for postings whose employer board
// cannot vouch for them (no board, or a board that has never been scanned successfully).
// Applications still waiting on the candidate move to 'expired' with the posting.
export async function expireMissing(db, boardId, scanStartedAt) {
  const gone = boardId == null
    ? await all(db, `SELECT id, status FROM jobs WHERE source = 'aggregator' AND last_seen < ? AND status NOT IN ('expired', 'duplicate')
        AND (board_id IS NULL OR board_id IN (SELECT id FROM boards WHERE last_ok IS NULL))`, [scanStartedAt])
    : await all(db, `SELECT id, status FROM jobs WHERE board_id = ? AND last_seen < ? AND status NOT IN ('expired', 'duplicate')`,
      [boardId, scanStartedAt]);
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

// Re-run rules over every live job, e.g. after settings change.
export async function reevaluateAll(db, settings) {
  const rows = await all(db, `SELECT * FROM jobs WHERE status IN ('new', 'qualified', 'excluded')`);
  await batchChunks(db, rows.flatMap((row) => evaluationStatements(row, settings).stmts));
  return rows.length;
}

// Fast path for repeat scans: postings already stored, still live and not richer than before only
// need last_seen bumped, in bulk. Returns the postings that need a full upsertJob().
export async function touchKnown(db, postings) {
  const keyed = postings.map((p) => ({ p, id: p.url && jobId(canonicalUrl(p.url)) })).filter((x) => x.id);
  const known = new Map();
  for (let i = 0; i < keyed.length; i += 300) {
    const ids = keyed.slice(i, i + 300).map((x) => x.id);
    for (const r of await all(db, `SELECT id, status, duplicate_of, length(coalesce(description, '')) dl FROM jobs WHERE id IN (${ids.map(() => '?').join(',')})`, ids)) {
      known.set(r.id, r);
    }
  }
  const touch = new Set();
  const rest = [];
  for (const { p, id } of keyed) {
    const k = known.get(id);
    if (k && k.status !== 'expired' && (p.description ?? '').length <= Number(k.dl)) {
      touch.add(id);
      if (k.duplicate_of) touch.add(k.duplicate_of);
    } else rest.push(p);
  }
  const ids = [...touch];
  const ts = now();
  await batchChunks(db, Array.from({ length: Math.ceil(ids.length / 300) }, (_, i) => {
    const chunk = ids.slice(i * 300, i * 300 + 300);
    return { sql: `UPDATE jobs SET last_seen = ? WHERE id IN (${chunk.map(() => '?').join(',')})`, args: [ts, ...chunk] };
  }));
  return { rest, touched: ids.length };
}
