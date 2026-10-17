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

// Phrases that decide a category on their own (strong) or only hint at it (weak: confidence too low
// for automatic status changes, so the message goes to review). Matching is per sentence, and
// conditional sentences ("if you are shortlisted, we will schedule an interview") are ignored.
const SIGNALS = [
  ['offer', {
    strong: [/\b(pleased|delighted|happy|excited) to (extend|offer) (you )?(an? |the |this )?(formal |written )?(offer|position|role|job)\b/,
      /\boffer letter\b/, /\boffer of employment\b/, /\bletter of (offer|intent)\b/],
    weak: [/\bjob offer\b/],
  }],
  ['rejection', {
    strong: [/\bnot (be )?(moving|move|going) forward with your (application|candidacy|profile)\b/,
      /\b(decided|chosen|decision) (not )?to (move|proceed|go) forward with (other|another|different) candidates?\b/,
      /\bmove forward with (other|another|different) candidates?\b/, /\bregret to inform\b/,
      /\b(have|has) not been (selected|shortlisted)\b/, /\bwill not be (proceeding|progressing|moving forward)\b/,
      /\b(unable|not able) to (move forward|proceed|offer you)\b/, /\bdecided not to (proceed|progress|move forward)\b/,
      /\bpursue other candidates\b/, /\bposition has (now )?been filled\b/, /\bnot (to )?progress(ing)? your application\b/,
      /\b(won't|will not) be moving forward\b/, /\bno longer (being )?considered\b/],
    weak: [/\bunfortunately\b/],
  }],
  ['interview', {
    strong: [/\b(invite|invited|inviting) you (to|for) (an? |the |our )?([\w-]+ ){0,2}(interview|conversation|discussion)\b/,
      /\bschedule (an?|your|the) ([\w-]+ )?interview\b/, /\binterview (invitation|invite|scheduled|confirmation|slot|details|is scheduled)\b/,
      /\b(phone|video|technical|hr|first|second|final|next) (screen|round|interview)\b[^.!?]{0,60}\b(schedul|slot|availab|confirm|join|link|at \d)/,
      /\bshare your availability\b/, /\bbook a (time|slot)\b/, /calendly\.com\//, /^invitation: /],
    weak: [/\binterview\b/],
  }],
  ['assessment', {
    strong: [/\b(complete|take|attempt|start) (the|an|your|this) (online |coding |technical )?(assessment|test|challenge|assignment)\b/,
      /\b(online assessment|coding (challenge|test|assessment|round)|take[\s-]?home (assignment|task|test|exercise)|technical assessment|aptitude test)\b[^.!?]{0,120}\b(link|complete|deadline|within|invite|attempt|below)/],
    weak: [/\b(assessment|assignment|coding test)\b/],
  }],
  ['application_confirmation', {
    strong: [/\b(thank you|thanks) for (applying|your application|submitting your application)\b/, /\b(we('ve| have)|has been) received your application\b/,
      /\byour application (has been|was) (received|submitted|sent)\b/, /\byour application was sent to\b/,
      /\bapplication (received|submitted) successfully\b/, /\bsuccessfully (applied|submitted your application)\b/],
    weak: [/\bapplication\b[^.!?]{0,30}\b(received|submitted)\b/],
  }],
];
// A condition only cancels an event when it precedes it in the sentence ("If shortlisted, we will schedule
// an interview"); a trailing clause ("..., should another role match") does not cancel a real rejection.
const CONDITION_BEFORE = /\b(if|should|once(?! again)|in case|whether|in the event)\b/;
const hit = (sentence, re) => {
  const m = re.exec(sentence);
  return m != null && !CONDITION_BEFORE.test(sentence.slice(0, m.index));
};

export const OPT_OUT = /\b(unsubscribe|remove me|do not contact|don't contact|stop (emailing|contacting)|not interested, thanks|please don't email)\b/i;

// Hiring platforms whose (authenticated) mail can be trusted to describe an application's state.
export function platformSender(fromAddr) {
  return ATS_SENDERS.test(fromAddr ?? '') || alertPlatform(fromAddr) != null;
}

export function alertPlatform(fromAddr) {
  return ALERT_SENDERS.find(([, re]) => re.test(fromAddr))?.[0] ?? null;
}

// Drop quoted earlier messages ("On … wrote:", "> …", forwarded headers) so a reply is judged on what
// the sender actually wrote, not on our own email quoted underneath it.
export function stripQuoted(text) {
  const t = String(text ?? '');
  const cut = t.search(/^\s*(on [\s\S]{5,200}? wrote:|-{2,} ?(original|forwarded) message ?-{2,}|from: [^\n]+\n(sent|date): )/im);
  return (cut > 0 ? t.slice(0, cut) : t).split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
}

const sentences = (s) => s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);

export function classifyEmail(msg, { ourThreadIds = new Set() } = {}) {
  const subject = String(msg.subject ?? '');
  const own = stripQuoted(msg.text).slice(0, 8000);
  const parts = sentences(`${subject}\n${own}`.toLowerCase());
  const inOurThread = ourThreadIds.has(msg.threadId);
  if (/^(mailer-daemon|postmaster)@/i.test(msg.fromAddr ?? '')
    && /delivery status notification|undeliverable|delivery (has )?failed|address not found|returned mail|failure notice|could not be delivered/i.test(subject)) {
    return { category: 'bounce', confidence: 0.95 };
  }
  if (inOurThread && OPT_OUT.test(own.slice(0, 1500))) return { category: 'opt_out', confidence: 0.9 };

  for (const [category, { strong }] of SIGNALS) {
    if (parts.some((p) => strong.some((re) => hit(p, re)))) return { category, confidence: 0.9 };
  }
  if (ASSESSMENT_HOSTS.test(own) && /\b(test|assessment|challenge)\b/i.test(own)) return { category: 'assessment', confidence: 0.85 };

  const platform = alertPlatform(msg.fromAddr ?? '');
  if (platform) {
    if (/\b(viewed|seen) your (application|profile)\b|\byour application was viewed\b/i.test(subject)) return { category: 'ats_update', confidence: 0.6 };
    if (/alert|job|notif/i.test(String(msg.fromAddr).split('@')[0]) || /\b(jobs?|alert|recommend|match(es|ing)?|hiring|openings?|opportunit)/i.test(subject)) {
      return { category: 'job_alert', confidence: 0.9, platform };
    }
  }
  for (const [category, { weak }] of SIGNALS) {
    if (parts.some((p) => weak.some((re) => hit(p, re)))) return { category, confidence: 0.6 };
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
  const deadline = text.match(/\b(?:deadline|due (?:by|on|date)|expires?(?: on)?|(?:complete|submit|finish|attempt)[^.\n]{0,30}?\b(?:by|before|within))\b[^.\n]{0,40}/i)?.[0] ?? null;
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
