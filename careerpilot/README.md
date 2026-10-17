# CareerPilot AI

A zero-cost, cloud-scheduled job-search system for fresher AI/data roles in India, built on
[career-ops](https://github.com/career-ops-hq/career-ops) (MIT, pinned at `career-ops-v1.37.0`).
career-ops supplies the job-source providers (Greenhouse, Lever, Ashby, Workday, SmartRecruiters,
Workable and ~100 more) and URL canonicalization; this folder adds the cloud pipeline, Gmail,
outreach, application tracking and the dashboard.

```
GitHub Actions (every 2 h, PC off is fine)                      Vercel (later, read-only)
  discover ─ daily aggregator sweep (1.4M ATS postings) ─┐       dashboard ── Turso
           └ ~350 employer boards via career-ops providers│
  ai       ─ free-tier LLM fit check (Groq → Gemini → OpenRouter, queue if none)
  gmail    ─ classify mail, link to applications, update status, parse LinkedIn/Naukri/… alerts
  prepare  ─ answer packs; Ready / Blocked with the exact reason
  outreach ─ email applications + recruiter emails + follow-ups, behind a policy gate
  digest   ─ one email a day to you with what needs you
                         all state ──► Turso (free libSQL), personal data encrypted
Your PC: setup, npm run apply:assist (portal prefill), local dashboard
```

## What runs where, and what stops when

| Runs on | Work | Stops when |
|---|---|---|
| GitHub Actions (private repo, Free plan: 2,000 min/month) | All six stages every 2 h (~3 min each ≈ 1,100 min/month) | Minutes run out (resets monthly), GitHub delays/skips a scheduled run (catches up next run), secrets missing |
| Turso free tier | Database for jobs, applications, emails metadata, outreach, audit log | Free quota exceeded (writes refused; nothing is billed without a paid plan) |
| Gmail API | Read + send | Refresh token revoked/expired → dashboard shows the error; re-run `npm run gmail:auth` |
| Groq / Gemini / OpenRouter free tiers | Fit scoring, ambiguous email classification, email drafting | Quota hit → provider paused until reset; drafting falls back to a fact-only template, scoring is queued |
| Your PC | `apply:assist`, setup, local dashboard | Only when you use them |
| Vercel Hobby | Read-only dashboard | Not deployed yet |

## Honest limits

- **Portal applications are not auto-submitted.** Greenhouse/Lever/Ashby/Workday forms carry consent
  declarations and bot protection, and there is no candidate-side submission API. They become
  *Ready to apply* with an answer pack; `npm run apply:assist` prefills them in your Chrome and records
  the submission when the confirmation page appears.
- **Automatic submission happens only by email**, when a posting publishes an application address.
- **LinkedIn, Naukri, Wellfound, Cutshort, Instahyre, Internshala**: discovery via their job-alert
  emails only. Applying there stays with you (their terms forbid automation).
- **Recruiter contacts** are limited to addresses printed in postings and people who email you.
  No guessing, no paid enrichment, so many companies will have no contact.
- **Pay** is rarely disclosed in India; such jobs stay qualified but marked *Needs review*.
  Aggregator salary figures are modelled estimates and are ignored.
- **Scheduling** is "about every 2 hours", not real-time.

## Setup

See [SETUP.md](SETUP.md). Short version:

```bash
cd careerpilot && npm ci                 # plus `npm install --ignore-scripts` at the repo root once
npm run setup -- keys                    # encryption key + session secret into .env
npm run setup -- password                # dashboard password (hidden prompt)
# edit private/profile.yml (fill the null answers), then:
npm run setup -- profile                 # encrypt profile + resume into the database
npm run gmail:auth -- --github           # Google consent; token saved to .env and GitHub secrets
npm run setup -- github                  # copy the remaining secrets to GitHub Actions
npm run run -- all                       # one local run
npm run dev                              # dashboard at http://127.0.0.1:3000
npm test
```

## Implementation checklist

| Feature | Built | Tested | Notes |
|---|---|---|---|
| Rule matching (roles, seniority, experience, location, ₹7 LPA / ₹40k stipend) | ✅ | ✅ unit | Reason stored for every exclusion |
| Discovery: 15 curated + auto-discovered ATS boards | ✅ | ✅ live run (351 boards) | Workday boards fail during Workday weekend maintenance; retried, not disabled |
| Discovery: daily aggregator sweep | ✅ | ✅ live run (59 chunks, 1,240 India matches) | Data CC BY-NC (personal use) |
| Dedup (canonical URL + fingerprint), reposts, expiry | ✅ | ✅ unit + live (expired jobs verified closed on employer APIs) | |
| Gmail OAuth (readonly + send, PKCE, loopback) | ✅ | ⏳ needs your Google client | |
| Email classification, linking, status updates, review queue | ✅ | ✅ unit with fake Gmail | Live test after OAuth |
| Job-alert parsing (LinkedIn, Naukri, Wellfound, Cutshort, Instahyre, Internshala, Indeed, foundit) | ✅ | ✅ unit (LinkedIn/Naukri samples) | Real alert formats vary; check the first live runs |
| AI providers with fallback, cooldowns, cache, data-class policy | ✅ | ✅ unit (mocked) | Live test after keys |
| Email applications + outreach + follow-ups, caps, window, opt-out | ✅ | ✅ unit with fake Gmail | |
| Application state machine + evidence + audit | ✅ | ✅ unit + dashboard | |
| Portal prefill assistant | ✅ | ⏳ manual | Needs Chrome; never submits |
| Dashboard, auth, drill-downs | ✅ | ✅ all pages render, auth rejects anon/forged | Read-only mode for Vercel |
| Scheduled Actions run while PC is off | ✅ workflow | ⏳ after secrets are set | |
| Vercel deployment | ⏳ | — | After core checks pass |

## Licensing

career-ops is MIT (see `../LICENSE`). The aggregator company/job dataset
(github.com/Feashliaa/job-board-aggregator) is CC BY-NC 4.0: fine for this personal, non-commercial use.
