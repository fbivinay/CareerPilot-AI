// Workday candidate portals (<tenant>.wdN.myworkdayjobs.com): signs in to, or creates, the candidate's
// account for that employer, fills the application from the verified profile and submits it.
// Never fills a field it does not recognise (Workday forms carry honeypot inputs), never solves a
// CAPTCHA, never invents an answer: anything it cannot answer stops the application as 'blocked'.
import { randomBytes } from 'node:crypto';
import { now, one } from '../db.mjs';
import { vaultGet, vaultPut } from '../vault.mjs';

const A = (id) => `[data-automation-id="${id}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debug = process.env.CP_DEBUG ? (...a) => console.log('[workday]', ...a) : () => {};

// Only genuine Workday candidate portals: job URLs come from scraped and emailed data, and a tenant's
// saved password must never be typed into a look-alike host.
export function portalHost(url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com$/.test(host)) throw new Error(`not a Workday candidate portal: ${host}`);
  return host;
}
const onPortal = (page, host) => new URL(page.url()).hostname.toLowerCase() === host;

// One account per employer portal, encrypted in the vault. Saved before the account is created, so a
// crash after Workday accepted it never loses the password.
const accountKey = (host) => `workday:${host}`;
async function loadAccount(db, host) {
  const blob = await vaultGet(db, accountKey(host));
  return blob ? JSON.parse(blob.toString('utf8')) : null;
}
const saveAccount = (db, host, account) => vaultPut(db, accountKey(host), JSON.stringify(account));

// Workday's usual rules: upper, lower, digit, special, 8+ characters.
const newPassword = () => `Aa1!${randomBytes(12).toString('base64url')}`;

export async function captchaPresent(page) {
  return (await page.locator('iframe[src*="captcha" i], iframe[title*="captcha" i], [data-automation-id="captcha"], [data-automation-id*="Captcha" i]:not([data-automation-id="noCaptchaWrapper"])').count()) > 0;
}

async function activeStep(page) {
  const t = await page.locator(A('progressBarActiveStep')).first().innerText().catch(() => '');
  return t.replace(/^current step \d+ of \d+\s*/i, '').trim();
}

// Every visible form control on the current step: what it asks, how, and whether it is required.
// ($$eval is Playwright's in-page query: it runs this function in the page, it is not a string eval.)
export async function formFields(page) {
  return page.$$eval('input, textarea, button[aria-haspopup="listbox"], [role="combobox"], [data-automation-id="multiSelectContainer"]', (nodes) => nodes
    .filter((n) => n.offsetParent !== null && n.getAttribute('type') !== 'hidden' && n.getAttribute('data-automation-id') !== 'beecatcher')
    .map((n) => {
      const group = n.closest('[data-automation-id^="formField-"], fieldset, [role="group"]');
      const label = (group?.querySelector('label, legend')?.innerText || n.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      return { id: n.getAttribute('data-automation-id'), tag: n.tagName.toLowerCase(), type: n.getAttribute('type'),
        label: label.slice(0, 120), required: /\*$/.test(label) || n.getAttribute('aria-required') === 'true', value: n.value ?? null,
        group: group?.getAttribute('data-automation-id') ?? null };
    }));
}

async function pageErrors(page) {
  const errors = await page.locator(`${A('errorMessage')}, ${A('inputAlert')}`).allInnerTexts().catch(() => []);
  // role="alert" also carries screen-reader announcements ("AI Intern page is loaded", "… successfully
  // uploaded"): from there only messages that read as errors count.
  const alerts = (await page.locator('[role="alert"]').allInnerTexts().catch(() => []))
    .filter((t) => /error|invalid|required|must|incorrect|wrong|failed|unable|not valid|please (enter|select|provide|complete)/i.test(t));
  return [...new Set([...errors, ...alerts].map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

// Workday's primary buttons are inert (aria-hidden): the clickable element is the transparent
// role="button" div (click_filter) laid over them in the same container.
async function clickPrimary(page, buttonId) {
  const button = page.locator(A(buttonId)).first();
  const overlay = button.locator('xpath=..').locator(A('click_filter'));
  if (await overlay.count()) await overlay.first().click();
  else await button.click();
}

// The posting, with its Apply button ready: true, or false when the employer has taken it down.
const CLOSED_TEXT = /page you are looking for doesn.t exist|no longer (available|accepting)|(job|posting|position) (is |has been )?(closed|filled|not available)/i;
async function openPosting(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 60; i++) {
    if (await page.locator(A('adventureButton')).count()) return true;
    if (CLOSED_TEXT.test(await page.locator('body').innerText().catch(() => ''))) return false;
    await page.waitForTimeout(500);
  }
  throw new Error('The posting showed neither an Apply button nor a closed notice within 30 s');
}

// Apply → Apply Manually. Resolves 'signed-out' when the account form shows, 'in-form' when the first
// application step's fields do. (The step bar renders before either, so it is not a signal.)
async function startApplication(page) {
  await page.click(A('adventureButton'));
  const manual = page.locator(A('applyManually'));
  await manual.first().waitFor({ timeout: 20000 }).catch(() => {});
  if (await manual.count()) await manual.first().click();
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(1000);
    if (await chooseEmailSignIn(page)) continue;
    if (await page.locator(`input${A('email')}`).count()) return 'signed-out';
    if (!/sign in|create account/i.test(await activeStep(page)) && (await page.locator('[data-automation-id^="formField-"]').count())) return 'in-form';
  }
  throw new Error('the application did not open');
}

// The verification link for this portal's account: from mail Gmail authenticated (SPF/DKIM aligned) and
// sent from a Workday domain, received after the account was created (msg.date is Gmail's own receive
// time), pointing at this same portal. Anyone can send mail that merely claims to come from Workday, and
// another employer's verification link must not be opened for this one.
// Some employers send it from their own domain, named after the portal's tenant (Barclays: barclays.com for
// barclays.wd3.myworkdayjobs.com; TransUnion: transunionapps.com). A short tenant ("ag") must be the whole
// name. What protects the account is the link itself: https, on this very portal.
const WORKDAY_SENDER = /(^|\.)(myworkday|workday|myworkdayjobs)\.com$/i;
export const verificationSender = (domain, host) => {
  const d = String(domain ?? '').toLowerCase();
  const tenant = host.split('.')[0];
  const name = d.split('.').slice(-2)[0] ?? '';
  return WORKDAY_SENDER.test(d) || name === tenant || (tenant.length >= 4 && name.startsWith(tenant));
};
const onHost = (u, host) => { try { const x = new URL(u); return x.protocol === 'https:' && x.hostname.toLowerCase() === host; } catch { return false; } };
async function verificationLink(gmail, sinceMs, host) {
  for (let i = 0; i < 18; i++) { // up to ~3 minutes
    // By subject: an employer's own sender domain can be anything named after it (transunionapps.com).
    const ids = await gmail.listIds('newer_than:1d subject:(verify OR verification OR activate OR confirm)', 20);
    for (const id of ids) {
      const msg = await gmail.get(id);
      if (!msg.authenticated || !verificationSender(String(msg.fromAddr ?? '').split('@')[1], host)) continue;
      if (!msg.date || new Date(msg.date).getTime() < sinceMs - 60_000) continue;
      const link = (msg.html.match(/https:\/\/[^"'\s<>]+/g) ?? []).concat(msg.text.match(/https:\/\/\S+/g) ?? [])
        .map((u) => u.replace(/&amp;/g, '&')).find((u) => /verif|activat|confirm/i.test(u) && onHost(u, host));
      if (link) return link;
    }
    await sleep(10_000);
  }
  return null;
}

// Workday asks some new accounts to confirm their email ("An email has been sent to you. Please verify
// your account."): open the link from Gmail, then sign in again (the caller starts over).
const VERIFY_TEXT = /verify (your )?(candidate )?(account|email)|email has been sent|activate your account|not (yet )?(been )?(activated|verified)/i;
async function verifyByEmail(page, { db, gmail, host, account, log }) {
  log('workday: email verification requested');
  const link = gmail && await verificationLink(gmail, new Date(account.createdAt).getTime(), host);
  if (!link) { await saveAccount(db, host, { ...account, state: 'unverified' }); return { stop: 'blocked', reason: 'Workday asked to verify the account and the email did not arrive' }; }
  await page.goto(link, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  if (!onPortal(page, host)) { await saveAccount(db, host, { ...account, state: 'unverified' }); return { stop: 'blocked', reason: `Verification link left ${host}` }; }
  await saveAccount(db, host, { ...account, state: 'active', verifiedAt: now() });
  return { reopen: true };
}

// Some portals open sign-in with a choice of "Sign in with Google" or "Sign in with email": email, always.
async function chooseEmailSignIn(page) {
  const byEmail = page.getByRole('button', { name: /^(sign in|continue|log in) with email$/i });
  if (await byEmail.count()) { await byEmail.first().click(); await page.waitForTimeout(1500); return true; }
  return false;
}

// Waits for an account form to go away (signed in, or account created), or returns why it did not.
// Signing in takes a few seconds; a click that landed before the form was ready does nothing, so it is
// repeated once.
async function formGone(page, buttonId) {
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    if (VERIFY_TEXT.test(await page.locator('body').innerText().catch(() => ''))) return { verify: true };
    if (!(await page.locator(A(buttonId)).count())) return null;
    const errors = await pageErrors(page);
    if (errors.length) return { stop: 'blocked', reason: `Workday account: ${errors.join('; ')}` };
    if (i === 10) await clickPrimary(page, buttonId);
  }
  return { stop: 'blocked', reason: 'Workday sign-in did not complete within 30 s' };
}

// Signs in from the page header, before applying: starting the application signed out and signing in
// inside it collides with a draft already saved for this posting (Workday answers 400, then errors).
async function signIn(page, account, host, ctx) {
  if (!onPortal(page, host)) return { stop: 'blocked', reason: `Sign-in page is not on ${host}` };
  if (!(await page.locator(A('signInSubmitButton')).count())) {
    await page.click(A('utilityButtonSignIn'));
    await page.waitForTimeout(1500);
    await chooseEmailSignIn(page);
    await page.waitForSelector(A('signInSubmitButton'), { timeout: 30000 });
  }
  if (await captchaPresent(page)) return { stop: 'needs_you', reason: 'Workday shows a CAPTCHA on sign-in' };
  // Checked again right before typing: the clicks above could have navigated anywhere.
  if (!onPortal(page, host)) return { stop: 'blocked', reason: `Sign-in page is not on ${host}` };
  await page.fill(A('email'), account.email);
  await page.fill(A('password'), account.password);
  await page.locator(A('password')).press('Tab'); // Workday reads the field on blur
  await page.waitForTimeout(700);
  await clickPrimary(page, 'signInSubmitButton');
  const r = await formGone(page, 'signInSubmitButton');
  return r?.verify ? verifyByEmail(page, { ...ctx, host, account }) : r;
}

// Creates the candidate's account from the application's first step. Returns null when the application
// continues, {reopen: true} after an email verification, or {stop, reason}.
async function createAccount(page, { db, gmail, host, email, log }) {
  if (await captchaPresent(page)) return { stop: 'needs_you', reason: 'Workday shows a CAPTCHA on account creation' };
  if (!onPortal(page, host)) return { stop: 'blocked', reason: `Account page is not on ${host}` };
  if (!(await page.locator(A('verifyPassword')).count())) { // sign-in form first: switch to Create Account
    const link = page.locator(A('createAccountLink'));
    if (!(await link.count())) return { stop: 'blocked', reason: 'Workday shows no Create Account option' };
    await link.first().click();
    await page.waitForSelector(A('verifyPassword'), { timeout: 20000 });
  }
  if (!onPortal(page, host)) return { stop: 'blocked', reason: `Account page is not on ${host}` };
  const account = { email, password: newPassword(), host, state: 'creating', createdAt: now() };
  await saveAccount(db, host, account);
  await page.fill(A('email'), account.email);
  await page.fill(A('password'), account.password);
  await page.fill(A('verifyPassword'), account.password);
  const consent = page.locator(A('createAccountCheckbox'));
  if (await consent.count()) await consent.check();
  const createdAt = Date.now();
  await clickPrimary(page, 'createAccountSubmitButton');
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1500);
    if (/already (exists|in use|registered)|account with this email/i.test(await page.locator('body').innerText().catch(() => ''))) {
      await saveAccount(db, host, { ...account, state: 'exists-unknown-password' });
      return { stop: 'blocked', reason: `A Workday account for ${email} already exists at ${host}; its password is not known to CareerPilot` };
    }
  }
  const r = await formGone(page, 'createAccountSubmitButton');
  if (r?.verify) return verifyByEmail(page, { db, gmail, host, account: { ...account, createdAt: new Date(createdAt).toISOString() }, log });
  if (!r) await saveAccount(db, host, { ...account, state: 'active' });
  return r;
}

// ---- Form widgets. Fields are found by Workday's own formField-<name> groups, never by position.

// Workday's sticky footer (Back / Save and Continue) covers the bottom of the window: bring a control to
// the middle of the screen before clicking it, or the click lands on the footer.
async function centerClick(locator, options = {}) {
  await locator.evaluate((n) => n.scrollIntoView({ block: 'center', inline: 'nearest' })).catch(() => {});
  await locator.click(options);
}

// Closes a search box's popup: an open one sits over the next field and swallows its click. Escape does
// not always close it, so like a person: click outside it, on the step's heading.
async function closePopup(page) {
  const open = page.locator(`${A('activeListContainer')}:visible`);
  for (let i = 0; i < 3 && (await open.count()); i++) {
    if (i === 0) await page.keyboard.press('Escape');
    else await page.locator('main h2').first().click({ position: { x: 2, y: 2 } }).catch(() => {});
    await page.waitForTimeout(400);
  }
}

const F = (name) => `[data-automation-id="formField-${name}"]`;

// The question's text box: its textarea when it has one (a block can also hold other inputs, and
// Playwright's first() means first in the page, not first in the selector).
async function setText(page, field, value, scope = page) {
  const group = scope.locator(F(field)).first();
  const area = group.locator('textarea');
  const isArea = (await area.count()) > 0;
  const input = isArea ? area.first() : group.locator('input:not([type="checkbox"]):not([type="radio"]):not([type="file"])').first();
  if (value == null || value === '' || !(await input.count())) return false;
  if (isArea || /^\d+([.,]\d+)?$/.test(String(value))) {
    // Workday's text areas and number boxes only register real typing: fill() changes the box but not the
    // form's state (PwC's "current annual fixed compensation" stayed "required" after fill('0')).
    await input.click();
    await input.press('Control+A');
    await input.press('Delete');
    await input.pressSequentially(String(value), { delay: 5 });
    await input.press('Tab');
  } else if ((await input.inputValue()) !== String(value)) {
    await input.fill(String(value));
    await input.press('Tab');
  }
  return true;
}

// `wants`: one pattern, or patterns in order of preference. The first pattern with any matching option
// wins, so a precise answer is never displaced by a looser one that happens to come earlier in the list.
// Matched without accents: Workday lists Indian states as "Karnātaka", "Bihār".
const plain = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\u2018\u2019]/g, "'");
export function best(texts, wants) {
  for (const re of [wants].flat()) {
    const i = texts.findIndex((t) => re.test(plain(t)));
    if (i >= 0) return i;
  }
  return -1;
}

// Single-choice dropdown: opens it and picks the best option. It always reports what was on offer, so
// the trail shows the choice in context and a stop reason can say what the form wanted.
async function choose(page, field, wants, scope = page) {
  const button = scope.locator(`${F(field)} button[aria-haspopup="listbox"]`).first();
  if (!(await button.count())) return { missing: true };
  const current = (await button.innerText()).trim();
  if (best([current], wants) === 0) return { chosen: current };
  await centerClick(button);
  // Only the list this button opened: closed lists stay in the page with their old options.
  const list = await button.getAttribute('aria-controls');
  const options = page.locator(list ? `[id="${list}"] [role="option"]` : '[role="listbox"]:visible [role="option"]');
  // Options load after the list opens, sometimes a few at a time (Visa's degrees): wait until the count is
  // past the "Select One" placeholder and has stopped growing.
  for (let i = 0, last = -1; i < 25; i++) {
    const n = await options.count();
    if (n >= 2 && n === last) break;
    last = n;
    await page.waitForTimeout(400);
  }
  const texts = (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const i = best(texts, wants);
  debug('choose', field, { current, offered: texts.length, pick: texts[i] ?? null });
  // The field can show the choice with different spacing ("Second-Degree(ISCED 7" for "Second-Degree (ISCED 7").
  const same = (a, b) => String(a).replace(/\s+/g, '') === String(b).replace(/\s+/g, '');
  if (i < 0 || same(texts[i], current)) { await page.keyboard.press('Escape'); return i < 0 ? { options: texts } : { chosen: current, options: texts }; }
  await options.nth(i).scrollIntoViewIfNeeded();
  await options.nth(i).click();
  await page.waitForTimeout(400);
  const now = (await button.innerText()).trim();
  debug('choose', field, 'now shows', now);
  return same(now, texts[i]) ? { chosen: texts[i], options: texts } : { options: texts, note: `clicked "${texts[i]}" but the field shows "${now}"` };
}

// Removes a selected value from a search box (its chip's delete control).
async function unselect(group) {
  const chip = group.locator(A('selectedItem')).first();
  if (!(await chip.count())) return;
  const del = chip.locator(`${A('DELETE_charm')}, [role="button"], button`).first();
  if (await del.count()) await del.click();
  else { await chip.click(); await chip.press('Delete'); }
  await group.page().waitForTimeout(500);
}

// Search box ("prompt"): types `search`, presses Enter (Workday's search key), then picks the best
// option. When the search finds a single result Workday selects it by itself on Enter: that value is
// kept only if it is acceptable, otherwise removed again.
async function pick(page, field, search, wants, scope = page) {
  const group = scope.locator(F(field)).first();
  if (!(await group.count())) return { missing: true };
  const chips = async () => (await group.locator(A('selectedItem')).allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  let selected = await chips();
  if (best(selected, wants) >= 0) return { chosen: selected[best(selected, wants)] };
  if (selected.length) { debug('pick', field, 'removing', selected); await unselect(group); }
  await closePopup(page);
  const box = group.locator('input').first();
  await centerClick(box);
  await box.fill(search);
  await box.press('Enter');
  // Results live in the open popup; selected values elsewhere carry the same promptOption tag.
  const options = page.locator(`${A('activeListContainer')} ${A('promptOption')}`);
  await options.first().waitFor({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800);
  selected = await chips();
  if (selected.length) { // auto-selected on Enter
    debug('pick', field, `"${search}" auto-selected`, selected);
    const kept = best(selected, wants) >= 0;
    if (!kept) await unselect(group);
    // The results list can stay open either way, and an open list swallows the next click on the page.
    await closePopup(page);
    return kept ? { chosen: selected[best(selected, wants)] } : { options: selected };
  }
  const texts = (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const i = best(texts, wants);
  debug('pick', field, `"${search}"`, { offered: texts.slice(0, 8), pick: texts[i] ?? null });
  if (i < 0) { await closePopup(page); return { options: texts.slice(0, 15) }; }
  await options.nth(i).click();
  await page.waitForTimeout(800);
  // A category opens its own list instead of being chosen (HPE: "HPE Career site" holds only "HPE Careers
  // webpage"): choose inside it, the entry that matches or the only one there.
  if (!(await chips()).length) {
    const inner = (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    const k = inner.length && !inner.includes(texts[i]) ? (best(inner, wants) >= 0 ? best(inner, wants) : inner.length === 1 ? 0 : -1) : -1;
    debug('pick', field, `"${texts[i]}" opened`, inner.slice(0, 8), 'pick', inner[k] ?? null);
    if (k >= 0) { await options.nth(k).click(); await page.waitForTimeout(800); }
  }
  await closePopup(page);
  const now = await chips();
  return now.length ? { chosen: now[0] } : { options: texts.slice(0, 15), note: `"${texts[i]}" did not stick` };
}

// "How did you hear about us": the employer's own site is where CareerPilot finds postings ("Marvell
// Website", "Company Website"). Job-board names that merely contain "career" (Career Builder) never match.
export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A careers portal that is someone else's is not the employer's site (AllianceBernstein: "School's Career
// Portal (i.e. Handshake/Symplicity)").
const NOT_OWN_SITE = /\b(school|university|college|campus|handshake|symplicity|job ?boards?|agency|recruiters?)\b/i;
const sourceWants = (employerNames) => [
  new RegExp(`^(${employerNames.filter(Boolean).map(escapeRe).join('|')})\\b.*\\b(web ?site|careers?( site| page)?|job board)$`, 'i'),
  /^(the )?(company|corporate|employer|organi[sz]ation)('s)?( careers?)? (web)?site$/i,
  /\b(company|corporate|employer|official)\b[^,]*\b(web)?site\b/i,
  { test: (t) => /\bcareers? (web ?site|site|page|portal)\b/i.test(t) && !NOT_OWN_SITE.test(t) }];
// Only when the list has no site of the employer's own (Circles: "Websites"; NatWest offers only search
// engines and job boards): the nearest true answer.
const SOURCE_FALLBACK = [/^(company )?(careers? )?web ?sites?$/i, /^other$/i];
// The employer's names as its options may say them: the company, the portal's tenant, and the Workday
// site's name ("ag" tenant, "airbus" site) unless that is a generic word.
const GENERIC_SITES = /^(external|careers?|jobs?|careersite|search|en|apply|global|ext|candidate|recruiting|opportunities|.*_site|.*careers?_site)$/i;
function employerNames(job, host) {
  const site = new URL(job.url).pathname.split('/').filter(Boolean).find((s) => !/^[a-z]{2}-[A-Z]{2}$/.test(s));
  return [job.company, host.split('.')[0], site && /^[a-z]+$/i.test(site) && !GENERIC_SITES.test(site) ? site : null].filter(Boolean);
}

// A required choice that could not be made: what the form offered instead (for the stop reason).
// A field that is not on this employer's form at all ({missing}) is not a problem.
const unmet = (label, r) => (r.chosen || r.missing ? null
  : `${label} (offered: ${(r.options ?? []).filter((o) => !/^select one$/i.test(o)).slice(0, 12).join(', ')})`);

// Workday renders a step's sections one after another (later ones show grey placeholders first) and some
// only when scrolled to: scroll through, then wait until the number of fields stops changing.
async function settle(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 40 && stable < 4; i++) {
    await page.waitForTimeout(500);
    const n = await page.locator('[data-automation-id^="formField-"]').count();
    stable = n === last && n > 0 ? stable + 1 : 0;
    last = n;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

// Labels of required questions on this step that are still unanswered.
// ($$eval is Playwright's in-page query: it runs this function in the page, it is not a string eval.)
async function emptyRequired(page) {
  return page.$$eval('[data-automation-id^="formField-"]', (groups) => groups
    .filter((g) => g.offsetParent !== null)
    .map((g) => {
      const label = (g.querySelector('label, legend')?.innerText ?? '').replace(/\s+/g, ' ').trim();
      if (!/\*$/.test(label)) return null;
      const radios = [...g.querySelectorAll('input[type=radio]')];
      const checks = [...g.querySelectorAll('input[type=checkbox]')];
      const button = g.querySelector('button[aria-haspopup="listbox"]');
      const text = g.querySelector('textarea') ?? g.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=file])');
      // A file box never shows a value; an upload shows as a file card with the file's name.
      const filled = g.querySelector('input[type=file]') ? /\.(pdf|docx?|rtf|odt|txt)\b/i.test(document.querySelector('main')?.innerText ?? '')
        : radios.length ? radios.some((r) => r.checked)
        : g.querySelector('[data-automation-id="multiSelectContainer"]') ? g.querySelectorAll('[data-automation-id="selectedItem"]').length > 0
        : button ? !/^select one$/i.test(button.innerText.trim())
        : checks.length ? checks.some((c) => c.checked)
        : text ? text.value.trim() !== '' : true;
      return filled ? null : label.replace(/\*$/, '');
    }).filter(Boolean));
}

// Workday's transient "Something went wrong. Please refresh the page" screen: refresh, as it asks, up to
// twice. Returns false when the error stays.
async function recover(page) {
  for (let i = 0; i < 3; i++) {
    const body = await page.locator('body').innerText().catch(() => '');
    if (!/something went wrong|please refresh the page/i.test(body)) return true;
    if (i === 2) return false;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(A('progressBar'), { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
  return false;
}

// Save and Continue; resolves to null once the next step shows, or to the reasons it did not advance.
async function saveAndContinue(page) {
  const before = await activeStep(page);
  await page.locator(`${A('pageFooterNextButton')}, ${A('bottom-navigation-next-button')}`).first().click({ force: true });
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    if ((await activeStep(page)) !== before) return null;
    const errors = await pageErrors(page);
    if (errors.length) return errors;
  }
  return ['the page did not advance'];
}

// ---- Steps

const digits = (phone) => String(phone ?? '').replace(/^\s*\+91[\s-]*/, '').replace(/\D/g, '');

async function myInformation(page, ctx) {
  const { profile, answers, job, host } = ctx;
  const [city, state] = String(profile.location ?? '').split(',').map((s) => s.trim());
  const names = employerNames(job, host);
  // The employer's own site first. A job found through aggregated job listings (source 'aggregator') may
  // say "other job board" where the employer's list has no site option; one CareerPilot found on the
  // employer's own board never claims a job board.
  const viaListings = job.source === 'aggregator';
  const wants = [...sourceWants(names), ...(viaListings ? [/^other job ?board$/i, /^(online )?job ?board$/i] : [])];
  let source = await choose(page, 'source', [...wants, ...SOURCE_FALLBACK]); // a list shows everything at once
  if (source.missing) { // a search box instead of a dropdown: its top level first (HPE lists "HPE Career site"
    // only there), then the employer's own name, which finds its site
    for (const q of ['', ...names, 'career', 'website', ...(viaListings ? ['other job board', 'job board'] : [])]) {
      source = await pick(page, 'source', q, wants);
      if (source.chosen || source.missing) break;
    }
    for (const q of ['', 'website', 'other']) {
      if (source.chosen || source.missing) break;
      source = await pick(page, 'source', q, SOURCE_FALLBACK);
    }
  }
  const filled = { source, country: await choose(page, 'country', /^india$/i) };
  await settle(page); // the address block re-renders for the chosen country
  filled.givenName = await setText(page, 'legalName--firstName', answers.legal_given_name);
  filled.familyName = await setText(page, 'legalName--lastName', answers.legal_family_name);
  filled.city = await setText(page, 'city', city);
  if (state) filled.state = await choose(page, 'countryRegion', new RegExp(`^${escapeRe(state)}$`, 'i'));
  filled.phoneType = await choose(page, 'phoneType', /mobile|cell/i);
  filled.phoneCode = await pick(page, 'countryPhoneCode', 'India', /^india\b/i);
  filled.phone = await setText(page, 'phoneNumber', digits(profile.phone));
  // The whole street address: in its two lines, or in the only one a form has (BMS, which then asks to
  // confirm the address matches the candidate's Aadhaar card).
  if (answers.address_line1 && answers.address_line2 && (await page.locator(F('addressLine1')).count())) {
    filled.street = (await page.locator(F('addressLine2')).count())
      ? await setText(page, 'addressLine2', answers.address_line2)
      : await setText(page, 'addressLine1', `${answers.address_line1}, ${answers.address_line2}`);
  }
  const problems = [unmet('How did you hear about us', filled.source), unmet('Country', filled.country),
    unmet('State', filled.state ?? { missing: true }), unmet('Phone device type', filled.phoneType), unmet('Country phone code', filled.phoneCode)].filter(Boolean);
  if (problems.length) return { filled, stop: 'blocked', reason: `No matching option for: ${problems.join('; ')}` };
  const rest = await answerRemaining(page, ctx); // this employer's own questions on the same page
  return rest.unknown.length ? { filled: { ...filled, extra: rest.filled }, stop: 'blocked', reason: `Needs your answer: ${rest.unknown.map((u) => `"${u}"`).join('; ')}` }
    : { filled: { ...filled, extra: rest.filled } };
}

// Required questions still empty after a step's own filling: answered from the profile when a rule
// knows them, otherwise returned as unknown.
async function answerRemaining(page, ctx) {
  const empty = new Set((await emptyRequired(page)).map((l) => l.trim()));
  const filled = [];
  const unknown = [];
  for (const q of await readQuestions(page)) {
    if (!empty.has(q.label.trim())) continue;
    const a = answerFor(q, ctx);
    const r = a === undefined ? {} : await applyAnswer(page, q, a);
    if (r.chosen) filled.push({ question: q.label.slice(0, 120), answer: r.chosen });
    else unknown.push(q.label.slice(0, 200));
  }
  return { filled, unknown };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// "May 2026 - Jun 2026" -> [{month: 5, year: 2026}, {month: 6, year: 2026}]; an end of "Present" is null.
export function dateRange(text) {
  const [a, b] = String(text ?? '').split(/\s+[-–]\s+/);
  const one = (s) => { const m = /\b([a-z]{3})[a-z]*\.?\s+(\d{4})\b/i.exec(s ?? ''); return m && MONTHS.includes(m[1].toLowerCase()) ? { month: MONTHS.indexOf(m[1].toLowerCase()) + 1, year: Number(m[2]) } : null; };
  return [one(a), /present|current|now/i.test(b ?? '') ? null : one(b)];
}
// "ComedKares, Bengaluru" -> ['ComedKares', 'Bengaluru']
const splitPlace = (s) => { const t = String(s ?? ''); const i = t.lastIndexOf(','); return i > 0 ? [t.slice(0, i).trim(), t.slice(i + 1).trim()] : [t.trim(), '']; };

// Degree names as Workday lists them, most specific first.
const DEGREES = [
  // Most specific first; then the level's bucket naming the degree ("Master's or Equivalent (ISCED 7: MA,
  // MSc, …)"); then the plain level some portals list ("Masters (+2 or +3 yrs)", "Master's (M.A., M.S.,
  // M.B.A.)"). Never another degree at that level: "Master of Business Administration", "Bachelor of Arts".
  [/^m\.?\s?sc\b|master of science/i, [/^master of science \(m\.?sc\)$/i, /^masters?('s)? of science\b/i, /^m\.?\s?sc\.?$/i, /^m\.?s\.?$/i,
    /\bISCED 7\b.*\bM\.?Sc\b/i, /^masters?('s)?( degree)?( or equivalent( degree)?)?(\s*\(.*\))?$/i, /^masters?('s)?( degree)?\s*\/\s*graduate( degree)?\b/i, /^masters?('s)? degree\s*\/\s*int'?l\.? equiv/i]],
  [/^b\.?\s?sc\b|bachelor of science/i, [/^bachelor of science \(b\.?sc\)$/i, /^bachelors?('s)? of science\b/i, /^b\.?\s?sc\.?$/i, /^b\.?s\.?$/i,
    /\bISCED 6\b.*\bB\.?Sc\b/i, /^bachelors?('s)?( degree)?( or equivalent( degree)?)?(\s*\(.*\))?$/i, /^bachelors?('s)?( degree)?\s*\/\s*undergraduate( degree)?\b/i, /^bachelors?('s)? degree\s*\/\s*int'?l\.? equiv/i]],
  [/^m\.?\s?tech\b|master of technology/i, [/^master of technology\b/i, /^m\.?\s?tech$/i]],
  [/^b\.?\s?tech\b|bachelor of technology/i, [/^bachelor of technology\b/i, /^b\.?\s?tech$/i]],
  [/^b\.?\s?e\b|bachelor of engineering/i, [/^bachelor of engineering\b/i]],
  [/^mba\b|master of business administration/i, [/^master of business administration\b/i, /^mba$/i]],
  [/^mca\b|master of computer application/i, [/^master of computer application/i, /^mca$/i]],
  [/^bca\b|bachelor of computer application/i, [/^bachelor of computer application/i, /^bca$/i]],
  [/^b\.?\s?com\b|bachelor of commerce/i, [/^bachelor of commerce\b/i]],
  [/^m\.?\s?com\b|master of commerce/i, [/^master of commerce\b/i]],
];
export const degreeWants = (degree) => DEGREES.find(([re]) => re.test(degree))?.[1] ?? [new RegExp(`^${escapeRe(degree)}$`, 'i')];
export const studyField = (degree) => (/\bin\s+(.+)$/i.exec(degree)?.[1] ?? '').trim();

// A Workday field-of-study option is acceptable only when all its words appear in the real field name:
// "Data Analytics" or "Analytics" for "Big Data Analytics", "Statistics" (or "Statistics, General") for
// "Statistics & Economics", never "Data Science". Searches go from the full name to its tail words.
const words = (s) => String(s).toLowerCase().split(/[^a-z]+/).filter((w) => w && w !== 'and' && w !== 'general');
export function fieldWants(field) {
  const have = new Set(words(field));
  return { test: (option) => { const w = words(option); return w.length > 0 && w.every((x) => have.has(x)); } };
}
const fieldSearches = (field) => { const w = String(field).split(/\s*(?:&|,|\band\b)\s*|\s+/).filter(Boolean); return [...new Set([field, ...w.map((_, i) => w.slice(i).join(' ')), ...w])].filter((s) => s.length > 2); };

// Entry panels of a repeatable section ("Education-2-panel"). Workday re-sorts saved entries, so a panel
// is matched to a profile entry by what it holds (`same`), then an empty one (`empty`) is reused, and
// only then is a new one added.
const groupLabelled = (label) => `[role="group"][aria-labelledby="${label}"], [role="group"][aria-label="${label}"]`;
// A repeatable section's name as this form spells it: the first of `names` the page has, also when its
// heading says "(Optional)" (Dentsu: "Work-History-(Optional)-section"); names[0] when none shows.
async function sectionName(page, names) {
  for (const name of names) {
    for (const s of [name, `${name}-(Optional)`]) if (await page.locator(groupLabelled(`${s}-section`)).count()) return s;
  }
  return names[0];
}
async function entryPanel(page, section, used, same, empty) {
  const all = [];
  for (let n = 1; n <= 12; n++) {
    const p = page.locator(groupLabelled(`${section}-${n}-panel`));
    if (!(await p.count())) break;
    all.push({ n, panel: p.first() });
  }
  const free = all.filter(({ n }) => !used.has(n));
  for (const test of [same, empty]) {
    for (const { n, panel } of free) if (await test(panel)) { used.add(n); return panel; }
  }
  const add = page.locator(groupLabelled(`${section}-section`)).locator(A('add-button')).first();
  if (!(await add.count())) return null;
  await centerClick(add);
  const panel = page.locator(groupLabelled(`${section}-${all.length + 1}-panel`));
  await panel.first().waitFor({ timeout: 10000 }).catch(() => {});
  if (!(await panel.count())) return null;
  used.add(all.length + 1);
  return panel.first();
}
const inputValue = async (panel, field) => (await panel.locator(`${F(field)} input`).first().inputValue().catch(() => '')).trim();
const buttonText = async (panel, field) => (await panel.locator(`${F(field)} button[aria-haspopup="listbox"]`).first().innerText().catch(() => '')).trim();

// Workday's MM/YYYY or MM/DD/YYYY box: the inputs are hidden behind the "MM" / "DD" / "YYYY" text, which
// is what takes the click; typing then moves from part to part by itself. Returns whether the box now
// shows the date. d: {month, year, day?}; a box that asks for a day needs d.day.
async function setDate(page, scope, field, d) {
  const group = scope.locator(F(field)).first();
  if (!d || !(await group.count())) return false;
  const parts = [];
  for (const p of ['Month', 'Day', 'Year']) if (await group.locator(A(`dateSection${p}-input`)).count()) parts.push(p);
  if (!parts.length || (parts.includes('Day') && !d.day) || (parts.includes('Month') && !d.month)) return false;
  const want = { Month: String(d.month).padStart(2, '0'), Day: String(d.day ?? '').padStart(2, '0'), Year: String(d.year) };
  const ok = async () => {
    for (const p of parts) {
      const shown = (await group.locator(A(`dateSection${p}-display`)).innerText().catch(() => '')).trim();
      if (p === 'Year' ? shown !== want.Year : Number(shown) !== Number(want[p])) return false;
    }
    return true;
  };
  if (await ok()) return true;
  try {
    return await typeDate(page, group, parts, want, ok);
  } catch {
    return false;
  }
}
async function typeDate(page, group, parts, want, ok) {
  await centerClick(group.locator(A(`dateSection${parts[0]}-display`)).first(), { timeout: 8000 });
  await page.keyboard.type(parts.map((p) => want[p]).join(''));
  await page.keyboard.press('Tab');
  if (await ok()) return true;
  // No auto-advance on this tenant: type each part into its own box.
  for (const p of parts) {
    await centerClick(group.locator(A(`dateSection${p}-display`)).first(), { timeout: 8000 });
    await page.keyboard.type(want[p]);
  }
  await page.keyboard.press('Tab');
  return ok();
}

// The institution exactly as the profile names it, otherwise Workday's own "School not in list": a
// similarly named school (St. Joseph's College for St. Joseph's University) would be a different claim.
async function chooseSchool(page, scope, institution) {
  const name = splitPlace(institution)[0];
  // A plain text box (Synechron's schoolName): the institution's exact name is the answer.
  for (const field of ['schoolName', 'school']) {
    const group = scope.locator(F(field)).first();
    if ((await group.count()) && !(await group.locator(A('multiSelectContainer')).count())) {
      return (await setText(page, field, name, scope)) ? { chosen: name } : { missing: true };
    }
  }
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\bst\b/g, 'saint').replace(/\s+/g, ' ').trim();
  const same = { test: (option) => norm(option.split(',')[0].replace(/\(.*?\)/g, '')) === norm(name) };
  const exact = await pick(page, 'school', name, same, scope);
  if (exact.chosen) return exact;
  let notListed = {};
  // Workday's own entry for a school missing from its list, as tenants name it (PwC: "School Not Listed";
  // Airbus: "Other / Autre / Sonstige / Otras"). Never a similarly named school.
  for (const [q, want] of [['School not in list', /not (in|on) (the )?list|not listed/i], ['School Not Listed', /not listed/i], ['Other', /^others?\b/i]]) { // DBS: "Others"
    notListed = await pick(page, 'school', q, want, scope);
    if (notListed.chosen) return { ...notListed, note: `"${name}" is not in Workday's list` };
  }
  return { options: notListed.options ?? exact.options };
}

// Skills for a form that requires them (Fractal): the profile's own, those the job description names first,
// each added only where Workday lists it under the same name. Up to `max` chips, from at most 16 searches.
async function addSkills(page, profile, description, max = 8) {
  const group = page.locator(F('skills')).first();
  const chips = async () => (await group.locator(A('selectedItem')).allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const all = [...new Set(Object.values(profile.skills ?? {}).flat().map((s) => String(s).replace(/\s*\(.*\)\s*$/, '').trim()).filter(Boolean))];
  const named = (s) => new RegExp(`(^|[^a-z0-9])${escapeRe(s)}([^a-z0-9]|$)`, 'i').test(description ?? '');
  const skills = [...all.filter(named), ...all.filter((s) => !named(s))].slice(0, 16);
  // With a chip in it the search input can stop taking clicks (DBS): click the field, then type.
  const field = group.locator(A('multiSelectContainer')).first();
  const options = page.locator(`${A('activeListContainer')} ${A('promptOption')}`);
  for (const skill of skills) {
    const have = await chips();
    if (have.length >= max) break;
    // The same skill, also with Workday's qualifier: "Python (Programming Language)" for "Python".
    const same = (t) => [t, t.replace(/\s*\([^)]*\)\s*$/, '')].some((x) => x.trim().toLowerCase() === skill.toLowerCase());
    if (have.some(same)) continue;
    await closePopup(page);
    try { await centerClick(field, { timeout: 5000 }); } catch { break; } // keep the skills added so far
    await page.keyboard.press('Control+A');
    await page.keyboard.type(skill);
    await page.keyboard.press('Enter');
    await options.first().waitFor({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(600);
    const now = await chips();
    if (now.length > have.length) { // selected by itself on Enter: kept only when it is this very skill
      if (!same(now.at(-1))) await group.locator(A('selectedItem')).nth(now.length - 1).locator(`${A('DELETE_charm')}, [role="button"], button`).first().click().catch(() => {});
      continue;
    }
    const i = (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).findIndex(same);
    if (i >= 0) { await options.nth(i).click(); await page.waitForTimeout(500); }
  }
  await closePopup(page);
  return chips();
}

async function myExperience(page, { profile, answers, job, resumePath }) {
  const filled = { experience: [], education: [] };
  const problems = [];
  const usedJobs = new Set();
  const expSection = await sectionName(page, ['Professional-Experience', 'Work-Experience', 'Work-History']); // Dentsu: Work History
  for (const e of profile.experience ?? []) {
    const panel = await entryPanel(page, expSection, usedJobs,
      async (p) => (await inputValue(p, 'jobTitle')).toLowerCase() === e.title.toLowerCase(),
      async (p) => (await inputValue(p, 'jobTitle')) === '');
    if (!panel) break; // this employer's form has no experience section
    const [company, location] = splitPlace(e.company);
    const [from, to] = dateRange(e.dates);
    if (!from) { problems.push(`dates of "${e.title}" (${e.dates})`); continue; }
    await setText(page, 'jobTitle', e.title, panel);
    await setText(page, 'companyName', company, panel);
    await setText(page, 'location', location, panel);
    if (!(await setDate(page, panel, 'startDate', from))) problems.push(`start date of "${e.title}"`);
    if (to) { if (!(await setDate(page, panel, 'endDate', to))) problems.push(`end date of "${e.title}"`); }
    else await panel.locator(`${F('currentlyWorkHere')} input[type=checkbox]`).check().catch(() => {});
    await setText(page, 'roleDescription', (e.points ?? []).join('\n'), panel);
    filled.experience.push(`${e.title} at ${company}`);
  }
  const usedSchools = new Set();
  const eduSection = await sectionName(page, ['Education']);
  for (const ed of profile.education ?? []) {
    const panel = await entryPanel(page, eduSection, usedSchools,
      async (p) => best([await buttonText(p, 'degree')], degreeWants(ed.degree)) === 0,
      async (p) => /^(select one)?$/i.test(await buttonText(p, 'degree')));
    if (!panel) break; // no education section on this employer's form; if one were required, Workday's own check says so on Save
    const school = await chooseSchool(page, panel, ed.institution);
    const degree = await choose(page, 'degree', degreeWants(ed.degree), panel);
    const field = studyField(ed.degree);
    let study = { missing: true };
    if (field && (await panel.locator(F('fieldOfStudy')).count())) {
      // The real field first, searched from its full name to its tail words; only then the substitutes
      // the candidate approved for a field Workday does not list (answers.field_of_study_choices), in order.
      const approved = (answers.field_of_study_choices ?? {})[field] ?? [];
      const tries = [...fieldSearches(field).map((q) => [q, fieldWants(field)]), ...approved.map((name) => [name, new RegExp(`^${escapeRe(name)}$`, 'i')])];
      for (const [q, wants] of tries) { study = await pick(page, 'fieldOfStudy', q, wants, panel); if (study.chosen) break; }
      // An optional field left empty is a true answer (GE Vernova); a near-match never is.
      if (!study.chosen && !/\*\s*$/.test(await panel.locator(`${F('fieldOfStudy')} label`).first().innerText().catch(() => ''))) study = { missing: true };
    }
    const gpa = /(\d+(?:\.\d+)?)/.exec(ed.grade ?? '')?.[1];
    if (gpa) await setText(page, 'gradeAverage', gpa, panel);
    const [from, to] = dateRange(ed.dates);
    if (from) await setDate(page, panel, 'firstYearAttended', { year: from.year });
    if (to) await setDate(page, panel, 'lastYearAttended', { year: to.year });
    for (const [label, r] of [['School', school], ['Degree', degree], ['Field of study', study]]) {
      const u = unmet(`${label} for ${ed.degree}`, r);
      if (u) problems.push(u);
    }
    filled.education.push({ degree: ed.degree, school: school.chosen, as: degree.chosen, field: study.chosen });
  }
  const skills = page.locator(F('skills')).first();
  if ((await skills.count()) && /\*\s*$/.test(await skills.locator('label').first().innerText().catch(() => ''))) {
    filled.skills = await addSkills(page, profile, job?.description);
    if (!filled.skills.length) problems.push("Skills (none of the profile's skills is in Workday's list)");
  }
  const upload = page.locator(`input${A('file-upload-input-ref')}`).first();
  if (resumePath && (await upload.count())) {
    const file = resumePath.split(/[\\/]/).pop();
    const shown = await page.getByText(file, { exact: true }).count();
    debug('resume', { file, alreadyShown: shown });
    if (!shown) {
      await upload.setInputFiles(resumePath);
      // The file card shows at once; the upload is done when Workday announces it.
      const done = await page.getByText(/successfully uploaded/i).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
      debug('resume upload confirmed', done);
      if (!done) problems.push('resume upload did not finish');
    }
    filled.resume = file;
  }
  return problems.length ? { filled, stop: 'blocked', reason: `No verified match for: ${problems.join('; ')}` } : { filled };
}

// ---- Employer questions. Each is a formField-<id> block with the question as its label or legend and
// one control. Answers come only from the profile: rules for the questions every employer asks, the
// candidate's own answers to earlier unknown questions (answers.custom), or nothing, which blocks.

const isoDate = (v) => { const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(String(v ?? '')); return m ? { year: Number(m[1]), month: Number(m[2]), day: m[3] ? Number(m[3]) : null } : null; };
const yes = (v) => (v == null ? undefined : { yes: v === true || /^(yes|true)$/i.test(String(v)) });
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Whether the candidate's own experience includes this employer: the profile lists their full history.
const workedAt = (profile, company) => (profile.experience ?? []).some((e) => norm(splitPlace(e.company)[0]).includes(norm(company)) && norm(company).length > 2);
const namesPastEmployer = (profile, label) => (profile.experience ?? []).some((e) => {
  const name = norm(splitPlace(e.company)[0]);
  return name.length > 2 && ` ${norm(label)} `.includes(` ${name} `);
});
const lpa = (inr) => Math.round((inr / 1e5) * 100) / 100;

// A statement the candidate signs by typing their name. Their standing permission (answers.may_e_sign)
// covers only certifying that the answers are true and acknowledging that the employer may check them:
// a statement with any other sentence in it (a promise, a waiver, a consent) waits for the candidate to
// approve it (answers.custom), and a tick box or yes/no is never signed this way.
const CERTIFIES = [
  /^(i (hereby )?)?(certify|attest|declare|confirm|affirm|acknowledge)( and agree)? that (all )?(of )?(the |my )?(foregoing |above |preceding )?(information|answers|statements|responses)\b[^?]*?\b(is|are) (true|correct|accurate|complete)(,? (and )?(true|correct|accurate|complete))*( to the best of my knowledge( and belief)?)?$/i,
  /^i understand that (?!.*\b(i|me|my)\b)[^?]{1,60}? reserves the right to (inquire|verify|investigate)\b[^?]*$/i,
];
// What follows if the answers are not true (answers.may_certify_accuracy, given by the candidate on
// 2026-10-18): ineligibility, a withdrawn offer, dismissal. Never a waiver, release or further consent.
const CONSEQUENCE = /^(?!.*\b(arbitrat|waive|release|indemnif|consent to|authori[sz]e)\w*)(i (hereby )?)?(acknowledge|understand)( and agree)? that\b.*\b(false|untrue|inaccura\w*|incomplete\w*|misleading|misrepresent\w*|omissions?|falsif\w*)\b.*\b(ineligib\w*|disqualif\w*|reject\w*|terminat\w*|dismiss\w*|rescin\w*|rescission|separation|disciplinary|eliminat\w*|revocation|removal)\b/i;
// Whether every sentence of a statement is one the candidate has allowed CareerPilot to affirm.
function onlySays(label, answers) {
  const allowed = [...CERTIFIES, ...(answers.may_certify_accuracy ? [CONSEQUENCE] : [])];
  const sentences = label
    .replace(/\b(attestation|acknowledge?ment)( and (attestation|acknowledge?ment))?( statement)?\b|\bby signing (below|this)\b,?( i hereby)?|\bsignature( and date)?\b/gi, '.')
    .split(/[.;:]/).map((s) => s.trim()).filter(Boolean);
  return sentences.length > 0 && sentences.every((s) => allowed.some((re) => re.test(s)));
}
function signs(c) {
  if (!c.answers.may_e_sign || (c.kind !== 'text' && c.kind !== 'textarea') || !onlySays(c.label, c.answers)) return undefined;
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  return { text: /\bdate\b/i.test(c.label) ? `${c.profile.name}, ${date}` : c.profile.name };
}
// The same statements as a tick box or yes/no (Haleon), with the candidate's standing permission.
const affirms = (c) => (c.answers.may_certify_accuracy && ['checkbox', 'dropdown', 'radio'].includes(c.kind) && onlySays(c.label, c.answers) ? { yes: true } : undefined);

// Past ties to this employer. One question can name several ("worked here as an employee or
// contractor"): it is "yes" when any tie it names is, "no" only when every tie it names is known to be
// "no", and unknown otherwise. Employment comes from the profile's full history, the rest from the
// candidate's standing answers.
const RELATIVE = /\b(friends?|relatives?|family members?|related to)\b|\b(personal|family) relationships?\b|relationship with (any|a) (current )?employee|\brelations? working (with|at|for)\b/i;
const PAST_TIE = new RegExp(`${RELATIVE.source}|\\bmade redundant\\b|\\b(employment (was |been )?)?terminated (for misconduct )?by\\b|\\binterviewed\\b|\\binterviews?\\b.{0,15}\\bbefore\\b|\\b(have|did|do) you (ever )?(work|worked|been employed) (for|at|with)\\b|\\b(ever|previously|already) applied\\b|\\bapplied\\b.{0,60}\\bbefore\\b|\\b(have|did|were) you (ever )?(been )?(employed|worked)\\b.{0,40}\\bby\\b|\\b(ever|previously|former|previous)\\b.{0,30}\\bconsultant\\b|\\breceived an offer\\b|\\bindependent contractor\\b|third.party labou?r|\\b(ever|previously|formerly|currently|already)\\b.{0,20}\\b(worked|employed|work|employee)\\b|\\bformer (employee|intern|contractor)\\b|collaborated with|\\b(client|partner|vendor|supplier)\\b.{0,40}\\bcapacity|contractor or consultant|consultant roles?\\b`, 'i');
function pastTies(c) {
  const facts = [
    [RELATIVE, c.answers.relatives_at_employer],
    [/\binterview(ed|s)?\b/i, c.answers.previously_interviewed],
    // No application, no offer: both follow from whether the candidate applied here before.
    [/\bapplied\b|\breceived an offer\b/i, c.appliedHere],
    // This employer, or any company the question names ("Did you work for KPMG?"): the full work history says.
    // (Made redundant or dismissed by the employer is employment there too.)
    [/\b(work|worked|employed|employment|employee|intern|redundant|terminated)\b/i, workedAt(c.profile, c.job.company) || namesPastEmployer(c.profile, c.label)],
    // A contract may not be in the history, even when named in passing ("Employee, Intern or Contractor").
    [/collaborat|\b(client|partner|vendor|supplier|contractor|consultant)s?\b/i, c.answers.prior_relationship_with_employer],
  ].filter(([re]) => re.test(c.label)).map(([, fact]) => yes(fact)?.yes);
  if (facts.includes(true)) return { yes: true };
  return !facts.length || facts.includes(undefined) ? undefined : { yes: false };
}

// Whole years of work in the profile's history: internships are counted in months, so a candidate with
// only internships has 0.
function workYears(profile) {
  const months = (profile.experience ?? []).reduce((sum, e) => {
    const [from, to] = dateRange(e.dates);
    const end = to ?? (() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() + 1 }; })();
    return from ? sum + Math.max(0, (end.year - from.year) * 12 + end.month - from.month + 1) : sum;
  }, 0);
  return Math.floor(months / 12);
}
const longDate = ({ year, month, day }) => new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
// A date typed into a text box, in the format the question names ("in YYYY-MM-DD format"), else fallback(d).
const dateAs = (label, d, fallback) => {
  const p = (n) => String(n).padStart(2, '0');
  if (/yyyy-mm-dd/i.test(label)) return `${d.year}-${p(d.month)}-${p(d.day)}`;
  if (/mm\/dd\/yyyy/i.test(label)) return `${p(d.month)}/${p(d.day)}/${d.year}`;
  if (/dd[/-]mm[/-]yyyy/i.test(label)) return `${p(d.day)}/${p(d.month)}/${d.year}`;
  return fallback(d);
};
// The [low, high] rupees a pay-range option stands for: "INR 6,00,000 - INR10,00,000", "Up to INR 6,00,000",
// "INR 50,00,000 - above", "6-10 LPA". null when it names no amount.
function payRange(text) {
  const t = String(text).toLowerCase().replace(/,/g, '');
  const unit = /lpa|lakh/.test(t) ? 1e5 : 1;
  const n = [...t.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]) * unit);
  if (!n.length) return null;
  if (/\b(up ?to|below|under|less than)\b/.test(t)) return [0, n[0]];
  if (n.length === 1 && /\babove\b|\bmore than\b|\bover\b|\+/.test(t)) return [n[0], Infinity];
  return n.length >= 2 ? [n[0], n[1]] : null;
}
// The days an option like "Immediately", "15 days", "Within 1 month" or "1-2 months" stands for (its upper end).
const optionDays = (text) => {
  if (/immediate|right away|\basap\b/i.test(text)) return 0;
  const spans = [...String(text).matchAll(/(\d+)\s*(day|week|month)/gi)].map(([, n, unit]) => Number(n) * { day: 1, week: 7, month: 30 }[unit.toLowerCase()]);
  return spans.length ? Math.max(...spans) : null;
};

// Agreements that restrict joining a new employer. A question that also asks about a bond or "other
// circumstances" needs the candidate's answer on those too.
function restrictions(c) {
  const facts = [];
  if (/restrictive covenant|non-?compet|non-?solicit|agreement|obligation/i.test(c.label)) facts.push(yes(c.answers.restrictive_covenants)?.yes);
  if (/\bbond\b|commitment|obligation|other circumstances|preclude/i.test(c.label)) facts.push(yes(c.answers.employment_restrictions)?.yes);
  if (facts.includes(true)) return { yes: true };
  return facts.length && !facts.includes(undefined) ? { yes: false } : undefined;
}

// The degree in progress ("MSc"), or null: the profile lists the most recent degree first.
function studying(profile) {
  const [ed] = profile.education ?? [];
  const end = ed && dateRange(ed.dates)[1];
  const now = new Date();
  return end && (end.year > now.getFullYear() || (end.year === now.getFullYear() && end.month > now.getMonth() + 1))
    ? String(ed.degree).split(/\s+in\s+/)[0] : null;
}

// Whether the candidate has a job now: one running to "Present", or current pay above 0. Unknown without
// a current-pay answer.
function employed(c) {
  if ((c.profile.experience ?? []).some((e) => /[-–]\s*(present|current|now)\b/i.test(e.dates ?? ''))) return true;
  return c.answers.current_ctc == null ? undefined : c.answers.current_ctc > 0;
}

// [pattern on the question, answer(ctx)]: the first matching pattern decides; undefined = not known.
const QUESTION_RULES = [
  [/\b(at least|over|above|older than)\b.{0,15}\b18\b|\b18\s*\+?\s*years\b|\b18\+|age of 18|legal age/i, (c) => yes(c.answers.age_18_or_older)],
  // A work or residency permit is for foreign nationals: a citizen of the job's country needs neither.
  [/\b(work|residency|residence) permit\b/i, (c) => (c.inIndia && /^india/i.test(c.answers.citizenship ?? '')
    ? { option: [/not applicable|^n\/?a$/i, /^yes\b/i] } : undefined)],
  [/\bsponsor|\b(require|need) (a )?visa\b/i, (c) => (c.inIndia ? yes(c.answers.needs_visa_sponsorship) : undefined)],
  // Citizenship status for a job in India (Maersk): an Indian citizen.
  [/\bcitizenship status\b/i, (c) => (c.inIndia && /^india/i.test(c.answers.citizenship ?? '')
    ? { text: 'Indian citizen', option: [/\bindian?\b.*\bcitizen|\bcitizen\b.*\bindia/i, /^citizen( of (the |this )?country)?$/i] } : undefined)],
  // A citizen of the job's country: an Indian citizen, for a job in India (AllianceBernstein).
  [/\bcitizen\b.{0,40}\bcountry (where|in which)\b.{0,60}\b(role|job|position)\b/i, (c) => (c.inIndia && /^india/i.test(c.answers.citizenship ?? '') ? { yes: true } : undefined)],
  [/(legal|lawful)\w* (right|authori[sz]\w*|eligib\w*|permi\w*) to work|authori[sz]ed to work|work authori[sz]ation|eligible to work|right to work/i,
    (c) => (c.inIndia ? yes(c.answers.indian_work_authorization) : undefined)],
  [/relocat|\bwilling to work (from|at|in) the (job('s)? )?locations?\b/i, (c) => yes(c.answers.willing_to_relocate)], // US Bank: "from the location(s) posted"
  [/reasonable (adjustment|accommodation)s?|accommodations? (during|in|for) the (recruit|interview|hiring|application)|\b(adjustment|accommodation)s?\b.{0,60}\b(recruit\w*|interview|hiring|application|selection) process/i,
    (c) => yes(c.answers.needs_accommodation)],
  // Government employment is in the full work history like any other (HPE asks about the U.S. one).
  [/government (or public institution )?employment experience|(employed by|worked for) (a |the )?(government|public sector)|\bemployee of a government\b/i,
    (c) => ({ yes: (c.profile.experience ?? []).some((e) => /government|ministry|municipal|public sector|federal/i.test(e.company)) })],
  // Being an official, and being related to one, are separate facts (Northern Trust asks both).
  // "How did you hear about this job?" on other employers' forms (a Workday form's own source field is
  // filled on My Information): the employer's site first, as there.
  [/how did you (hear|learn|find out)|where did you (hear|find|see) (about )?(this|the) (job|role|position|opening)/i, (c) => ({
    option: [...sourceWants([c.job.company].filter(Boolean)), ...(c.job.source === 'aggregator' ? [/^other job ?board$/i, /^(online )?job ?board$/i] : []), ...SOURCE_FALLBACK],
    search: '' })],
  // Referred or recommended by someone at the employer: yes only where the candidate names the referral
  // (answers.referred_at, companies; none on 2026-10-18). A box asking who referred them is theirs.
  [/\b(referred|recommended)\b.{0,30}\b(by|from)\b|\bemployee referral\b|\breferral\?/i, (c) => {
    if (c.kind === 'text' || c.kind === 'textarea' || !Array.isArray(c.answers.referred_at)) return undefined;
    return { yes: c.answers.referred_at.some((n) => norm(n) === norm(c.job.company)) };
  }],
  // Hiring checks and disclosures, from the candidate's answers of 2026-10-18.
  // Related to a "stakeholder" (Barclays: client firms' and suppliers' senior decision-makers, regulators,
  // politically exposed persons): its own question, never the relatives-at-the-employer answer, and first,
  // because its explanation mentions "pre-employment screening" too.
  [/\bstakeholders?\b/i, (c) => yes(c.answers.related_to_stakeholder)],
  // Before the convictions rule: Barclays' "people screening … criminal records …, are you happy to continue?"
  [/background (check|verification)|\bbgv\b|\b(people|pre.?employment) screening\b.{0,300}\b(happy to continue|willing|consent|agree)\b/i,
    (c) => yes(c.answers.willing_background_check)],
  // The candidate's own record (answers of 2026-10-18; Barclays).
  [/\bcriminal (convictions?|records?|offen[cs]es?)\b|\bconvicted\b/i, (c) => yes(c.answers.criminal_record)],
  [/\b(investigat\w*|disciplined|cautioned|sanctioned)\b.{0,40}\bregulat\w*|\bregulat\w*\b.{0,40}\b(investigat\w*|disciplin\w*|caution\w*|sanction\w*)\b/i, (c) => yes(c.answers.regulatory_investigation)],
  // Without that answer, "terminated by NatWest" still follows from never having worked there.
  [/\b(dismissed|terminated|fired|discharged)\b.{0,80}\b(misconduct|disciplin\w*|for cause)\b/i, (c) => yes(c.answers.dismissed_for_misconduct) ?? pastTies(c)],
  [/medical history/i, (c) => yes(c.answers.medical_history_to_declare)],
  [/medical (check|exam\w*|test)/i, (c) => yes(c.answers.willing_medical_check)],
  [/\bcourt cases?\b|\b(ongoing|pending) (legal|court) (cases?|proceedings?)/i, (c) => yes(c.answers.ongoing_court_cases)],
  [/disabilit\w*.{0,40}\b(interfere|affect|prevent|limit)\w*/i, (c) => yes(c.answers.disability_affects_job)], // before self-identification
  [/\b(cet|central european( time)?)\b.{0,20}\b(shift|hours)\b/i, (c) => yes(c.answers.willing_cet_shift)],
  [/\bwilling (and able )?to travel\b|\btravel\b.{0,40}\b(required|requirements|as needed)\b/i, (c) => yes(c.answers.willing_to_travel)],
  [/\bverification of (your )?ident\w*|\bverify (your )?identity\b|\bproof of identity\b/i, (c) => yes(c.answers.can_verify_identity)],
  // The name and address given match the candidate's Aadhaar card (their answer of 2026-10-18; BMS).
  [/\b(name|address)\b.{0,80}\bmatch\w*\b.{0,60}\b(aadhaa?r)\b/i, (c) => yes(c.answers.details_match_aadhaar)],
  // Identity documents the candidate holds (answers of 2026-10-18; Maersk).
  [/\b(valid|have( an?)?) aadhaa?r\b/i, (c) => yes(c.answers.has_aadhaar_card)],
  [/\b(valid|have( an?)?) pan\b|\bpan card\b/i, (c) => yes(c.answers.has_pan_card)],
  // Not to disclose or use others' confidential information (GE Vernova; agreed on 2026-10-18).
  [/\bnot (disclose|use)\b.{0,80}\bconfidential\b|\bconfidential (or|and) proprietary information of others\b/i, (c) => yes(c.answers.will_not_use_others_confidential_info)],
  // Texts about the application itself, not marketing (that rule comes later and stays "no").
  [/\b(sms|text messages?)\b.{0,80}\b(application|candidate|recruit\w*|interview)/i, (c) => yes(c.answers.sms_updates)],
  // No break from career or studies (the candidate's answer): no gaps, the studies filling the time.
  [/\bcareer break\b|\bbreak from (your )?(career|work)\b|\bgaps? in (your )?(employment|career|work history)\b/i, (c) => {
    if (c.answers.career_break !== false) return yes(c.answers.career_break);
    const studies = (c.profile.education ?? []).map((e) => String(e.degree).split(/\s+in\s+/)[0]).reverse();
    return { yes: false, text: studies.length ? `No gaps: I have been studying continuously (${studies.join(', then ')}).` : 'No gaps.' };
  }],
  // The candidate's last role, and no current one (answers of 2026-10-18).
  [/^reasons? for leaving\b|\bwhy (did|are) you (leave|leaving)\b/i, (c) => (c.answers.reason_for_leaving_last_role ? { text: c.answers.reason_for_leaving_last_role } : undefined)],
  [/\b(responsibilities|duties)\b.{0,30}\bcurrent (job|role|position|employment)\b|\bcurrent (job|role|position)\b.{0,20}\b(responsibilities|duties)\b/i, (c) => {
    if (employed(c) !== false) return undefined;
    const degree = studying(c.profile);
    return { text: `Not applicable: I am not currently employed${degree ? ` (${degree} student)` : ''}.` };
  }],
  // Questions for someone in a job (CNX: "notified your current manager", "on a Performance Improvement Plan").
  [/performance improvement plan|\bpip\b|notified (your )?(current )?(manager|supervisor)|\bmanager('s)? (approval|consent|permission)\b|\bin your current (role|position|job)\b/i,
    (c) => (employed(c) === false ? { yes: false } : undefined)],
  [/\blicensed representative\b|\bresponsible officer\b|\bregistered representative\b/i, (c) => yes(c.answers.regulatory_licensed_role)],
  [/government official|public official|politically exposed/i, (c) => yes(/\b(related|relatives?|family|spouse)\b/i.test(c.label)
    ? c.answers.related_to_government_official : c.answers.government_official)],
  // Outside work, financial interests or dealings that would conflict with the job (HPE's policy question);
  // after the government-official questions, which also speak of "a conflict of interest".
  [/conflicts?(\(s\))? of interest/i, (c) => yes(c.answers.conflicts_of_interest)],
  // Outside paid work or money-making activity to keep after joining (Mastercard; none, 2026-10-18).
  [/\boutside (employment|activit\w*|work|business)\b/i, (c) => yes(c.answers.outside_employment_to_continue)],
  [/restrictive covenant|non-?compet(e|ition)|non-?solicit|(agreement|obligation)s?\b.{0,80}\brestricts?\b|\bbond\b.{0,40}\b(employer|company)\b|commitments? ?\/ ?bond|service (bond|agreement)|\b(commitments?|agreements?)\b.{0,40}\bwith (other|current|former|previous|prior) employers?\b.{0,60}\baffect/i, restrictions],
  [/date of birth|\bdob\b|\bbirth ?date\b/i, (c) => {
    const d = isoDate(c.answers.date_of_birth);
    if (!d?.day) return undefined;
    if (c.kind === 'date') return { date: d };
    return c.kind === 'text' ? { text: dateAs(c.label, d, (x) => `${String(x.day).padStart(2, '0')}/${String(x.month).padStart(2, '0')}/${x.year}`) } : undefined;
  }],
  // Letting the employer use AI tools on the application (allowed by the candidate on 2026-10-18); one
  // about future openings also needs their wish to be considered for other roles.
  [/\b(ai|artificial intelligence)\b\)?.{0,15}\btools?\b|\btools? such as ai\b|\buse of ai\b/i, (c) => {
    const facts = [yes(c.answers.allow_ai_screening)?.yes];
    if (/future (job )?(openings|roles|positions|opportunities)|future .{0,15}matching|other (positions|roles)/i.test(c.label)) facts.push(yes(c.answers.consider_for_other_roles)?.yes);
    return facts.includes(undefined) ? undefined : { yes: facts.every(Boolean) };
  }],
  // A statement to sign, and its date (only with the candidate's permission).
  [/by signing (below|this)|attestation|i hereby attest|\bsignature\b/i, signs],
  [/\b(acknowledge|certify|attest|declare)\b.{0,40}\b(accurate|true|correct|complete)\b/i, affirms],
  [/^date\s*:?$/i, (c) => {
    if (!c.answers.may_e_sign) return undefined;
    const [year, month, day] = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).split('-').map(Number);
    return { date: { year, month, day }, text: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}` };
  }],
  [/^(name )?(prefix|salutation)$/i, (c) => (c.answers.name_prefix ? { option: [new RegExp(`^${escapeRe(String(c.answers.name_prefix).replace(/\.$/, ''))}\\.?$`, 'i')], text: c.answers.name_prefix } : undefined)],
  [/citizen of any of the following countries|citizen of (cuba|iran|north korea|syria)/i,
    (c) => (c.answers.citizenship ? { yes: new RegExp(`\\b${escapeRe(c.answers.citizenship)}\\b`, 'i').test(c.label) } : undefined)],
  [/countries in which you (currently )?hold citizenship|select (all )?(the )?countr(y|ies) of (your )?citizenship/i,
    (c) => (c.answers.citizenship ? { option: [new RegExp(`^${escapeRe(c.answers.citizenship)}$`, 'i')], search: c.answers.citizenship } : undefined)],
  [/citizen or national of the united states|permanent resident|export control/i, (c) => yes(c.answers.us_person)],
  [/^(what is your )?(primary |country of )?(citizenship|nationality)\b|\bprimary nationality\b/i, (c) => (c.answers.citizenship
    ? { option: [new RegExp(`^${escapeRe(c.answers.citizenship)}`, 'i'), /^indian?$/i], search: c.answers.citizenship } : undefined)],
  // "Do you have an Indian nationality?" / "Are you a US citizen?": whether it is the candidate's own.
  [/\bdo you (have|hold) an? \w+ (nationality|citizenship)\b|\bare you an? \w+ (national|citizen)\b/i, (c) => {
    const named = /\ban? (\w+) (?:nationality|citizenship|national|citizen)\b/i.exec(c.label)?.[1];
    const own = String(c.answers.citizenship ?? '').toLowerCase();
    return named && own.length >= 4 ? { yes: named.toLowerCase().startsWith(own.slice(0, 5)) } : undefined;
  }],
  // An OCI/PIO card is for foreign citizens of Indian origin: an Indian citizen cannot hold one.
  [/\b(oci|pio)\b|overseas citizen(ship)? of india/i, (c) => (/^india/i.test(c.answers.citizenship ?? '') ? { yes: false } : undefined)],
  [PAST_TIE, pastTies], // after the export-control questions, which can mention employment too
  [/\b(start|joining|join)\b.{0,15}\bdate\b|\bavailab\w* to (start|join)\b|\bearliest\b.{0,15}\b(start|join)|\bwhen\b.{0,30}\b(start|join)\b|\bhow soon\b.{0,20}\b(start|join)\b/i, (c) => {
    const when = isoDate(/full.?time/i.test(c.label) ? c.answers.earliest_full_time_start
      : c.job.employment_type === 'internship' ? c.answers.internship_available_from : c.answers.earliest_joining_date);
    if (!when?.day) return undefined;
    if (c.kind === 'date') return { date: when };
    if (c.kind === 'text' || c.kind === 'textarea') return { text: dateAs(c.label, when, (d) => `From ${longDate(d)}`) };
    // A list of notice spans: the shortest that still reaches the joining date (lists run shortest first).
    const days = Math.max(0, Math.ceil((Date.UTC(when.year, when.month - 1, when.day) - Date.now()) / 864e5));
    return { option: [{ test: (t) => (optionDays(t) ?? -1) >= days }] };
  }],
  // The profile lists the most recent degree first.
  // Not a number, id or place that merely names the qualification (Fractal: "Roll number / Seat Number /
  // Registration Number of your Highest Education Qualification", "… is located in which State?").
  [/^(?!.*\b(roll|seat|registration|enrol+ment|certificate|id|number|located)\b).*\bhighest (level of )?(education|qualification|degree)\b/i, (c) => {
    const [ed] = c.profile.education ?? [];
    if (!ed || (c.kind !== 'text' && c.kind !== 'textarea')) return undefined;
    return { text: `${ed.degree}, ${ed.institution}${studying(c.profile) ? ' (pursuing)' : ''}` };
  }],
  // Total work experience in years; a question about one skill or tool ("with Python") is not this one.
  // The candidate's own field; a list of industries without it gets "Others" (Philips: Healthcare,
  // Medtech, Automotive, Manufacturing, Others).
  [/\bindustry\b.{0,30}\bspeciali[sz]/i, (c) => (c.answers.industry_specialization
    ? { text: c.answers.industry_specialization, option: [/\bdata\b|analytics/i, /\b(ai|artificial intelligence|machine learning)\b/i, /^others?$/i] } : undefined)],
  // Standing answers for internships, given by the candidate on 2026-10-18.
  [/where will you be in your academic|academic (year|stage|standing) (at|when|during)/i, (c) => (c.answers.academic_stage_at_internship
    ? { option: [new RegExp(`^${escapeRe(c.answers.academic_stage_at_internship)}$`, 'i')], text: c.answers.academic_stage_at_internship } : undefined)],
  [/\bnoc\b|no objection certificate/i, (c) => yes(c.answers.can_provide_noc)],
  [/\bin.person\b.{0,60}\b(full|entire) duration|available to (complete|work|do)\b.{0,40}\bin.person/i, (c) => yes(c.answers.available_in_person)],
  [/plans? to pursue (higher|further) (education|studies)|\bhigher studies\b/i, (c) => yes(c.answers.higher_education_plans)],
  [/\b(active|pending) backlogs?\b|\bbacklogs? in (your|the) (current )?(degree|course|program)|\barrears?\b/i, (c) => (c.answers.active_backlogs == null ? undefined
    : c.answers.active_backlogs ? undefined // how many, and when they clear, is the candidate's to say
      : { option: [/^no\b|^none\b|\bno active\b|^0\b/i], text: '0' })],
  // The internship length when a form makes the candidate pick (internship_min_months 6: "6 months or more"):
  // an option starting at that many months or more ("6 Months and Above", "6-12 months"; not "4 to 6 Months").
  [/\b(duration|length) of (the |your |an )?internship|internship (duration|length|period)|how long (an |the |of an |of the )?internship/i, (c) => {
    const min = Number(c.answers.internship_min_months);
    if (!min) return undefined;
    const atLeast = Array.from({ length: 25 - min }, (_, i) => min + i).join('|');
    return { text: `${min} months or more`, option: [new RegExp(`^(?!.*\\b(less|under|up ?to|within|below|max)\\b)\\D*(${atLeast})\\b.*\\bmonths?\\b`, 'i')] };
  }],
  [/\bfull.?time (role|job|position|employment|opportunit\w*)\b.{0,40}\bafter (the |your )?internship/i, (c) => yes(c.answers.full_time_after_internship)],
  [/\bhours? (per|a|each) day\b.{0,40}\binternship|\binternship\b.{0,40}\bhours? (per|a|each) day/i, (c) => (c.answers.internship_hours_per_day
    ? { text: String(c.answers.internship_hours_per_day), option: [new RegExp(`^${Number(c.answers.internship_hours_per_day)}\\s*(hours?|hrs?)\\b`, 'i')] } : undefined)],
  // Aptitude or technical tests before the interviews (Mactores).
  [/\b(aptitude|technical|coding|online) (tests?|assessments?)\b[\s\S]{0,300}\b(willing|ready|agree|comfortable)\b.{0,10}\b(to take|taking|to attempt|to appear)\b|\b(willing|ready|agree|comfortable)\b.{0,10}\b(to take|taking|to attempt|to appear)\b.{0,60}\b(aptitude|technical|coding|online) (tests?|assessments?)/i,
    (c) => yes(c.answers.willing_to_take_tests)],
  // "Do you hold the certifications outlined in the job description?" when the description names none.
  [/certifications?\b.{0,60}\b(outlined|listed|required|mentioned|specified) in the job description/i, (c) =>
    // PwC's template names the headings even when empty: "Certifications (if blank, certifications not
    // specified)", "Government Clearance Required? No".
    (/\b(certif\w*|clearance)\b/i.test(String(c.job.description ?? '').replace(/certifications \(if blank, certifications not specified\)|government clearance required\? no/gi, '')) ? undefined
      : { option: [/not applicable|n\/a|^none/i, /^yes\b/i], text: 'Not applicable: the job description lists none' })],
  [/\byears of (relevant |total |work |working |professional |prior )?experience\b|\bexperience \(?in years\)?/i, (c) => {
    if (/\b(with|in|using|on) [A-Z]/.test(c.label)) return undefined;
    const years = workYears(c.profile);
    return { text: String(years), option: years ? [new RegExp(`^${years}\\b`)] : [/^0\b|fresher|less than (1|one)|< ?1|no experience|^none/i] };
  }],
  [/\bgraduat\w*\b.{0,15}\b(date|year|month)\b|\b(date|year|month)\b.{0,10}\bgraduat|\bwhen\b.{0,25}\bgraduat/i, (c) => {
    const d = isoDate(c.answers.graduation_date ?? c.answers.graduation_month);
    if (!d) return undefined;
    if (c.kind === 'date') return d.day ? { date: d } : undefined; // a full date needs the exact day
    if (/\byear\b/i.test(c.label)) return { text: String(d.year), option: [new RegExp(`^${d.year}$`)] };
    return undefined;
  }],
  // Before the pay questions: "Currency (Salary Expectations)" names one.
  [/^currency\b|\bcurrency \(/i, () => ({ option: [/\binr\b|indian rupee/i], text: 'INR' })], // the profile's figures are in rupees
  // Notice owed to a current employer, before the notice-length rule: none without a current job.
  [/\bnotice( period)?\b.{0,30}\b(to|with) (your )?current employer\b|\bserving (a |your |the )?notice/i,
    (c) => (employed(c) === false ? { text: 'No', option: [/not applicable|fresher|no notice/i, /^no\b/i] } : undefined)],
  [/notice period|\bhow much notice\b/i, (c) => (c.answers.notice_period == null ? undefined
    : { text: String(c.answers.notice_period), option: [new RegExp(`^${c.answers.notice_period}\\b`), /immediate|^0\b|no notice|not applicable/i,
      ...(c.answers.notice_period === 0 ? [/^(less than|under|below|within|up ?to|<)\s*\d+/i] : [])] })], // Mobility: "Less than 30 days"
  // Every part of current pay (bonus, benefits) is part of the current CTC, which is 0 for a student.
  [/\b(current|present)\b.{0,25}\b(ctc|salary|compensation|pay|bonus|benefits|allowances?|incentives?)\b/i, (c) => (c.answers.current_ctc == null ? undefined
    : { text: `${c.kind === 'textarea' ? 'INR ' : ''}${c.answers.current_ctc}`, option: [/^0\b|not applicable|n\/a|student|fresher/i] })],
  // Before the pay figures, which would read "desired pay" here (the candidate said yes on 2026-10-18).
  [/(desired|expected) (pay|salary)( rate)? is higher than|still (want|wish|like) to be considered/i, (c) => yes(c.answers.consider_if_pay_below_expectation)],
  // The candidate's own figures (₹7 LPA full-time, ₹40,000 a month for internships), converted to the
  // unit the question names; with no unit named, the unit is written out. A list of pay ranges gets the
  // range the figure falls in.
  [/\b(expected|desired)\b.{0,20}\b(ctc|salary|compensation|pay|stipend)\b|\b(salary|pay|compensation|ctc) expectations?\b/i, (c) => {
    const internship = c.job.employment_type === 'internship';
    const stipend = c.answers.expected_internship_stipend_monthly;
    const yearly = internship ? (stipend == null ? null : stipend * 12) : c.answers.expected_ctc;
    if (yearly == null) return undefined;
    const monthly = internship ? stipend : Math.round(yearly / 12);
    const range = { test: (t) => { const r = payRange(t); const v = /month/i.test(`${t} ${c.label}`) ? monthly : yearly; return !!r && v >= r[0] && v <= r[1]; } };
    // With no unit named, the full amount first: a number box keeps only the digits (Dentsu turned "7 LPA" into 7).
    const text = /lpa|lakh/i.test(c.label) ? String(lpa(yearly)) : /month/i.test(c.label) ? String(monthly)
      : /annum|annual|year/i.test(c.label) ? String(yearly) : internship ? `${monthly} per month` : `${yearly} per year`;
    // A text area takes the currency too (AllianceBernstein asks for it on every pay answer).
    return { text: c.kind === 'textarea' ? `INR ${text}` : text, option: [range] };
  }],
  [/^gender$|\bgender\b/i, (c) => (c.answers.gender ? { option: [new RegExp(`^${escapeRe(c.answers.gender)}$`, 'i')] } : undefined)],
  // Being considered for the employer's other open positions, which means keeping the CV for that (the
  // candidate said yes on 2026-10-18; Artefact: "I agree to have my CV retained for 2 years").
  [/(other|additional) (open )?(positions|roles|vacancies|opportunities) than|considered? (me )?for (other|future) (open )?(positions|roles|vacancies|opportunities)|\btalent pool\b|\b(cv|resume)\b.{0,20}\bretained\b/i,
    (c) => (c.kind === 'checkbox' ? (c.answers.consider_for_other_roles ? { yes: true } : undefined) : yes(c.answers.consider_for_other_roles))],
  // Keeping the profile for roles not applied to, with emails about them (GE Vernova; the candidate said yes
  // on 2026-10-18). Before the marketing rule.
  [/\bretain(ing)? your (candidate )?profile\b.{0,200}\b(roles?|positions?|opportunit\w*)\b/i, (c) => yes(c.answers.retain_profile_for_other_roles)],
  // How to be contacted while recruiting (GE Vernova offers "Email" / "Email & Text/SMS", texts only outside
  // India): email, plus texts where the candidate allowed them and the form can send them.
  [/\bcommunication method\b.{0,80}\b(contact|recruit\w*)\b/i, (c) => ({
    option: [...(c.answers.sms_updates && !(c.inIndia && /sms is (currently )?supported in\b/i.test(c.label) && !/\bindia\b/i.test(c.label)) ? [/\b(text|sms)\b/i] : []), /^e-?mail$/i] })],
  // Fractal's questions, from the candidate's answers of 2026-10-18.
  [/\b(roll|seat|registration|enrol+ment) (number|no\.?)\b.{0,80}\b(education|qualification|degree)\b/i,
    (c) => (c.answers.highest_qualification_reg_no ? { text: String(c.answers.highest_qualification_reg_no) } : undefined)],
  [/\btype of (education|degree|qualification)\b/i, (c) => (c.answers.education_type
    ? { text: c.answers.education_type, option: [new RegExp(`^${escapeRe(c.answers.education_type)}\\b`, 'i')] } : undefined)],
  [/\binstitution\b.{0,80}\bhighest (education|qualification)\b.{0,60}\blocated in which (state|country)\b/i, (c) => {
    const v = /country\b/i.test(c.label.slice(-40)) ? c.answers.highest_institution_country : c.answers.highest_institution_state;
    return v ? { text: v, option: [new RegExp(`^${escapeRe(v)}$`, 'i')] } : undefined;
  }],
  // The role applied for: the posting's own title, or a role name it contains ("Data Scientist" in
  // "Data Scientist (Computer Vision)").
  // Fractal's options are kinds of candidate ("I am a Fresher", "I am an Intern"): an internship's intern, or a
  // fresher with no work beyond internships.
  [/\bselect the (role|position) you are applying for\b|\bwhich (role|position) are you applying for\b/i, (c) => {
    const title = String(c.job.title ?? '').toLowerCase();
    const kind = c.job.employment_type === 'internship' ? /\bI am an intern\b/i : workYears(c.profile) === 0 ? /\bI am a fresher\b/i : /\bexperienced professional\b/i;
    return { option: [kind, ...(title ? [new RegExp(`^${escapeRe(c.job.title)}$`, 'i'), { test: (t) => t.length >= 6 && title.includes(t.toLowerCase()) }] : [])] };
  }],
  [/\bcomfortable working from (the )?office\b|\bwork(ing)? (from|at) (the )?(office|client location)\b/i,
    (c) => ((c.answers.work_arrangements ?? []).some((k) => /on.?site|office/i.test(k)) ? { yes: true } : undefined)],
  [/\bprior evaluation\b|\b(tests?|interviews?)\b.{0,60}\b(last|past) \d+ months\b/i,
    (c) => (c.appliedHere === false && c.answers.previously_interviewed === false ? { yes: false } : undefined)],
  [/\b(completed|hold)\b.{0,60}\b(fractal data science professional certificate|analytics vidhya'?s? black belt)/i, (c) => yes(c.answers.fractal_av_certificates)],
  // Marketing opt-ins are never given: a tick box stays unticked and a required yes/no is answered no. A
  // required consent to the employer's terms or privacy notice is ticked (the candidate authorized both
  // on 2026-10-17).
  [/job alert|newsletter|marketing|talent (community|network)|future (opportunit|role|position)|contact me about|keep me (informed|updated)|receive (\w+ )?communications?\b.*\bevents?\b/i,
    (c) => (c.kind === 'dropdown' || c.kind === 'radio' ? { option: [/^(no|i do not|i don't|do not|disagree|decline)\b/i, /\bunsubscribe\b|\bopt.?out\b|\b(do not|don'?t) wish\b/i] } : undefined)], // Fractal: "I wish to unsubscribe …"
  // Also a required "I have read the Privacy Notice" (Dentsu) or "… understand how my information will be
  // processed" (Visa), and a required consent to the tool the employer runs its hiring process with
  // (Logitech's automated interview scheduling).
  [/\b(consent|agree|acknowledge|accept)\b.*\b(terms|conditions|privacy|policy|notice)\b|\b(terms|privacy)\b.*\b(consent|agree|accept)|\b(have read|reading|read and understood)\b.*\b(privacy|terms|notice|policy)\b|\bhow (my|your) (personal )?(information|data) (will be|is|are) (processed|used|handled)\b|automated (interview )?scheduling|scheduling (system|tool|assistant)/i,
    (c) => (c.required && ['checkbox', 'dropdown', 'radio'].includes(c.kind) ? { yes: true } : undefined)],
  // Consent to share the application with the employer itself (AllianceBernstein, under its Terms and
  // Conditions); never with third parties, partners or for marketing.
  [/^(?!.*\b(third.part\w*|partners?|affiliates?|vendors?|advertis\w*|marketing)\b).*\bconsent\b.{0,20}\bshar(e|ing)\b.{0,30}\b(information|data)\b.{0,10}\bwith\b/i,
    (c) => (c.required && ['checkbox', 'dropdown', 'radio'].includes(c.kind) ? { yes: true } : undefined)],
  // The work arrangements the candidate accepts (all three, 2026-10-18; Mobility).
  [/\b(schedules?|work (arrangements?|modes?|models?|set.?ups?))\b.{0,30}\bwilling\b|\bwilling to work (on.?site|in.?office|hybrid|remote)/i, (c) => {
    const re = { onsite: /on.?site|in.?office/i, hybrid: /hybrid/i, remote: /remote|from home/i };
    const ok = (c.answers.work_arrangements ?? []).map((k) => re[String(k).toLowerCase()]).filter(Boolean);
    return ok.length ? { option: ok } : undefined;
  }],
  [/\bexpected to work (in|from) india\b/i, (c) => (c.inIndia ? { yes: true } : undefined)], // PwC: the job is in India
  // Voluntary self-identification: declining is a true answer and the only one CareerPilot gives.
  [/\b(ethnic|race|racial|veteran|disabilit|hispanic|latino|sexual orientation|pronoun)/i,
    (c) => (c.required ? { option: [/decline|not wish|prefer not|do not want|choose not|rather not|not to (self.)?identify|not disclos/i] } : undefined)],
  [/^e-?mail( address)?$/i, (c) => (c.profile.email ? { text: c.profile.email } : undefined)],
  // Where the candidate is and would work: Bengaluru per the profile (and willing to relocate).
  // "Local Given Name(s)", "City - Local", "Address Line 1 - Local": Workday's copy in the local script, the
  // same text for India.
  [/^local given names?(\(s\))?$|^local first name$/i, (c) => (c.answers.legal_given_name ? { text: c.answers.legal_given_name } : undefined)],
  [/^local (family|last) name$|^local surname$/i, (c) => (c.answers.legal_family_name ? { text: c.answers.legal_family_name } : undefined)],
  [/^(current )?city( - local)?$/i, (c) => (c.profile.location ? { text: String(c.profile.location).split(',')[0].trim() } : undefined)],
  [/^(current )?location$/i, (c) => (c.profile.location ? { text: c.profile.location } : undefined)],
  [/(desired|preferred) (work |job )?location/i, (c) => ({ option: [new RegExp(`\\b(${escapeRe(String(c.profile.location ?? '').split(',')[0])}|bengaluru|bangalore)\\b`, 'i')] })],
  // The profile's own links, wherever a form asks again (Artefact repeats LinkedIn and Website).
  [/^linked ?in( profile| url)?$/i, (c) => (c.profile.links?.linkedin ? { text: c.profile.links.linkedin } : undefined)],
  [/^github( profile| url)?$/i, (c) => (c.profile.links?.github ? { text: c.profile.links.github } : undefined)],
  [/^(website|portfolio|personal (website|site))( url)?$/i, (c) => (c.profile.links?.portfolio ? { text: c.profile.links.portfolio } : undefined)],
  [/^address line 1( - local)?$|^street address|^address$/i, (c) => (c.answers.address_line1 ? { text: c.answers.address_line1 } : undefined)],
  [/^address line 2( - local)?$/i, (c) => (c.answers.address_line2 ? { text: c.answers.address_line2 } : undefined)],
  [/^building( name| number)?$/i, (c) => (c.answers.address_building ? { text: c.answers.address_building } : undefined)], // TransUnion
  [/^street number$/i, (c) => (c.answers.address_street_number ? { text: String(c.answers.address_street_number) } : undefined)],
  [/\b(full |legal )*name of (your )?father\b|\bfather'?s (legal |full )*name\b/i, (c) => (c.answers.father_full_name ? { text: c.answers.father_full_name } : undefined)], // DBS
  [/postal code|\bpin ?code\b|\bzip\b/i, (c) => (c.answers.postal_code ? { text: String(c.answers.postal_code) } : undefined)],
];

export function answerFor(question, ctx) {
  const custom = (ctx.answers.custom ?? {})[norm(question.label)];
  if (custom != null) return typeof custom === 'object' ? custom : { text: String(custom), ...yes(custom) && /^(yes|no|true|false)$/i.test(String(custom)) ? yes(custom) : {} };
  const rule = QUESTION_RULES.find(([re]) => re.test(question.label));
  return rule ? rule[1]({ ...ctx, label: question.label, kind: question.kind, required: question.required }) : undefined;
}

// ($$eval is Playwright's in-page query: it runs this function in the page, it is not a string eval.)
const readQuestions = (page) => page.$$eval('[data-automation-id^="formField-"]', (gs) => gs.filter((g) => g.offsetParent).map((g) => {
  const label = (g.querySelector('legend, label')?.innerText ?? '').replace(/\s+/g, ' ').trim();
  const kind = g.querySelector('[data-automation-id="dateInputWrapper"]') ? 'date'
    : g.querySelector('button[aria-haspopup="listbox"]') ? 'dropdown'
    : g.querySelector('input[type=radio]') ? 'radio'
    : g.querySelector('[data-automation-id="multiSelectContainer"]') ? 'prompt'
    : g.querySelector('textarea') ? 'textarea'
    : g.querySelector('input[type=checkbox]') ? 'checkbox'
    : g.querySelector('input') ? 'text' : 'other';
  return { field: g.getAttribute('data-automation-id').replace(/^formField-/, ''), label: label.replace(/\s*\*$/, ''), required: /\*$/.test(label), kind };
}));

// Ticks a checkbox the way a person does: a normal click, else a click on its label text. Returns
// whether it ended up ticked.
async function tick(box) {
  if (await box.isChecked().catch(() => false)) return true;
  await box.check({ timeout: 5000 }).catch(() => {});
  if (await box.isChecked().catch(() => false)) return true;
  const id = await box.getAttribute('id');
  const label = id ? box.page().locator(`label[for="${id}"]`) : box.locator('xpath=ancestor::label[1]');
  if (await label.count()) await label.first().click().catch(() => {});
  return box.isChecked().catch(() => false);
}

async function applyAnswer(page, q, a) {
  // Yes/no options also come worded as consent ("I agree" / "I do not agree"), or as the box's own statement
  // ("By checking this box, I consent to …", MSD).
  const wantsYesNo = a.yes === undefined ? null
    : a.yes ? [/^(yes|i agree|agree|i consent|i accept|accept|i acknowledge|acknowledge|opt-?in)\b/i, /^by (checking|ticking|selecting) (this|the) box\b(?!.*\b(do not|don'?t)\b)/i]
      : [/^(no|i do not|i don't|do not|disagree|decline|i will not|opt-?out)\b/i, /\b(do not|don'?t) (consent|agree|wish)\b/i];
  switch (q.kind) {
    case 'dropdown': return choose(page, q.field, wantsYesNo ?? a.option ?? [new RegExp(`^${escapeRe(a.text ?? '')}$`, 'i')]);
    case 'date': return { chosen: (await setDate(page, page, q.field, a.date)) ? 'date set' : undefined };
    case 'text': case 'textarea': {
      // A yes/no question in a text box: "No" as it is; a "yes" there usually owes details ("If yes, please
      // provide..."), so it is typed only when the question asks for none.
      // A question that says how to answer "none" ("…indicate not applicable (N/A)") gets that.
      const none = /\b(indicate|enter|write|type)\b[^.]{0,30}\bn\/a\b/i.test(q.label) ? 'N/A' : 'No';
      const text = a.text ?? (a.yes === false ? none : a.yes === true && !/\bif (yes|so)\b/i.test(q.label) ? 'Yes' : null);
      if (text == null) return {};
      return { chosen: (await setText(page, q.field, text)) ? text : undefined };
    }
    case 'radio': {
      const radios = page.locator(`${F(q.field)} input[type=radio]`);
      const labels = await radios.evaluateAll((rs) => rs.map((r) => (r.closest('label')?.innerText || document.querySelector(`label[for="${r.id}"]`)?.innerText || r.value || '').trim()));
      const i = best(labels, wantsYesNo ?? a.option ?? []);
      if (i < 0) return { options: labels };
      await radios.nth(i).evaluate((n) => n.scrollIntoView({ block: 'center' })).catch(() => {});
      await radios.nth(i).check({ force: true });
      return { chosen: labels[i] };
    }
    case 'prompt':
      return a.option ? pick(page, q.field, a.search ?? a.text ?? '', a.option) : {};
    case 'checkbox': {
      const boxes = page.locator(`${F(q.field)} input[type=checkbox]`);
      if (a.option) { // a list of checkboxes: tick the ones named
        const labels = await boxes.evaluateAll((bs) => bs.map((b) => (b.closest('label')?.innerText || document.querySelector(`label[for="${b.id}"]`)?.innerText || b.getAttribute('aria-label') || '').trim()));
        const picked = labels.map((l, i) => (a.option.some((re) => re.test(l)) ? i : -1)).filter((i) => i >= 0);
        const ticked = [];
        for (const i of picked) if (await tick(boxes.nth(i))) ticked.push(labels[i]);
        return ticked.length ? { chosen: ticked.join(', ') } : { options: labels };
      }
      if (a.yes === undefined) return {};
      if (!a.yes) return { chosen: 'false' };
      return (await tick(boxes.first())) ? { chosen: 'true' } : { note: 'checkbox did not tick' };
    }
    default: return {};
  }
}

// An open question ("Top 3 reasons to join us") gets an answer drafted from the job and the verified profile
// (ctx.draft, the candidate's choice of 2026-10-18); a disclosure never does: only the candidate knows it.
const OPEN_QUESTION = /\b(why|reasons?|motivat\w*|interest(s|ed)?|tell us|describe|explain|what (excites|attracts|appeals|makes you))\b/i;
const DISCLOSURE = /conflict|disclos|relationship|relative|criminal|convict|offen[cs]e|lawsuit|litigation|terminat|dismiss|disciplin|visa|citizen|health|disabilit/i;
// Whether an unanswered question may get a drafted answer: required, free text, open, not a disclosure.
export const draftable = (q) => q.required && (q.kind === 'textarea' || q.kind === 'text') && OPEN_QUESTION.test(q.label) && !DISCLOSURE.test(q.label);
const offered = (r) => (r.options ? ` (offered: ${r.options.filter((o) => !/^select one$/i.test(o)).slice(0, 8).join(', ')})` : '');

// Answers every question it can. Some answers reveal follow-up questions, so the page is read again
// until nothing new appears.
async function applicationQuestions(page, ctx) {
  const filled = [];
  const unknown = new Map();
  const seen = new Set();
  const drafted = new Map();
  for (let pass = 0; pass < 4; pass++) {
    const fresh = (await readQuestions(page)).filter((q) => !seen.has(q.field));
    if (!fresh.length) break;
    for (const q of fresh) {
      seen.add(q.field);
      let a = answerFor(q, ctx);
      if (a === undefined && ctx.draft && draftable(q)) {
        const text = await ctx.draft(q.label);
        if (text) { a = { text }; drafted.set(q.field, a); }
      }
      if (a === undefined) {
        // The choices on offer (nothing is picked), so the candidate can answer from the Pending page.
        const r = q.required && (q.kind === 'dropdown' || q.kind === 'radio') ? await applyAnswer(page, q, { option: [] }) : {};
        if (q.required) unknown.set(q.field, `${q.label}${offered(r)}`);
        continue;
      }
      const r = await applyAnswer(page, q, a);
      filled.push({ question: q.label.slice(0, 120), answer: r.chosen ?? null });
      if (q.required && !r.chosen) unknown.set(q.field, `${q.label}${offered(r)}`);
    }
    await page.waitForTimeout(1500);
  }
  // Follow-up questions re-draw the form and can clear answers given before them: answer emptied ones
  // again, and type text answers last, once the form has settled.
  const emptied = new Set((await emptyRequired(page)).map((l) => l.trim()));
  for (const q of await readQuestions(page)) {
    if (unknown.has(q.field) || !(emptied.has(q.label.trim()) || q.kind === 'textarea')) continue;
    const a = drafted.get(q.field) ?? answerFor(q, ctx);
    if (a !== undefined) { debug('re-answering', q.label.slice(0, 60)); await applyAnswer(page, q, a); }
  }
  return unknown.size ? { filled, stop: 'blocked', reason: `Needs your answer: ${[...unknown.values()].map((u) => `"${u.slice(0, 300)}"`).join('; ')}` } : { filled };
}

// A field asking for the candidate's photo (Mobility Global's identity check): their own photo, uploaded
// once. True when the step now holds it. ($$eval is Playwright's in-page query, not a string eval.)
async function uploadPhoto(page, photoPath) {
  const i = await page.$$eval('[data-automation-id^="formField-"]', (gs) => gs.findIndex((g) =>
    /\bphoto/i.test(g.querySelector('label, legend')?.innerText ?? '') && g.querySelector('input[type=file]')));
  if (i < 0) return false;
  const group = page.locator('[data-automation-id^="formField-"]').nth(i);
  const file = photoPath.split(/[\\/]/).pop();
  if (await group.getByText(file, { exact: true }).count()) return true;
  await group.locator('input[type=file]').first().setInputFiles(photoPath);
  return group.getByText(/successfully uploaded/i).first().waitFor({ timeout: 60000 }).then(() => true, () => false);
}

const STEPS = [
  [/my information/i, myInformation],
  [/my experience/i, myExperience],
  [/application questions|questionnaire/i, applicationQuestions],
  [/voluntary disclosures|self.?identif/i, applicationQuestions],
];

// What answerFor needs besides the profile, for any employer's form: whether the job is in India, and
// whether the candidate applied to this employer before (another posting here that CareerPilot tracked to
// submitted or later, or one they named in answers.applied_before; unknown until they have answered).
export async function askContext(db, job, profile) {
  const answers = profile.answers ?? {};
  const tracked = await one(db, `SELECT count(*) n FROM applications a JOIN jobs j ON j.id = a.job_id WHERE lower(j.company) = lower(?)
    AND j.id != ? AND a.status IN ('submitted', 'confirmed', 'assessment', 'interview', 'offer', 'rejected')`, [job.company, job.id]);
  const named = answers.applied_before;
  const appliedHere = Number(tracked?.n) > 0 || (Array.isArray(named) && named.some((n) => norm(n) === norm(job.company))) ? true
    : named == null ? undefined : false;
  const inIndia = /india|bengaluru|bangalore|hyderabad|pune|chennai|mumbai|delhi|gurgaon|gurugram|noida|kolkata/i.test(`${job.location ?? ''} ${job.url}`);
  return { profile, answers, job, inIndia, appliedHere };
}

// Runs the application up to Review; submits only when dryRun is false. Returns
// {stop: 'submitted'|'review'|'blocked'|'needs_you'|'expired'|'explored', step, reason?, fields?, trail}.
// explore: on a step with no filler yet, return its fields instead of a 'blocked' stop (development aid).
// draft(question): an answer to an open question, or null (see OPEN_QUESTION).
export async function applyWorkday({ page, job, profile, resumePath, photoPath = null, db, gmail, dryRun = true, explore = false, draft = null, shot = async () => {}, log = () => {} }) {
  const host = portalHost(job.url);
  const answers = profile.answers ?? {};
  const trail = [];
  const { appliedHere, inIndia } = await askContext(db, job, profile);
  const usable = (a) => a && (a.state === 'active' || a.state === 'unverified');
  // Signs in (when an account exists), then opens the application. Returns where it landed, or a stop.
  const begin = async () => {
    if (!(await openPosting(page, job.url))) return { stop: 'expired', reason: 'The employer has taken the posting down' };
    if (!onPortal(page, host)) return { stop: 'blocked', reason: `The posting redirected away from ${host}` };
    // A cookie banner (Labcorp's has Accept / Decline): decline, the choice that tracks least.
    const decline = page.getByRole('button', { name: /^(decline|reject all|reject)$/i });
    if ((await decline.count()) && /cookie/i.test(await page.locator('body').innerText().catch(() => ''))) await decline.first().click().catch(() => {});
    const saved = await loadAccount(db, host);
    if (usable(saved)) {
      let stopped = await signIn(page, saved, host, { db, gmail, log });
      if (stopped?.reopen) { await openPosting(page, job.url); stopped = await signIn(page, saved, host, { db, gmail, log }); }
      if (stopped) return stopped;
      if (!(await page.locator(A('adventureButton')).count())) await openPosting(page, job.url);
    }
    const where = await startApplication(page);
    if (where === 'signed-out' && usable(saved)) return { stop: 'blocked', reason: 'Still signed out after signing in' };
    return where;
  };
  let where = await begin();
  await shot('start');
  if (where === 'signed-out') {
    const created = await createAccount(page, { db, gmail, host, email: profile.email, log });
    // Some portals (Logitech) send a new account back to sign-in until its email is verified: start over,
    // signing in, which asks for the verification that verifyByEmail then completes.
    const inForm = !created && (await page.waitForSelector(A('progressBar'), { timeout: 15000 }).then(() => true, () => false));
    if (created?.reopen || (!created && !inForm)) where = await begin();
    else if (created) { await shot('account-stopped'); return created; }
  }
  if (where?.stop) { await shot('signin-stopped'); return where; }
  await page.waitForSelector(A('progressBar'), { timeout: 30000 });
  for (let guard = 0; guard < 10; guard++) {
    if (!(await recover(page))) { await shot('workday-error'); return { stop: 'blocked', reason: 'Workday keeps showing "Something went wrong"', trail }; }
    const step = await activeStep(page);
    if (!onPortal(page, host)) return { stop: 'blocked', step, reason: `Left ${host}`, trail };
    if (await captchaPresent(page)) return { stop: 'needs_you', step, reason: 'Workday shows a CAPTCHA', trail };
    if (/review/i.test(step)) {
      await settle(page);
      await shot('review');
      if (dryRun) return { stop: 'review', step, trail };
      const submit = page.locator(`${A('pageFooterNextButton')}, ${A('bottom-navigation-next-button')}`).first();
      if (!/submit/i.test(await submit.innerText().catch(() => ''))) return { stop: 'blocked', step, reason: 'The Review page shows no Submit button', trail };
      await submit.click({ force: true });
      // Workday confirms on the page ("Application Submitted", "Thank you for applying"), sometimes only after a
      // minute or more (Marvell): closing the page earlier abandons the submission.
      const CONFIRMED = /application (has been |was )?submitted|thank(s| you) for (applying|your application)|successfully submitted|you('ve| have) (successfully )?applied/i;
      for (let i = 0; i < 150; i++) {
        await page.waitForTimeout(1000);
        // A click that never registered leaves Submit active on the Review page: press it once more. (While
        // Workday is submitting, the button is inactive; a second application is refused by Workday anyway.)
        if (i === 20 && /review/i.test(await activeStep(page).catch(() => '')) && (await submit.isEnabled().catch(() => false))
          && /submit/i.test(await submit.innerText().catch(() => ''))) await submit.click({ force: true });
        const body = await page.locator('body').innerText().catch(() => '');
        const hit = CONFIRMED.exec(body);
        if (hit) {
          await shot('submitted');
          return { stop: 'submitted', step, evidence: { confirmation: body.slice(Math.max(0, hit.index - 60), hit.index + 140).replace(/\s+/g, ' ').trim(), url: page.url(), at: new Date().toISOString() }, trail };
        }
        const errors = await pageErrors(page);
        if (errors.length) { await shot('submit-errors'); return { stop: 'blocked', step, reason: `Submit: ${errors.join('; ')}`, trail }; }
      }
      await shot('submit-unconfirmed');
      return { stop: 'unconfirmed', step, reason: 'Submit was clicked but Workday showed no confirmation within 150 s', trail };
    }
    // The step title shows before its fields do.
    await page.waitForSelector('[data-automation-id^="formField-"]', { timeout: 30000 }).catch(() => {});
    await settle(page);
    const fill = STEPS.find(([re]) => re.test(step))?.[1];
    // Development aid: CP_STOP_AT="my experience" stops before filling that step, to inspect it untouched.
    if (process.env.CP_STOP_AT && new RegExp(process.env.CP_STOP_AT, 'i').test(step)) return { stop: 'explored', step, fields: await formFields(page), trail };
    if (!fill) {
      await shot(`step-${step}`);
      return explore ? { stop: 'explored', step, fields: await formFields(page), errors: await pageErrors(page), trail }
        : { stop: 'blocked', step, reason: `The "${step}" step is not automated yet`, trail };
    }
    const result = await fill(page, { profile, answers, job, host, resumePath, inIndia, draft, appliedHere });
    if (photoPath && (await uploadPhoto(page, photoPath))) result.photo = true;
    trail.push({ step, ...result });
    await shot(`filled-${step}`);
    if (result.stop) return { ...result, step, trail };
    const missing = await emptyRequired(page);
    if (missing.length) return { stop: 'blocked', step, reason: `No verified answer for: ${missing.join('; ')}`, trail };
    const errors = await saveAndContinue(page);
    if (errors) { await shot(`errors-${step}`); return { stop: 'blocked', step, reason: errors.join('; '), trail }; }
  }
  return { stop: 'blocked', reason: 'too many steps', trail };
}

