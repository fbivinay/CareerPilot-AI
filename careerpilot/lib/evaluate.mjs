// Rule evaluation persistence, kept free of URL/provider imports so the dashboard bundle stays small.
import { now } from './db.mjs';
import { AI_EXCLUDE_BELOW, evaluateJob, fingerprint } from './match.mjs';

// SQL statements that persist a rule evaluation (batched by callers to save round trips on hosted libSQL).
// Structured salary from the ATS ('provider') is kept across re-evaluations; pay parsed from the
// description text is always re-parsed, so parser fixes reach stored jobs.
export function evaluationStatements(row, settings, salary) {
  const r = evaluateJob({ ...row, salary: salary ?? (row.comp_source === 'provider'
    ? { min: row.comp_min, max: row.comp_max, currency: row.comp_currency, period: row.comp_period } : undefined) }, settings);
  // A prior AI fit rejection (see ai-match.mjs) stands unless the rules exclude the job anyway.
  if (r.status === 'qualified' && row.ai_score != null && row.ai_score < AI_EXCLUDE_BELOW) {
    r.status = 'excluded';
    r.exclusion_reason = `AI fit assessment ${row.ai_score}/100`;
  }
  const stmts = [{
    sql: `UPDATE jobs SET status = ?, exclusion_reason = ?, score = ?, confidence = ?, role_category = ?,
      employment_type = ?, experience_min = ?, experience_max = ?, comp_min = ?, comp_max = ?, comp_period = ?,
      comp_currency = ?, comp_source = ?, match_reasons = ?, fingerprint = ? WHERE id = ?`,
    args: [r.status, r.exclusion_reason, r.score, r.confidence, r.role_category, r.employment_type, r.experience_min,
      r.experience_max, r.comp_min, r.comp_max, r.comp_period, r.comp_currency, r.comp_source, r.match_reasons,
      fingerprint(row), row.id],
  }];
  if (row.status !== 'new' && row.status !== r.status) stmts.push(auditStmt('job', row.id, 'reevaluated', { from: row.status, to: r.status }));
  return { status: r.status, stmts };
}

export async function applyEvaluation(db, row, settings, salary) {
  const { status, stmts } = evaluationStatements(row, settings, salary);
  await db.batch(stmts, 'write');
  return status;
}

export const auditStmt = (entity, id, action, { from = null, to = null, detail = null } = {}) => ({
  sql: 'INSERT INTO events (entity, entity_id, action, from_status, to_status, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  args: [entity, id, action, from, to, detail == null ? null : JSON.stringify(detail), now()],
});

export async function batchChunks(db, stmts, size = 200) {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size), 'write');
}

