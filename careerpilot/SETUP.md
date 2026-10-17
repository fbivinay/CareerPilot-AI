# CareerPilot setup

Every value below goes into `careerpilot/.env` (gitignored) and, where noted, into GitHub Actions
secrets via `npm run setup -- github`. Nothing secret ever needs to be pasted into a chat.

## 0. Zero-cost guardrails (do these first)

- **GitHub** → Settings → Billing and plans: no payment method on the account. Actions then stops at
  the free quota instead of billing. Keep the repository **private**.
- **Google Cloud**: never link a billing account to the project. The Gmail API needs none.
- **Gemini / Groq / OpenRouter**: create keys without adding a card or credits. A Gemini key from a
  billing-enabled project is a *paid* key, so use a project without billing.
- **Turso**: Free plan only, no card.

## 1. Local software

- Node.js 22.13+ (you have 24), Git, `gh` (logged in as fbivinay), Google Chrome.
- From the repo root: `npm install --ignore-scripts` (career-ops providers), then `cd careerpilot && npm ci`.

## 2. Database: Turso (free)

1. Sign up at https://app.turso.tech (GitHub login works).
2. Create database `careerpilot`, location **AWS US East (Virginia)**, which is closest to GitHub's runners.
3. Database → Connect → copy the `libsql://…` URL into `TURSO_DATABASE_URL`, create a token, put it in `TURSO_AUTH_TOKEN`.

Free plan (check https://turso.tech/pricing): about 5 GB storage, 500M rows read and 10M rows written
per month. This project uses a small fraction of that.

## 3. Keys, password, profile

```bash
cd careerpilot
npm run setup -- keys        # APP_ENCRYPTION_KEY and SESSION_SECRET
npm run setup -- password    # dashboard password (12+ chars), hidden prompt
```

Edit `private/profile.yml`. It was built from your resume; **fill every `null` answer you are willing
to give** (earliest start dates, internship duration, work authorization, relocation). Applications
that need a missing answer stay *Blocked* rather than guessing. Then:

```bash
npm run setup -- profile     # encrypts profile + private/master-resume.pdf into Turso
```

## 4. Gmail (official API, OAuth)

1. https://console.cloud.google.com, signed in as **rvinaykumar6924@gmail.com** → create project `careerpilot` (no billing).
2. APIs & Services → Library → **Gmail API** → Enable.
3. Google Auth Platform → Branding: app name `CareerPilot`, support email = your Gmail.
4. Audience: **External**; add yourself as a test user.
5. Data access → Add scopes: `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.send`.
6. Clients → Create client → **Desktop app** → copy Client ID / Client secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
7. Audience → **Publish app** (to "In production") and leave it unverified. While an app is in *Testing*,
   Google expires its refresh tokens after 7 days, which would stop the cloud pipeline weekly.
   A personal, unverified production app works for your own account; you will click through
   "Google hasn't verified this app" once. If that is refused, stay in Testing and re-run step 8 weekly.
8. `npm run gmail:auth -- --github` → consent in the browser. The refresh token is written to `.env`
   and stored as the GitHub secret `GMAIL_REFRESH_TOKEN`, never printed.

## 5. AI providers (optional, free)

| Provider | Where | Used for | Free-tier notes (verify on the provider's page) |
|---|---|---|---|
| Groq | https://console.groq.com/keys → `GROQ_API_KEY` | Fit scoring, email classification, drafts (may see resume facts and email text) | Per-model daily request/token caps; no training on API data per Groq's terms |
| Gemini | https://aistudio.google.com/apikey (project **without billing**) → `GEMINI_API_KEY` | Public job data only | Free tier content may be used to improve Google products, so it never receives your resume or email |
| OpenRouter | https://openrouter.ai/keys, no credits → `OPENROUTER_API_KEY` | Public job data only, `:free` models only | About 50 free requests/day without purchased credits |

With no keys at all, everything still runs: rules do the matching and emails use a fact-only template.

## 6. GitHub Actions

```bash
npm run setup -- check     # shows which values are present (names only)
npm run setup -- github    # copies them to the repository's Actions secrets
```

Then GitHub → Actions → `careerpilot-pipeline` → **Run workflow** once to confirm. After that it runs
every 2 hours on its own, with your PC off.

## 7. Raising email volume safely

Defaults: 10 email applications and 10 recruiter emails per day, weekdays 09:30–18:30 IST, one
company contacted at most twice per 21 days, one follow-up after 7 days. Consumer Gmail allows about
500 recipients/day, but reputation, not quota, is the real limit for cold email. Raise limits in
Settings by about 5/day per week while replies are healthy and nothing bounces. Every email carries
an opt-out line; an "unsubscribe" reply blocks that contact permanently.

## 8. Vercel (later, not done yet)

Project root directory `careerpilot`, framework Next.js, Hobby plan. Environment variables:
`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `SESSION_SECRET`, `DASHBOARD_PASSWORD_HASH`,
`DASHBOARD_READONLY=1`. No Vercel cron is used. Gmail and AI keys are **not** needed on Vercel.
