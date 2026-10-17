// Email composition from verified facts only. The LLM draft is accepted only if every number
// in it appears in the profile or the job description; otherwise a deterministic template is used.
import { aiJson, AiUnavailable } from './ai.mjs';
import { factCorpus, profileFacts, unverifiedNumbers } from './profile.mjs';

const OPT_OUT_LINE = 'If you would prefer not to hear from me again, just reply "unsubscribe" and I will not contact you further.';

const tokens = (s) => new Set(String(s).toLowerCase().match(/[a-z][a-z0-9+#.]{1,}/g) ?? []);

// Pick the candidate's bullets that overlap most with the JD's vocabulary.
export function relevantHighlights(profile, jd, n = 3) {
  const jdTokens = tokens(jd);
  const items = [
    ...(profile.experience ?? []).flatMap((x) => x.points.map((p) => ({ text: `${p} (${x.title}, ${x.company.split(',')[0]})`, src: p + x.title }))),
    ...(profile.projects ?? []).map((pr) => ({ text: `${pr.name.split(' — ')[0]}: ${pr.points[0]} [${pr.stack}]`, src: pr.points.join(' ') + pr.stack })),
  ];
  return items
    .map((it) => ({ ...it, score: [...tokens(it.src)].filter((t) => jdTokens.has(t)).length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((it) => it.text);
}

export function graduation(profile) {
  const e = (profile.education ?? [])[0];
  return e ? `${e.degree} at ${e.institution} (graduating ${e.dates.split('-').pop().trim()})` : null;
}

export function signature(profile) {
  return [profile.name, profile.phone, profile.links?.linkedin, profile.links?.github, profile.links?.portfolio].filter(Boolean).join('\n');
}

export function templateEmail({ profile, job, kind, contactName }) {
  const hello = contactName ? `Hi ${contactName.split(' ')[0]},` : 'Hello,';
  const subject = kind === 'application' ? `Application: ${job.title} – ${profile.name}` : `${job.title} at ${job.company} – ${profile.name}`;
  const intro = kind === 'application'
    ? `I would like to apply for the ${job.title} role at ${job.company}.`
    : `I came across the ${job.title} role at ${job.company} and wanted to reach out directly to express my interest.`;
  const body = [
    hello, '',
    `${intro} I am currently pursuing an ${graduation(profile)}, focused on data, machine learning and AI.`, '',
    'A few things relevant to this role:',
    ...relevantHighlights(profile, `${job.title} ${job.description ?? ''}`).map((h) => `- ${h}`), '',
    'My resume is attached. I would be glad to share more or speak at a time that suits you.', '',
    'Thank you for your time,', signature(profile), '', OPT_OUT_LINE,
  ].join('\n');
  return { subject, body, composer: 'template' };
}

export function followUpEmail({ profile, job, contactName }) {
  const hello = contactName ? `Hi ${contactName.split(' ')[0]},` : 'Hello,';
  return {
    subject: null, // replies keep the original thread subject
    body: [hello, '',
      `Following up on my note about the ${job.title} role at ${job.company}. I remain very interested and would welcome the chance to discuss how I could contribute.`, '',
      'Thank you,', signature(profile), '', OPT_OUT_LINE].join('\n'),
    composer: 'template',
  };
}

export async function composeEmail(db, { profile, job, kind, contactName }, settings) {
  const fallback = templateEmail({ profile, job, kind, contactName });
  try {
    const draft = await aiJson(db, {
      name: `compose-${kind}`,
      dataClass: 'profile',
      system: [
        'You write short, professional job-search emails for a candidate in India.',
        'Use ONLY facts from CANDIDATE FACTS and JOB. Never invent skills, experience, numbers, dates, achievements or availability.',
        'Do not claim years of experience. Do not mention salary. 120-180 words. No placeholders or brackets.',
        'Reply with JSON: {"subject": string, "body": string}. The body must not include a signature; it is added separately.',
      ].join(' '),
      user: `KIND: ${kind === 'application' ? 'application sent to the employer-published application address' : 'introduction to a recruiter'}\n` +
        `RECIPIENT NAME: ${contactName ?? 'unknown (use a neutral greeting)'}\n\nJOB: ${job.title} at ${job.company}, ${job.location}\n${(job.description ?? '').slice(0, 3500)}\n\n` +
        `CANDIDATE FACTS:\nName: ${profile.name}\n${profileFacts(profile)}`,
      shape: { subject: 'string', body: 'string' },
      maxTokens: 600,
    }, { settings });
    const corpus = factCorpus(profile, `${job.title} ${job.company} ${job.description ?? ''}`);
    const bad = unverifiedNumbers(draft.subject + ' ' + draft.body, corpus);
    if (bad.length || /\[|\{|lorem|your name/i.test(draft.body) || draft.body.length > 1800) {
      return { ...fallback, note: `AI draft rejected (unverified: ${bad.join(', ') || 'format'})` };
    }
    return { subject: draft.subject.slice(0, 140), body: `${draft.body.trim()}\n\n${signature(profile)}\n\n${OPT_OUT_LINE}`, composer: `ai:${draft._provider}` };
  } catch (err) {
    if (err instanceof AiUnavailable) return fallback;
    throw err;
  }
}
