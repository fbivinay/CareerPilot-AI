#!/usr/bin/env node
// Local secret plumbing. Nothing secret is ever printed.
//   node scripts/setup.mjs keys        create APP_ENCRYPTION_KEY and SESSION_SECRET in .env if missing
//   node scripts/setup.mjs password    set the dashboard password (hidden prompt) -> DASHBOARD_PASSWORD_HASH
//   node scripts/setup.mjs profile     encrypt private/profile.yml + master resume into the database vault
//   node scripts/setup.mjs github      copy the pipeline's secrets from .env to GitHub Actions secrets (gh CLI)
//   node scripts/setup.mjs check       show which settings are present (names only)
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { load as loadYaml } from 'js-yaml';
import { hashPassword } from '../lib/password.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

// Secrets GitHub Actions needs. Dashboard-only values (password hash, session secret) go to Vercel instead.
const ACTIONS_SECRETS = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'APP_ENCRYPTION_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
  'GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'];
const ALL = [...ACTIONS_SECRETS, 'SESSION_SECRET', 'DASHBOARD_PASSWORD_HASH'];

// Line-based so values are written verbatim (no regex replacement patterns).
function setEnv(name, value) {
  const lines = (existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '').split(/\r?\n/).filter(Boolean);
  const i = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (i >= 0) lines[i] = `${name}=${value}`; else lines.push(`${name}=${value}`);
  writeFileSync(ENV_FILE, lines.join('\n') + '\n');
  process.env[name] = value;
}

function repoSlug() {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  return url.match(/github\.com[/:]([^/]+\/[^/.]+)/)?.[1];
}

function hiddenPrompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (!s.includes(question)) rl.output.write('*'); else rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}


const commands = {
  keys() {
    for (const name of ['APP_ENCRYPTION_KEY', 'SESSION_SECRET']) {
      if (process.env[name]) { console.log(`${name}: already set`); continue; }
      setEnv(name, randomBytes(32).toString('base64'));
      console.log(`${name}: generated and saved to careerpilot/.env`);
    }
  },
  async password() {
    const a = await hiddenPrompt('New dashboard password (min 12 chars): ');
    if (a.length < 12) throw new Error('Password must be at least 12 characters.');
    if (a !== await hiddenPrompt('Repeat password: ')) throw new Error('Passwords do not match.');
    setEnv('DASHBOARD_PASSWORD_HASH', hashPassword(a));
    console.log('DASHBOARD_PASSWORD_HASH saved to careerpilot/.env. Add it (and SESSION_SECRET) to Vercel env when you deploy.');
  },
  async profile() {
    const file = path.join(ROOT, 'private', 'profile.yml');
    const profile = loadYaml(readFileSync(file, 'utf8'));
    for (const f of ['name', 'email', 'education', 'skills']) if (!profile?.[f]) throw new Error(`profile.yml is missing "${f}"`);
    const pdf = readFileSync(path.join(ROOT, profile.resume?.file ?? 'private/master-resume.pdf'));
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('master resume is not a PDF');
    const { getDb } = await import('../lib/db.mjs');
    const { vaultPut } = await import('../lib/vault.mjs');
    const db = await getDb();
    await vaultPut(db, 'profile', JSON.stringify(profile));
    await vaultPut(db, 'resume.pdf', pdf);
    const unknown = Object.entries(profile.answers ?? {}).filter(([, v]) => v == null).map(([k]) => k);
    console.log(`Encrypted profile and resume (${Math.round(pdf.length / 1024)} KB) stored in ${process.env.TURSO_DATABASE_URL ? 'Turso' : 'the local database'}.`);
    if (unknown.length) console.log(`Not provided (left blank; forms asking for them are filled by you): ${unknown.join(', ')}`);
  },
  github() {
    const repo = repoSlug();
    if (!repo) throw new Error('Could not read the GitHub repository from `git remote get-url origin`.');
    console.log(`Setting Actions secrets on ${repo}`);
    for (const name of ACTIONS_SECRETS) {
      if (!process.env[name]) { console.log(`skip ${name} (not set)`); continue; }
      execFileSync('gh', ['secret', 'set', name, '--repo', repo], { input: process.env[name], stdio: ['pipe', 'ignore', 'inherit'] });
      console.log(`set GitHub Actions secret ${name}`);
    }
  },
  check() {
    for (const name of ALL) console.log(`${process.env[name] ? 'OK     ' : 'missing'} ${name}`);
  },
};

const cmd = process.argv[2];
if (!commands[cmd]) {
  console.log('Usage: node scripts/setup.mjs keys|password|profile|github|check');
  process.exit(1);
}
await commands[cmd]();
