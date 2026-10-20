// Rule-first email understanding: category, confidence, extracted next steps, job-alert parsing and
// application details. An LLM (no-training provider only) is consulted just for messages the rules
// cannot decide. Formats here were checked against real hiring mail (foundit, SHL, LinkedIn, ATSs).

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
  ['unstop', /@(.*\.)?unstop\.com$/],
];

const ATS_SENDERS = /@(.*\.)?(greenhouse\.io|greenhouse-mail\.io|lever\.co|hire\.lever\.co|ashbyhq\.com|myworkday\.com|smartrecruiters\.com|workablemail\.com|workable\.com|recruitee\.com|teamtailor\.com|breezy\.hr|freshteam\.com|zohorecruit\.(com|in)|keka\.com|darwinbox\.(in|com)|icims\.com|successfactors\.com|jobvite\.com|bamboohr\.com)$/;
// Assessment vendors that send tests on an employer's behalf.
const VENDOR_SENDERS = /@(.*\.)?(shl\.com|aspiringminds\.com|hackerrank\.com|hackerrankforwork\.com|codility\.com|hackerearth\.com|mettl\.com|mercer-mettl\.com|testgorilla\.com|imocha\.io|codesignal\.com|talview\.com|hirepro\.in|elitmus\.com|glider\.ai|xobin\.com|doselect\.com)$/;
const ASSESSMENT_HOSTS = /(hackerrank\.com|codility\.com|hackerearth\.com|mettl\.com|testgorilla\.com|imocha\.io|codesignal\.com|coderbyte\.com|glider\.ai|vervoe\.com|xobin\.com|testdome\.com|interviewbit\.com|hirepro\.in|amcat|aspiringminds\.com|shl\.com|talview\.com|elitmus\.com|doselect\.com)/i;
const MEETING_HOSTS = /(meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|calendly\.com|webex\.com)/i;
// Newsletters and creator platforms: their articles mention interviews and assessments all the time.
const NEWSLETTER_SENDERS = /@([\w-]+\.)*(substack\.com|beehiiv\.com|medium\.com|mailchimpapp\.net|convertkit-mail\d*\.com|buttondown\.email|ghost\.io)$/i;

// Phrases that decide a category on their own (strong) or only hint at it (weak: confidence too low
// for automatic status changes). Matching is per sentence; a condition before the phrase
// ("if you are shortlisted, we will schedule an interview") cancels it.
const SIGNALS = [
  ['offer', {
    strong: [/\b(pleased|delighted|happy|excited) to (extend|offer) (you )?(an? |the |this )?(formal |written )?(offer|position|role|job)\b/,
      /\boffer of employment\b/, /\bletter of (offer|intent)\b/,
      // An offer letter being delivered; a mere mention ("offer letter upon batch confirmation") is only a hint.
      /\b(attached|enclosed|released|issued)\b[^.!?]{0,40}\boffer letter\b/, /\boffer letter\b[^.!?]{0,30}\b(attached|enclosed)\b/],
    weak: [/\bjob offer\b/, /\boffer letter\b/],
  }],
  ['rejection', {
    strong: [/\bnot (be )?(moving|move|going) forward with your (application|candidacy|profile)\b/,
      /\b(decided|chosen|decision) (not )?to (move|proceed|go) forward with (other |another |different )?candidates?\b/,
      /\b(won't|will not|unable to|not able to)( be able to)? take your (application|candidacy|profile) (forward|further)\b/,
      /\bmove forward with (other|another|different) candidates?\b/,
      /\bregret to inform\b[^.!?]{0,150}\b(application|candidacy|candidature|position|role|profile|shortlisted|selected|interview|opportunity)\b/,
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
    strong: [/\b(complete|take|attempt|start) (the|an|your|this|one or more) (online |coding |technical )?(assessments?|tests?|challenges?|assignments?)\b/,
      /\binvites you to complete\b/, /^assessment invitation\b/,
      /\b(online assessment|coding (challenge|test|assessment|round)|take[\s-]?home (assignment|task|test|exercise)|technical assessment|aptitude test)\b[^.!?]{0,120}\b(link|complete|deadline|within|invite|attempt|below)/],
    weak: [/\b(assessment|assignment|coding test)\b/],
  }],
  ['application_confirmation', {
    strong: [/\b(thank you|thanks)( again)? for (applying|your (recent )?application|submitting your application|your (online )?submission)\b/,
      /^application received\b/, /\byour\b.{0,40}\bapplication is in\b/,
      /\b(we('ve| have)|has been) received your application\b/, /\bwe('ve| have) successfully received your (application|submission)\b/,
      /\byour application will be (taken into (careful )?consideration|reviewed|considered)\b/,
      /\byour application (has been|was) (received|submitted|sent)\b/, /\byour application was sent to\b/,
      /\bapplication (received|submitted) successfully\b/, /\bsuccessfully (applied|submitted your application)\b/,
      /\bapplication successful\b/, /\byou['’]?ve applied to\b/, /\byou have (successfully )?applied (to|for)\b/,
      /\bapplication to .{2,80}? (was )?successfully submitted\b/],
    weak: [/\bapplication\b[^.!?]{0,30}\b(received|submitted)\b/],
  }],
];
const CONFIRMS = SIGNALS.find(([c]) => c === 'application_confirmation')[1].strong;
const CONDITION_BEFORE = /\b(if|should|once(?! again)|in case|whether|in the event)\b/;
// Fraud warnings in platform footers ("beware of ... seeking money for any job offer") are boilerplate.
const DISCLAIMER = /\b(fraud|scam|phish|impersonat)\w*|\b(beware|unscrupulous)\b|\bnever (asks?|charges?|requests?)\b/;
const hit = (sentence, re) => {
  const m = re.exec(sentence);
  return m != null && !CONDITION_BEFORE.test(sentence.slice(0, m.index));
};

export const OPT_OUT = /\b(unsubscribe|remove me|do not contact|don't contact|stop (emailing|contacting)|not interested, thanks|please don't email)\b/i;

export function alertPlatform(fromAddr) {
  return ALERT_SENDERS.find(([, re]) => re.test(fromAddr ?? ''))?.[0] ?? null;
}

// Hiring platforms and assessment vendors whose (authenticated) mail can be trusted to describe an
// application's state.
export function platformSender(fromAddr) {
  const a = fromAddr ?? '';
  return ATS_SENDERS.test(a) || VENDOR_SENDERS.test(a) || alertPlatform(a) != null;
}

// Drop quoted earlier messages ("On … wrote:", "> …", forwarded headers) so a reply is judged on what
// the sender actually wrote, not on our own email quoted underneath it.
export function stripQuoted(text) {
  // Bounded input and line-local patterns: the body is attacker-controlled.
  const t = String(text ?? '').slice(0, 20000);
  const cut = t.search(/^[ \t]*(on [^\n]{5,200}?(\n[^\n]{0,120}?)? wrote:|-{2,} ?(original|forwarded) message ?-{2,}|from: [^\n]{1,200}\n(sent|date): )/im);
  return (cut > 0 ? t.slice(0, cut) : t).split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
}

const sentences = (s) => s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
// Plain-text mail is hard-wrapped mid-sentence, the next line indented ("We have\r\n received your
// application", BMS): such lines are joined, so a phrase is not cut in two.
export const unwrap = (t) => String(t ?? '').replace(/\r/g, '').replace(/\n[ \t]+(?=\S)/g, ' ');
const JOB_LIST_SUBJECT = /\b(job alert|jobs? for you|new jobs?|recommended jobs?|jobs? matching|matching jobs?|\d+\+? (new )?(jobs?|openings|roles)|jobs? you may|top jobs?|job recommendations?|jobs? based on your)\b/i;

export function classifyEmail(msg, { ourThreadIds = new Set() } = {}) {
  const subject = String(msg.subject ?? '');
  const fromAddr = String(msg.fromAddr ?? '');
  const own = unwrap(stripQuoted(msg.text)).slice(0, 8000);
  // Curly apostrophes ("won’t", Headout) read as straight ones, so the phrases need one spelling only.
  const parts = sentences(`${subject}\n${own}`.toLowerCase().replace(/[‘’]/g, "'")).filter((p) => !DISCLAIMER.test(p));
  const inOurThread = ourThreadIds.has(msg.threadId);
  if (/^(mailer-daemon|postmaster)@/i.test(fromAddr)
    && /delivery status notification|undeliverable|delivery (has )?failed|address not found|returned mail|failure notice|could not be delivered/i.test(subject)) {
    return { category: 'bounce', confidence: 0.95 };
  }
  if (inOurThread && OPT_OUT.test(own.slice(0, 1500))) return { category: 'opt_out', confidence: 0.9 };
  if (NEWSLETTER_SENDERS.test(fromAddr) && !inOurThread) return { category: 'other', confidence: 0.5 };
  // A fraud-awareness notice ("Beware of fraudsters impersonating ...") is not about an application.
  if (DISCLAIMER.test(subject.toLowerCase()) && !inOurThread) return { category: 'other', confidence: 0.6 };
  // A code to finish submitting ("Security code for your application to Verifone", Greenhouse) confirms
  // nothing: the application exists only once the code is entered (the AI had called it a confirmation).
  if (/\b(security|verification) code\b/i.test(subject)) return { category: 'other', confidence: 0.9 };

  // Platform confirmations carry upsells ("Schedule your first interview", practice tests). When the
  // subject confirms an application, an interview or assessment also needs its meeting or test link.
  const confirms = !/^re:/i.test(subject) && sentences(subject.toLowerCase()).some((p) => CONFIRMS.some((re) => hit(p, re)));
  for (const [category, { strong }] of SIGNALS) {
    if (!parts.some((p) => strong.some((re) => hit(p, re)))) continue;
    if (confirms && ((category === 'interview' && !MEETING_HOSTS.test(own)) || (category === 'assessment' && !ASSESSMENT_HOSTS.test(own)))) continue;
    return { category, confidence: 0.9 };
  }
  if (ASSESSMENT_HOSTS.test(own) && /\b(test|assessment|challenge)\b/i.test(own)) return { category: 'assessment', confidence: 0.85 };

  const platform = alertPlatform(fromAddr);
  if (platform) {
    if (/\b(viewed|seen) your (application|profile)\b|\byour application was viewed\b/i.test(subject)) return { category: 'ats_update', confidence: 0.6 };
    if (/alert|jobs-listings|jobalert|recommend/i.test(fromAddr.split('@')[0]) || JOB_LIST_SUBJECT.test(subject)) {
      return { category: 'job_alert', confidence: 0.9, platform };
    }
  }
  // Weak hints only count from hiring senders or in our own threads; elsewhere "interview" is just a word.
  if (inOurThread || platformSender(fromAddr)) {
    for (const [category, { weak }] of SIGNALS) {
      if (parts.some((p) => weak.some((re) => hit(p, re)))) return { category, confidence: 0.6 };
    }
  }
  if (inOurThread) return { category: 'recruiter_reply', confidence: 0.75 };
  if (ATS_SENDERS.test(fromAddr)) return { category: 'ats_update', confidence: 0.5 };
  return { category: 'other', confidence: 0.5 };
}

// Which of the candidate's own sent emails are about a job (the Email page tracks only those, their choice,
// 2026-10-20): the subject names a job, a role or an application. Paper, conference and journal mail
// ("Abstract Submission – CONFLUENCE-2026", "Application of ... – paper") is not.
// ponytail: subject words only; a job email whose subject names none of them is missed.
const JOB_SUBJECT = /\b(jobs?|positions?|roles?|openings?|vacanc(y|ies)|opportunit(y|ies)|applications?|applying|interns?|internships?|hiring|recruit\w*|resumes?|cv|candidature|interviews?|referrals?|careers?|analysts?|engineers?|scientists?|developers?)\b/i;
const ACADEMIC_SUBJECT = /\b(abstracts?|papers?|manuscripts?|conferences?|journals?|proceedings|camera[- ]ready|reviewers?|editors?)\b/i;
export const isJobEmail = (subject) => JOB_SUBJECT.test(subject ?? '') && !ACADEMIC_SUBJECT.test(subject ?? '');

// The reply a sent email shows, of two ({category, at}): the later one, except that a plain reply never
// hides an earlier decision (a "thanks, see you then" after an interview invitation).
export const DECISIONS = ['assessment', 'interview', 'offer', 'rejection'];
export function laterReply(a, b) {
  if (!a) return b;
  if (!b) return a;
  const [older, newer] = String(a.at) <= String(b.at) ? [a, b] : [b, a];
  return DECISIONS.includes(older.category) && !DECISIONS.includes(newer.category) ? older : newer;
}

const decode = (s) => String(s ?? '').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const clean = (s) => decode(s).replace(/[*_|]/g, ' ').replace(/\s+/g, ' ').trim();

// Company and role named in a confirmation or invitation, from the wording hiring platforms use.
// Returns {company, title, url} with nulls for anything not stated. A hidden company ("**") is null.
export function applicationDetails(msg) {
  const subject = decode(msg.subject);
  const text = decode(stripQuoted(msg.text)).slice(0, 6000);
  let company = null;
  let title = null;
  // Line breaks can fall between any two words (foundit's HTML puts "applied", "to", "job" on lines of their own).
  const found = text.match(/you['’]?ve\s+applied\s+to\s+(.{2,120}?)\s+job\s+at\s+(.{2,100}?)\.(?:\s|$)/is)               // foundit
    ?? text.match(/your\s+application\s+(?:for|to)\s+(?:the\s+)?(.{2,100}?)\s+(?:position|role|job|opening)\s+at\s+(.{2,80}?)[.!\n]/i)
    ?? text.match(/(?:thank\s+you|thanks)\s+for\s+applying\s+(?:for|to)\s+(?:the\s+)?(.{2,100}?)\s+(?:position|role|job|opening)\s+at\s+(.{2,80}?)[.!\n]/i);
  if (found) [title, company] = [found[1], found[2]];
  if (!company) {
    company = text.match(/recruitment\s+process\s+(?:(?:of|at|for)\s+)?(.{2,80}?)\s+(?:invites|has\s+invited|would\s+like)/i)?.[1]   // SHL and similar
      ?? subject.match(/^(.{2,80}?) application successful\b/i)?.[1]                                                // foundit subject
      ?? subject.match(/your application was sent to (.{2,80})$/i)?.[1]                                             // LinkedIn
      ?? subject.match(/^application to (.{2,80}?) successfully submitted\b/i)?.[1]                                 // Wellfound
      ?? subject.match(/application (?:to|for) .{2,80}? at (.{2,80}?)(?:[!.|]|$)/i)?.[1]
      ?? subject.match(/(?:applying (?:to|at|with)|interest in) ([A-Z][\w&.' -]{1,60}?)(?:[!.|,]| -|$)/)?.[1]
      ?? null;
  }
  // Wellfound lists the role as the first bullet, linked to wellfound.com/jobs/<id>.
  const wellfound = alertPlatform(msg.fromAddr) === 'wellfound' ? text.match(/\*\s+([^\n*<]{2,100}?)\s*<https:\/\/wellfound\.com\/jobs\/(\d+)/) : null;
  if (!title) title = subject.match(/application (?:to|for) (.{2,80}?) at /i)?.[1] ?? wellfound?.[1] ?? null;
  company = company && clean(company);
  if (!company || /^\*+$/.test(company)) company = null;
  // foundit puts the posting id in its links; a token-free public URL is rebuilt from it.
  const jobId = `${msg.text ?? ''} ${msg.html ?? ''}`.match(/jobId(?:%3D|=)(\d{5,})/i)?.[1];
  return {
    company,
    title: title && clean(title),
    url: jobId && alertPlatform(msg.fromAddr) === 'foundit' ? `https://www.foundit.in/seeker/job-details?id=${jobId}`
      : wellfound ? `https://wellfound.com/jobs/${wellfound[2]}` : null,
  };
}

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_RE = new RegExp(`\\b(\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})(?:,?\\s+\\d{4})?|(?:${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})(?:[^\\n.]{0,20}?\\b(\\d{1,2}[:.]\\d{2}\\s*(?:am|pm)?|\\d{1,2}\\s*(?:am|pm)))?`, 'gi');

export function extractDetails(msg) {
  const text = msg.text ?? '';
  const links = [...new Set((text + ' ' + (msg.html ?? '')).match(/https?:\/\/[^\s"'<>)\]]+/g) ?? [])];
  const dates = [...text.matchAll(DATE_RE)].slice(0, 5).map((m) => m[0].trim());
  const deadline = text.match(/\b(?:deadline|due (?:by|on|date)|expires?(?: on)?|(?:link|test|assessment) is valid|valid (?:from|till|until)|(?:complete|submit|finish|attempt)[^.\n]{0,30}?\b(?:by|before|within))\b[^\n]{0,90}/i)?.[0]
    ?.replace(/\s+/g, ' ').trim() ?? null;
  return {
    dates,
    deadline,
    // Links are kept only for known assessment/meeting hosts, and never with query strings
    // (auto-login and test-session tokens live there).
    assessmentLinks: links.filter((l) => ASSESSMENT_HOSTS.test(l)).map((l) => l.split('?')[0]).slice(0, 5),
    meetingLinks: links.filter((l) => MEETING_HOSTS.test(l)).map((l) => l.split('?')[0]).slice(0, 5),
    attachments: (msg.attachments ?? []).map((a) => a.filename),
  };
}

// Platform job links and the identity to deduplicate them by. Auto-login links are reduced to the
// posting id, so session tokens are never stored.
const ALERT_LINKS = [
  [/linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/?]*-)?(\d{6,})/i, (m) => `https://www.linkedin.com/jobs/view/${m[1]}`],
  [/naukri\.com\/job-listings-([a-z0-9-]+)/i, (m) => `https://www.naukri.com/job-listings-${m[1]}`],
  [/wellfound\.com\/(?:company\/[^/]+\/)?jobs\/(\d+)[^"\s?]*/i, (m) => `https://wellfound.com/jobs/${m[1]}`],
  [/cutshort\.io\/job\/([A-Za-z0-9-]+)/i, (m) => `https://cutshort.io/job/${m[1]}`],
  [/instahyre\.com\/job-(\d+)[^"\s?]*/i, (m) => `https://www.instahyre.com/job-${m[1]}`],
  [/internshala\.com\/(internship|job)\/detail\/([a-z0-9-]+)/i, (m) => `https://internshala.com/${m[1]}/detail/${m[2]}`],
  [/indeed\.(?:com|co\.in)\/(?:viewjob|rc\/clk|pagead\/clk)\?[^"\s]*jk=([a-f0-9]+)/i, (m) => `https://in.indeed.com/viewjob?jk=${m[1]}`],
  [/foundit\.in\/[^"\s]*?job-details(?:%3F|\?)id(?:%3D|=)(\d+)/i, (m) => `https://www.foundit.in/seeker/job-details?id=${m[1]}`],
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
      if (text && text.length > 3 && text.length < 140 && !/^(view|apply|see|more|easy apply|quick apply)/i.test(text)) {
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
