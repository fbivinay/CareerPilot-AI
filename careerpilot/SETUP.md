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

## 4. Gmail: one-time Google setup, then the Connect Gmail button

Google requires every app that reads Gmail to have its own OAuth client. For a personal app that
means registering one in your own Google Cloud project, once (about 10 minutes). A shared
"CareerPilot" client would need Google's paid security assessment for Gmail scopes, so it is not an
option at ₹0.

**A. Register the client (once)**, at https://console.cloud.google.com signed in as **rvinaykumar6924@gmail.com**:
1. Create project `careerpilot` (no billing).
2. https://console.cloud.google.com/apis/library/gmail.googleapis.com → **Enable**.
3. https://console.cloud.google.com/auth/overview → **Get started**: app name `CareerPilot`, your email, Audience **External**.
4. **Data Access** → Add scopes `.../auth/gmail.readonly` and `.../auth/gmail.send` → Save.
5. **Audience** → Test users → add your Gmail. Leave the app in **Testing** for now (see limitations below).
   Do not upload a logo on the Branding page: that makes Google require verification.
6. **Clients** → Create client → **Web application**. Under *Authorized redirect URIs* add:
   - `http://localhost:3000/api/gmail/callback`
   - `http://127.0.0.1:3000/api/gmail/callback`
   - later, your Vercel address: `https://<your-app>.vercel.app/api/gmail/callback`
7. Copy the **Client ID** and **Client secret** shown into `careerpilot/.env` (Notepad), as
   `GOOGLE_CLIENT_ID=...` and `GOOGLE_CLIENT_SECRET=...`. Never paste them into a chat.

**B. Connect (any time, from the dashboard)**: `npm run dev`, open http://localhost:3000/settings:
1. **Connect Gmail** → Google sign-in → "Google hasn't verified this app" → *Continue* (or *Advanced* → *Go to CareerPilot*) → allow reading email.
2. **Run read-only test**: reads the last 14 days in memory and shows how mail was sorted; nothing is sent or stored except counts.
3. **Enable sending** (only offered after step 2 passes) → allow "send email on your behalf".
4. **Send a test email to myself** to confirm.

The refresh token is encrypted with `APP_ENCRYPTION_KEY` and stored in the database (Turso), so the
GitHub Actions pipeline reads mail and sends while your PC is off. `npm run setup -- github` copies
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `APP_ENCRYPTION_KEY` to Actions; no token is ever a secret there.

**Google's limits for a personal app (checked against Google's documentation):**
- `gmail.readonly` is a *restricted* scope and `gmail.send` a *sensitive* one. Personal use (under 100 users)
  is exempt from verification; you click through the unverified-app warning once.
- In **Testing**, refresh tokens expire after **7 days**: the dashboard shows **Reconnect Gmail** and you
  click it again. **Publishing** (In production, unverified) removes that expiry, but Google first requires a
  public home page and privacy policy link on an authorized domain (Branding page). Add those when the
  dashboard is deployed (its `*.vercel.app` domain is the authorized domain), then publish and reconnect once.
- Access ends if you change your Google password, revoke it at myaccount.google.com/permissions, or the
  token goes unused for 6 months. The dashboard then shows **Reconnect Gmail**; the pipeline pauses
  Gmail stages until you do.
- Consumer Gmail sends to about 500 recipients/day; CareerPilot's limits are far below that.

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

## 8. Vercel (read-only dashboard)

Project `careerpilot` on the Hobby plan: root directory `careerpilot`, functions in Mumbai (`vercel.json`,
next to the Turso database), connected to this repository, so every push to `main` redeploys it.
`.vercelignore` keeps `.env`, `private/` and `.data/` from ever being uploaded by a CLI deploy.

```bash
npm run setup -- vercel    # sets TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, SESSION_SECRET, DASHBOARD_PASSWORD_HASH, DASHBOARD_READONLY=1
```

Gmail, AI and encryption keys are **not** on Vercel: the deployed dashboard can neither send mail nor
decrypt your profile or Gmail token. Change settings and connect Gmail from the local dashboard. No Vercel
cron is used. `/about` and `/privacy` are public (no sign-in); Google's Branding page links to them.

**Publishing the Google app** (removes the 7-day Gmail expiry): Branding → Application home page
`https://<your-app>.vercel.app/about`, Privacy policy `https://<your-app>.vercel.app/privacy`, Authorized
domains `<your-app>.vercel.app` → Save. Audience → **Publish app** → Confirm (do not submit for
verification). Then reconnect Gmail once from the local dashboard (Settings → Gmail).
