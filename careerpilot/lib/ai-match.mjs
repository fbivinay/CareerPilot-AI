// Semantic fit check for jobs the rules already qualified. Rules decide eligibility (role, level,
// location, pay); the model judges skill fit from the JD, which keyword rules cannot.
import { all, audit, run } from './db.mjs';
import { aiJson, AiUnavailable } from './ai.mjs';
import { loadProfile, profileFacts } from './profile.mjs';

export { AI_EXCLUDE_BELOW } from './match.mjs';
import { AI_EXCLUDE_BELOW } from './match.mjs';

export async function aiScoreJobs(db, settings, { limit = 15, env = process.env, deadline = Infinity } = {}) {
  const profile = await loadProfile(db, env);
  if (!profile) return { skipped: 'profile not imported' };
  const jobs = await all(db, `SELECT * FROM jobs WHERE status = 'qualified' AND ai_score IS NULL AND length(coalesce(description, '')) > 300
    ORDER BY score DESC, first_seen DESC LIMIT ?`, [limit]);
  const stats = { scored: 0, excluded: 0, deferred: 0 };
  const facts = profileFacts(profile);
  for (const job of jobs) {
    if (Date.now() > deadline) { stats.deferred = jobs.length - stats.scored; break; }
    let r;
    try {
      r = await aiJson(db, {
        name: 'job-fit',
        tier: 'fast',
        dataClass: 'profile',
        system: 'You assess fit between a fresher candidate and a job. Judge only from the given text. Reply with JSON: '
          + '{"score": integer 0-100, "summary": one sentence on fit, "matched_skills": [strings from the candidate facts], "gaps": [requirements the candidate facts do not show]}.',
        user: `JOB: ${job.title} at ${job.company} (${job.location})\n${job.description.slice(0, 5000)}\n\nCANDIDATE FACTS:\n${facts}`,
        shape: { score: 'number', summary: 'string', matched_skills: 'array', gaps: 'array' },
        maxTokens: 400,
      }, { settings, env });
    } catch (err) {
      if (err instanceof AiUnavailable) { stats.deferred = jobs.length - stats.scored; break; }
      throw err;
    }
    const score = Math.max(0, Math.min(100, Math.round(r.score)));
    const summary = `${r.summary} Matched: ${r.matched_skills.slice(0, 8).join(', ') || 'none'}. Gaps: ${r.gaps.slice(0, 5).join(', ') || 'none'}. (${r._provider})`;
    if (score < AI_EXCLUDE_BELOW) {
      await run(db, `UPDATE jobs SET ai_score = ?, ai_summary = ?, status = 'excluded', exclusion_reason = ? WHERE id = ?`,
        [score, summary, `AI fit assessment ${score}/100: ${r.summary}`, job.id]);
      await audit(db, 'job', job.id, 'reevaluated', { from: 'qualified', to: 'excluded', detail: { aiScore: score } });
      stats.excluded++;
    } else {
      await run(db, 'UPDATE jobs SET ai_score = ?, ai_summary = ? WHERE id = ?', [score, summary, job.id]);
    }
    stats.scored++;
  }
  return stats;
}
