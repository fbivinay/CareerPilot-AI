// One libSQL client for every environment: a local SQLite file in development,
// Turso (hosted libSQL, free tier) from GitHub Actions and Vercel, :memory: in tests.
import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    canonical_url TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    source TEXT NOT NULL,
    ats TEXT,
    external_id TEXT,
    board_id TEXT,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT,
    description TEXT,
    posted_at TEXT,
    deadline TEXT,
    employment_type TEXT,
    role_category TEXT,
    experience_min REAL,
    experience_max REAL,
    comp_min REAL,
    comp_max REAL,
    comp_period TEXT,
    comp_currency TEXT,
    comp_source TEXT,
    score INTEGER,
    confidence TEXT,
    match_reasons TEXT,
    exclusion_reason TEXT,
    ai_score INTEGER,
    ai_summary TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    fingerprint TEXT,
    duplicate_of TEXT,
    repost_of TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    expired_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status)`,
  `CREATE INDEX IF NOT EXISTS jobs_fingerprint ON jobs(fingerprint)`,
  `CREATE INDEX IF NOT EXISTS jobs_board ON jobs(board_id)`,
  `CREATE INDEX IF NOT EXISTS jobs_company ON jobs(company)`,
  `CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    careers_url TEXT NOT NULL,
    origin TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_scan TEXT,
    last_ok TEXT,
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    jobs_seen INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    method TEXT,
    resume_version TEXT,
    blocked_reason TEXT,
    answers TEXT,
    evidence TEXT,
    gmail_thread_id TEXT,
    submitted_at TEXT,
    confirmed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS applications_status ON applications(status)`,
  `CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    role TEXT,
    company TEXT,
    source_type TEXT NOT NULL,
    source_ref TEXT,
    domain_match INTEGER NOT NULL DEFAULT 0,
    opted_out INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS outreach (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL,
    job_id TEXT,
    kind TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    gmail_message_id TEXT,
    gmail_thread_id TEXT,
    followup_of TEXT,
    sent_at TEXT,
    replied_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS outreach_contact ON outreach(contact_id)`,
  `CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY,
    thread_id TEXT,
    from_addr TEXT,
    from_name TEXT,
    subject TEXT,
    snippet TEXT,
    received_at TEXT,
    category TEXT,
    confidence REAL,
    classified_by TEXT,
    company TEXT,
    job_id TEXT,
    application_id TEXT,
    extracted TEXT,
    needs_review INTEGER NOT NULL DEFAULT 0,
    reviewed INTEGER NOT NULL DEFAULT 0,
    processed_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS emails_application ON emails(application_id)`,
  // The candidate's own job emails (the Email page): the first one they sent in each conversation, and the
  // reply it got (gmail-sync.mjs, syncSent and recordReply).
  `CREATE TABLE IF NOT EXISTS sent_mail (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL UNIQUE,
    to_addr TEXT,
    to_name TEXT,
    subject TEXT,
    sent_at TEXT,
    reply_category TEXT,
    reply_at TEXT,
    reply_from TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT,
    detail TEXT,
    at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS events_entity ON events(entity, entity_id)`,
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ai_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS vault (name TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  // Answer packs are rebuilt from the encrypted profile on demand; never keep plaintext copies.
  `UPDATE applications SET answers = NULL WHERE answers IS NOT NULL`,
];

let shared;

export function dbUrl(env = process.env) {
  if (env.TURSO_DATABASE_URL) return env.TURSO_DATABASE_URL;
  // import.meta.dirname is undefined inside the Next.js bundle, where cwd is the app root.
  const dir = path.resolve(import.meta.dirname ? path.join(import.meta.dirname, '..') : process.cwd(), '.data');
  mkdirSync(dir, { recursive: true });
  return 'file:' + path.join(dir, 'careerpilot.db').replaceAll('\\', '/');
}

export async function openDb({ url, authToken } = {}) {
  const db = createClient({
    url: url ?? dbUrl(),
    authToken: authToken ?? process.env.TURSO_AUTH_TOKEN,
    timeout: 10_000, // local file: the dashboard and a pipeline run can write at the same time; wait, don't fail
  });
  await db.batch(SCHEMA, 'write');
  return db;
}

export async function getDb() {
  shared ??= openDb();
  return shared;
}

export const now = () => new Date().toISOString();

// A read retries once on a passing server error (Turso answered 502 to the dashboard for a minute on
// 2026-10-19); a write never does, since it may already have gone through.
const transient = (err) => [502, 503, 504].includes(err?.cause?.status);
export async function read(db, sql, args = []) {
  try {
    return await db.execute({ sql, args });
  } catch (err) {
    if (!transient(err) || !/^\s*(select|with)\b/i.test(sql)) throw err;
    await new Promise((r) => setTimeout(r, 700));
    return db.execute({ sql, args });
  }
}

export async function all(db, sql, args = []) {
  return (await read(db, sql, args)).rows;
}

export async function one(db, sql, args = []) {
  return (await read(db, sql, args)).rows[0];
}

export async function run(db, sql, args = []) {
  return db.execute({ sql, args });
}

export async function kvGet(db, key, fallback = null) {
  const row = await one(db, 'SELECT value FROM kv WHERE key = ?', [key]);
  return row ? JSON.parse(row.value) : fallback;
}

export async function kvSet(db, key, value) {
  await run(db, `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  [key, JSON.stringify(value), now()]);
}

// Append-only audit trail for every state change and outbound action.
export async function audit(db, entity, entityId, action, { from = null, to = null, detail = null } = {}) {
  await run(db, `INSERT INTO events (entity, entity_id, action, from_status, to_status, detail, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  [entity, entityId, action, from, to, detail == null ? null : JSON.stringify(detail), now()]);
}
