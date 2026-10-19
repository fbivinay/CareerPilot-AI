// Candidate profile: the single source of truth for every fact written on the user's behalf.
// Locally it is read from private/profile.yml; in GitHub Actions/Vercel from the encrypted vault.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { vaultGet } from './vault.mjs';

const PRIVATE = path.resolve(import.meta.dirname ? path.join(import.meta.dirname, '..') : process.cwd(), 'private');

export async function loadProfile(db, env = process.env) {
  if (env.APP_ENCRYPTION_KEY) {
    const blob = await vaultGet(db, 'profile', env);
    if (blob) return JSON.parse(blob.toString('utf8'));
  }
  const file = path.join(PRIVATE, 'profile.yml');
  return existsSync(file) ? loadYaml(readFileSync(file, 'utf8')) : null;
}

export async function loadResumePdf(db, env = process.env) {
  if (env.APP_ENCRYPTION_KEY) {
    const blob = await vaultGet(db, 'resume.pdf', env);
    if (blob) return blob;
  }
  const file = path.join(PRIVATE, 'master-resume.pdf');
  return existsSync(file) ? readFileSync(file) : null;
}

// Resume facts for an LLM prompt, without contact details (data class "profile").
export function profileFacts(p) {
  const lines = [`Headline: ${p.headline}`];
  for (const e of p.education ?? []) lines.push(`Education: ${e.degree}, ${e.institution} (${e.dates}, ${e.grade})`);
  for (const x of p.experience ?? []) lines.push(`Experience: ${x.title} at ${x.company} (${x.dates}): ${x.points.join(' ')}`);
  for (const pr of p.projects ?? []) lines.push(`Project: ${pr.name} [${pr.stack}]: ${pr.points.join(' ')}`);
  for (const [k, v] of Object.entries(p.skills ?? {})) lines.push(`Skills (${k.replace(/_/g, ' ')}): ${v.join(', ')}`);
  for (const a of p.achievements ?? []) lines.push(`Achievement: ${a}`);
  return lines.join('\n');
}

// Every token of verified fact text, used to reject generated text that introduces numbers
// or claims not present in the profile or the job description.
export function factCorpus(p, extra = '') {
  return (JSON.stringify(p) + ' ' + extra).toLowerCase();
}

// Numbers in generated text must appear in the facts (blocks invented metrics, years, CGPA, etc.).
const numbers = (s) => (String(s).match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[.,]+$/, '').replace(/,/g, ''));

export function unverifiedNumbers(text, corpus) {
  const known = new Set(numbers(corpus));
  return numbers(text).filter((n) => !known.has(n));
}

// Technologies generated text may claim only when the profile names them: a drafted "I have practical
// expertise in … TensorFlow" (Synechron, 2026-10-19) when the profile lists PyTorch and Keras. A sentence
// speaking for the candidate ("I", "my", "me") may name only technologies the profile contains; one about
// the employer's own stack may name others.
const TECH = ['tensorflow', 'pytorch', 'keras', 'scikit-learn', 'xgboost', 'lightgbm', 'catboost', 'spark', 'pyspark', 'hadoop', 'hive',
  'kafka', 'airflow', 'dbt', 'snowflake', 'databricks', 'bigquery', 'redshift', 'aws', 'azure', 'gcp', 'google cloud', 'docker',
  'kubernetes', 'terraform', 'helm', 'jenkins', 'mlops', 'mlflow', 'kubeflow', 'sagemaker', 'vertex ai', 'langchain', 'llamaindex',
  'hugging ?face', 'opencv', 'yolo', 'tableau', 'power bi', 'looker', 'mongodb', 'postgresql', 'mysql', 'oracle', 'java', 'scala',
  'c\\+\\+', 'golang', 'rust', 'javascript', 'typescript', 'react', 'node\\.?js', 'fastapi', 'flask', 'django', 'sas', 'spss', 'matlab',
  'elasticsearch', 'redis', 'cassandra', 'neo4j', 'pandas', 'numpy', 'fine-?tun\\w*', 'reinforcement learning', 'computer vision',
  'pinecone', 'faiss', 'chromadb', 'weaviate', 'graphql', 'microservices', 'ci/cd', 'linux', 'excel'];
export function unclaimedTech(text, profile) {
  const known = JSON.stringify(profile);
  const out = new Set();
  for (const sentence of String(text).split(/(?<=[.!?])\s+|\n+/)) {
    if (!/\b(i|my|me|i'm|i've)\b/i.test(sentence)) continue;
    for (const t of TECH) {
      const re = new RegExp(`(?<![\\w+])(${t})(?![\\w+])`, 'i');
      const m = re.exec(sentence);
      if (m && !re.test(known)) out.add(m[1]);
    }
  }
  return [...out];
}
