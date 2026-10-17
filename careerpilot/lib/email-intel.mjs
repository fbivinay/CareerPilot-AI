// Rule-first email understanding: category, confidence, extracted next steps, and job-alert parsing.
// An LLM (no-training provider only) is consulted just for messages the rules cannot decide.

export const ALERT_SENDERS = [
  ['linkedin', /@(.*\.)?linkedin\.com$/],
  ['naukri', /@(.*\.)?naukri\.com$/],
  ['wellfound', /@(.*\.)?(wellfound\.com|angel\.co|angellist\.com)$/],
  ['cutshort', /@(.*\.)?cutshort\.io$/],
  ['instahyre', /@(.*\.)?instahyre\.com$/],
  ['internshala', /@(.*\.)?internshala\.com$/],
  ['indeed', /@(.*\.)?indeed\.(com|co\.in)$/],
  ['foundit', /@(.*\.)?(foundit\.in|monsterindia\.com)$/],
  ['hirist', /@(.*\.)?(hirist\.(com|tech)|iimjobs\.com)$/],
  ['glassdoor', /@(.*\.)?glassdoor\.(com|co\.in)$/],
];

const ATS_SENDERS = /@(.*\.)?(greenhouse\.io|greenhouse-mail\.io|lever\.co|hire\.lever\.co|ashbyhq\.com|myworkday\.com|smartrecruiters\.com|workablemail\.com|workable\.com|recruitee\.com|teamtailor\.com|breezy\.hr|freshteam\.com|zohorecruit\.(com|in)|keka\.com|darwinbox\.(in|com)|icims\.com|successfactors\.com|jobvite\.com)$/;
const ASSESSMENT_HOSTS = /(hackerrank\.com|codility\.com|hackerearth\.com|mettl\.com|testgorilla\.com|imocha\.io|codesignal\.com|coderbyte\.com|glider\.ai|vervoe\.com|xobin\.com|testdome\.com|interviewbit\.com|hirepro\.in|amcat|talview\.com)/i;
const MEETING_HOSTS = /(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|calendly\.com|webex\.com)/i;

const RULES = [
  ['offer', 0.9, /\b(pleased|delighted|happy) to (extend|offer)\b|\boffer letter\b|\boffer of employment\b|\bjob offer\b|\bcompensation package\b.*\boffer\b/],
  ['rejection', 0.9, /\bunfortunately\b[\s\S]{0,200}\b(not|won't|will not|unable|decided)\b|\bnot (be )?moving forward\b|\bmove forward with other candidates\b|\bregret to inform\b|\bnot been selected\b|\bwill not be proceeding\b|\bposition has been filled\b|\bdecided to pursue other candidates\b|\bnot a (good )?fit at this time\b/],
  ['interview', 0.85, /\binterview\b[\s\S]{0,120}\b(schedul|invite|slot|availability|confirm|round|call)\w*|\b(schedule|book) (a|your) (call|time|slot)\b|\binvitation:\s|\bphone screen\b|\btechnical round\b/],
  ['assessment', 0.85, /\b(online (assessment|test)|coding (challenge|test|assessment)|take[\s-]?home (assignment|task|test)|assignment\b[\s\S]{0,80}\bsubmit|technical assessment|aptitude test)\b/],
  ['application_confirmation', 0.85, /\b(thank you|thanks) for (applying|your application|your interest)\b|\b(we('ve| have)|has been) received your application\b|\bapplication (has been )?(received|submitted)\b|\bsuccessfully applied\b|\byour application was sent to\b/],
];

export const OPT_OUT = /\b(unsubscribe|remove me|do not contact|don't contact|stop (emailing|contacting)|not interested, thanks|please don't email)\b/i;

// Hiring platforms whose (authenticated) mail can be trusted to describe an application's state.
export function platformSender(fromAddr) {
  return ATS_SENDERS.test(fromAddr ?? '') || alertPlatform(fromAddr) != null;
}

export function alertPlatform(fromAddr) {
  return ALERT_SENDERS.find(([, re]) => re.test(fromAddr))?.[0] ?? null;
}

export function classifyEmail(msg, { ourThreadIds = new Set() } = {}) {
  const subject = msg.subject ?? '';
  const body = `${subject}\n${msg.text ?? ''}`.toLowerCase().slice(0, 8000);
  const platform = alertPlatform(msg.fromAddr ?? '');
  const inOurThread = ourThreadIds.has(msg.threadId);
  if (inOurThread && OPT_OUT.test(msg.text?.slice(0, 1500) ?? '')) return { category: 'opt_out', confidence: 0.9 };
  for (const [category, confidence, re] of RULES) {
    if (re.test(body)) {
      if (category === 'assessment' || ASSESSMENT_HOSTS.test(body)) return { category: 'assessment', confidence };
      return { category, confidence };
    }
  }
  if (ASSESSMENT_HOSTS.test(body) && /\b(test|assessment|challenge)\b/.test(body)) return { category: 'assessment', confidence: 0.8 };
  if (platform && /\b(jobs?|alert|recommend|match|hiring|openings?|opportunit)/i.test(subject + body.slice(0, 500))) {
    return { category: 'job_alert', confidence: 0.9, platform };
  }
  if (inOurThread) return { category: 'recruiter_reply', confidence: 0.75 };
  if (ATS_SENDERS.test(msg.fromAddr ?? '')) return { category: 'ats_update', confidence: 0.5 };
  return { category: 'other', confidence: 0.5 };
}

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_RE = new RegExp(`\\b(\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})(?:,?\\s+\\d{4})?|(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})(?:[^\\n.]{0,20}?\\b(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|ist)))?`, 'gi');

export function extractDetails(msg) {
  const text = msg.text ?? '';
  const links = [...new Set((text + ' ' + (msg.html ?? '')).match(/https?:\/\/[^\s"'<>)]+/g) ?? [])];
  const dates = [...text.matchAll(DATE_RE)].slice(0, 5).map((m) => m[0].trim());
  const deadline = text.match(/\b(?:deadline|due|complete (?:it )?(?:by|before|within)|submit (?:it )?(?:by|before|within)|expires?(?: on)?)\b[^.\n]{0,60}/i)?.[0] ?? null;
  return {
    dates,
    deadline,
    assessmentLinks: links.filter((l) => ASSESSMENT_HOSTS.test(l)).slice(0, 5),
    meetingLinks: links.filter((l) => MEETING_HOSTS.test(l)).slice(0, 5),
    attachments: (msg.attachments ?? []).map((a) => a.filename),
  };
}

// Platform job links and the identity to deduplicate them by.
const ALERT_LINKS = [
  [/linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/?]*-)?(\d{6,})/i, (m) => `https://www.linkedin.com/jobs/view/${m[1]}`],
  [/naukri\.com\/job-listings-([a-z0-9-]+)/i, (m) => `https://www.naukri.com/job-listings-${m[1]}`],
  [/wellfound\.com\/(?:company\/[^/]+\/)?jobs\/(\d+)[^"\s?]*/i, (m) => `https://wellfound.com/jobs/${m[1]}`],
  [/cutshort\.io\/job\/([A-Za-z0-9-]+)/i, (m) => `https://cutshort.io/job/${m[1]}`],
  [/instahyre\.com\/job-(\d+)[^"\s?]*/i, (m) => `https://www.instahyre.com/job-${m[1]}`],
  [/internshala\.com\/(internship|job)\/detail\/([a-z0-9-]+)/i, (m) => `https://internshala.com/${m[1]}/detail/${m[2]}`],
  [/indeed\.(?:com|co\.in)\/(?:viewjob|rc\/clk|pagead\/clk)\?[^"\s]*jk=([a-f0-9]+)/i, (m) => `https://in.indeed.com/viewjob?jk=${m[1]}`],
  [/foundit\.in\/job\/([a-z0-9-]+)/i, (m) => `https://www.foundit.in/job/${m[1]}`],
];

const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// Parse an alert email into [{url, title, company, location}] using anchor text and nearby text.
export function parseJobAlert(msg) {
  const html = msg.html ?? '';
  const out = new Map();
  const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  anchors.forEach((a, i) => {
    const href = a[1].replace(/&amp;/g, '&');
    for (const [re, canon] of ALERT_LINKS) {
      const m = href.match(re);
      if (!m) continue;
      const url = canon(m);
      const text = stripTags(a[2]);
      const job = out.get(url) ?? { url, title: '', company: '', location: '' };
      if (text && text.length > 3 && text.length < 140 && !/^(view|apply|see|more|easy apply)/i.test(text)) {
        if (!job.title) job.title = text;
        else if (!job.company) job.company = text;
      }
      if (!job.company || !job.location) {
        // Text right after the title anchor usually reads "Company · Location" (LinkedIn) or "Company | Location".
        const tail = stripTags(html.slice(a.index + a[0].length, (anchors[i + 1]?.index ?? a.index + 1200))).slice(0, 200);
        const parts = tail.split(/\s[·|•–-]\s|\n/).map((s) => s.trim()).filter(Boolean);
        if (!job.company && parts[0] && parts[0].length < 80) job.company = parts[0];
        if (!job.location && parts[1] && parts[1].length < 80) job.location = parts[1];
      }
      out.set(url, job);
      break;
    }
  });
  return [...out.values()].filter((j) => j.title);
}
