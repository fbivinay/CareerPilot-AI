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

// The posting, with its Apply button ready.
async function openPosting(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector(A('adventureButton'), { timeout: 30000 });
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
const WORKDAY_SENDER = /(^|\.)(myworkday|workday|myworkdayjobs)\.com$/i;
const onHost = (u, host) => { try { const x = new URL(u); return x.protocol === 'https:' && x.hostname.toLowerCase() === host; } catch { return false; } };
async function verificationLink(gmail, sinceMs, host) {
  for (let i = 0; i < 18; i++) { // up to ~3 minutes
    const ids = await gmail.listIds(`from:(myworkday.com OR workday.com OR myworkdayjobs.com) newer_than:1d`, 10);
    for (const id of ids) {
      const msg = await gmail.get(id);
      if (!msg.authenticated || !WORKDAY_SENDER.test(String(msg.fromAddr ?? '').split('@')[1] ?? '')) continue;
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
const VERIFY_TEXT = /verify (your )?(candidate )?(account|email)|email has been sent|activate your account/i;
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
  if (isArea) {
    // Workday's text areas only register real typing: fill() changes the box but not the form's state.
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
function best(texts, wants) {
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
  // Options load after the list opens; until then it holds only the "Select One" placeholder.
  for (let i = 0; i < 20 && (await options.count()) < 2; i++) await page.waitForTimeout(500);
  const texts = (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const i = best(texts, wants);
  debug('choose', field, { current, offered: texts.length, pick: texts[i] ?? null });
  if (i < 0 || texts[i] === current) { await page.keyboard.press('Escape'); return i < 0 ? { options: texts } : { chosen: current, options: texts }; }
  await options.nth(i).scrollIntoViewIfNeeded();
  await options.nth(i).click();
  await page.waitForTimeout(400);
  const now = (await button.innerText()).trim();
  debug('choose', field, 'now shows', now);
  return now === texts[i] ? { chosen: texts[i], options: texts } : { options: texts, note: `clicked "${texts[i]}" but the field shows "${now}"` };
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
  await page.waitForTimeout(500);
  await closePopup(page);
  return (await chips()).includes(texts[i]) ? { chosen: texts[i] } : { options: texts.slice(0, 15), note: `"${texts[i]}" did not stick` };
}

// "How did you hear about us": the employer's own site is where CareerPilot finds postings ("Marvell
// Website", "Company Website"). Job-board names that merely contain "career" (Career Builder) never match.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sourceWants = (employerNames) => [
  new RegExp(`^(${employerNames.filter(Boolean).map(escapeRe).join('|')})\\b.*\\b(web ?site|careers?( site| page)?)$`, 'i'),
  /^(the )?(company|corporate|employer|organi[sz]ation)('s)?( careers?)? (web)?site$/i,
  /\b(company|corporate|employer|official)\b[^,]*\b(web)?site\b/i, /\bcareers? (web ?site|site|page|portal)\b/i];
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
  let source = await choose(page, 'source', wants);
  if (source.missing) { // a search box instead of a dropdown: the employer's own name finds its site first
    for (const q of [...names, 'career', 'website', ...(viaListings ? ['other job board', 'job board'] : [])]) {
      source = await pick(page, 'source', q, wants);
      if (source.chosen || source.missing) break;
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
  // Most specific first; then the plain degree level some portals list ("Masters (+2 or +3 yrs)", "MS").
  [/^m\.?\s?sc\b|master of science/i, [/^master of science \(m\.?sc\)$/i, /^master of science\b/i, /^m\.?\s?sc\.?$/i, /^m\.?s\.?$/i, /^masters?('s)?\b/i]],
  [/^b\.?\s?sc\b|bachelor of science/i, [/^bachelor of science \(b\.?sc\)$/i, /^bachelor of science\b/i, /^b\.?\s?sc\.?$/i, /^b\.?s\.?$/i, /^bachelors?('s)?\b/i]],
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
// "Data Analytics" or "Analytics" for "Big Data Analytics", "Statistics" for "Statistics & Economics",
// never "Data Science". Searches go from the full name to its tail words.
const words = (s) => String(s).toLowerCase().split(/[^a-z]+/).filter((w) => w && w !== 'and');
export function fieldWants(field) {
  const have = new Set(words(field));
  return { test: (option) => { const w = words(option); return w.length > 0 && w.every((x) => have.has(x)); } };
}
const fieldSearches = (field) => { const w = String(field).split(/\s*(?:&|,|\band\b)\s*|\s+/).filter(Boolean); return [...new Set([field, ...w.map((_, i) => w.slice(i).join(' ')), ...w])].filter((s) => s.length > 2); };

// Entry panels of a repeatable section ("Education-2-panel"). Workday re-sorts saved entries, so a panel
// is matched to a profile entry by what it holds (`same`), then an empty one (`empty`) is reused, and
// only then is a new one added.
const groupLabelled = (label) => `[role="group"][aria-labelledby="${label}"], [role="group"][aria-label="${label}"]`;
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
  for (const q of ['School not in list', 'School Not Listed']) { // tenants name it either way (PwC: the second)
    notListed = await pick(page, 'school', q, /not (in|on) (the )?list|not listed/i, scope);
    if (notListed.chosen) return { ...notListed, note: `"${name}" is not in Workday's list` };
  }
  return { options: notListed.options ?? exact.options };
}

async function myExperience(page, { profile, answers, resumePath }) {
  const filled = { experience: [], education: [] };
  const problems = [];
  const usedJobs = new Set();
  const expSection = (await page.locator(groupLabelled('Work-Experience-section')).count()) ? 'Work-Experience' : 'Professional-Experience';
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
  for (const ed of profile.education ?? []) {
    const panel = await entryPanel(page, 'Education', usedSchools,
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
const lpa = (inr) => Math.round((inr / 1e5) * 100) / 100;

// A statement the candidate signs by typing their name. Their standing permission (answers.may_e_sign)
// covers only certifying that the answers are true and acknowledging that the employer may check them:
// a statement with any other sentence in it (a promise, a waiver, a consent) waits for the candidate to
// approve it (answers.custom), and a tick box or yes/no is never signed this way.
const CERTIFIES = [
  /^(i (hereby )?)?(certify|attest|declare|confirm|affirm) that (all )?(of )?(the )?(foregoing |above |preceding )?(information|answers|statements|responses)\b[^?]*?\b(is|are) (true|correct|accurate|complete)(,? (and )?(true|correct|accurate|complete))*( to the best of my knowledge( and belief)?)?$/i,
  /^i understand that (?!.*\b(i|me|my)\b)[^?]{1,60}? reserves the right to (inquire|verify|investigate)\b[^?]*$/i,
];
function signs(c) {
  if (!c.answers.may_e_sign || (c.kind !== 'text' && c.kind !== 'textarea')) return undefined;
  const sentences = c.label
    .replace(/\b(attestation|acknowledge?ment)( and (attestation|acknowledge?ment))?( statement)?\b|\bby signing (below|this)\b,?( i hereby)?|\bsignature( and date)?\b/gi, '.')
    .split(/[.;:]/).map((s) => s.trim()).filter(Boolean);
  if (!sentences.length || !sentences.every((s) => CERTIFIES.some((re) => re.test(s)))) return undefined;
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  return { text: /\bdate\b/i.test(c.label) ? `${c.profile.name}, ${date}` : c.profile.name };
}

// Past ties to this employer. One question can name several ("worked here as an employee or
// contractor"): it is "yes" when any tie it names is, "no" only when every tie it names is known to be
// "no", and unknown otherwise. Employment comes from the profile's full history, the rest from the
// candidate's standing answers.
const RELATIVE = /\b(friend|relative|family member|related to)\b|\bpersonal relationship\b|relationship with (any|a) (current )?employee/i;
const PAST_TIE = new RegExp(`${RELATIVE.source}|\\binterviewed\\b|\\b(ever|previously|already) applied\\b|\\breceived an offer\\b|\\bindependent contractor\\b|third.party labou?r|\\b(ever|previously|formerly|currently|already)\\b.{0,20}\\b(worked|employed|work|employee)\\b|\\bformer (employee|intern|contractor)\\b|collaborated with|\\b(client|partner|vendor|supplier)\\b.{0,40}\\bcapacity|contractor or consultant|consultant roles?\\b`, 'i');
function pastTies(c) {
  const facts = [
    [RELATIVE, c.answers.relatives_at_employer],
    [/\binterview(ed|s)?\b/i, c.answers.previously_interviewed],
    // No application, no offer: both follow from whether the candidate applied here before.
    [/\bapplied\b|\breceived an offer\b/i, c.appliedHere],
    [/\b(work|worked|employed|employee|intern)\b/i, workedAt(c.profile, c.job.company)],
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

// [pattern on the question, answer(ctx)]: the first matching pattern decides; undefined = not known.
const QUESTION_RULES = [
  [/\b(at least|over|above|older than)\b.{0,15}\b18\b|\b18 years\b|age of 18|legal age/i, (c) => yes(c.answers.age_18_or_older)],
  [/\bsponsor/i, (c) => (c.inIndia ? yes(c.answers.needs_visa_sponsorship) : undefined)],
  [/(legal|lawful)\w* (right|authori[sz]\w*|eligib\w*|permi\w*) to work|authori[sz]ed to work|work authori[sz]ation|eligible to work|right to work/i,
    (c) => (c.inIndia ? yes(c.answers.indian_work_authorization) : undefined)],
  [/relocat/i, (c) => yes(c.answers.willing_to_relocate)],
  [/reasonable (adjustment|accommodation)s?|accommodations? (during|in|for) the (recruit|interview|hiring|application)/i, (c) => yes(c.answers.needs_accommodation)],
  [/government official|public official|politically exposed/i, (c) => yes(c.answers.government_official)],
  [/restrictive covenant|non-?compet(e|ition)|non-?solicit|(agreement|obligation)s?\b.{0,80}\brestricts?\b|\bbond\b.{0,40}\b(employer|company)\b|commitments? ?\/ ?bond|service (bond|agreement)/i, restrictions],
  [/date of birth|\bdob\b|\bbirth ?date\b/i, (c) => {
    const d = isoDate(c.answers.date_of_birth);
    if (!d?.day) return undefined;
    if (c.kind === 'date') return { date: d };
    return c.kind === 'text' ? { text: `${String(d.day).padStart(2, '0')}/${String(d.month).padStart(2, '0')}/${d.year}` } : undefined;
  }],
  // Letting the employer use AI tools on the application (allowed by the candidate on 2026-10-18); one
  // about future openings also needs their wish to be considered for other roles.
  [/\b(ai|artificial intelligence)\b\)?.{0,15}\btools?\b/i, (c) => {
    const facts = [yes(c.answers.allow_ai_screening)?.yes];
    if (/future (job )?(openings|roles|positions|opportunities)|other (positions|roles)/i.test(c.label)) facts.push(yes(c.answers.consider_for_other_roles)?.yes);
    return facts.includes(undefined) ? undefined : { yes: facts.every(Boolean) };
  }],
  // A statement to sign, and its date (only with the candidate's permission).
  [/by signing (below|this)|attestation|i hereby attest|\bsignature\b/i, signs],
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
  [/^(country of )?(citizenship|nationality)\b/i, (c) => (c.answers.citizenship ? { option: [new RegExp(`^${escapeRe(c.answers.citizenship)}`, 'i'), /^indian?$/i] } : undefined)],
  // An OCI/PIO card is for foreign citizens of Indian origin: an Indian citizen cannot hold one.
  [/\b(oci|pio)\b|overseas citizen(ship)? of india/i, (c) => (/^india/i.test(c.answers.citizenship ?? '') ? { yes: false } : undefined)],
  [PAST_TIE, pastTies], // after the export-control questions, which can mention employment too
  [/\b(start|joining|join)\b.{0,15}\bdate\b|\bavailab\w* to (start|join)\b|\bearliest\b.{0,15}\b(start|join)|\bwhen\b.{0,30}\b(start|join)\b|\bhow soon\b.{0,20}\b(start|join)\b/i, (c) => {
    const when = isoDate(/full.?time/i.test(c.label) ? c.answers.earliest_full_time_start
      : c.job.employment_type === 'internship' ? c.answers.internship_available_from : c.answers.earliest_joining_date);
    if (!when?.day) return undefined;
    if (c.kind === 'date') return { date: when };
    if (c.kind === 'text' || c.kind === 'textarea') return { text: `From ${longDate(when)}` };
    // A list of notice spans: the shortest that still reaches the joining date (lists run shortest first).
    const days = Math.max(0, Math.ceil((Date.UTC(when.year, when.month - 1, when.day) - Date.now()) / 864e5));
    return { option: [{ test: (t) => (optionDays(t) ?? -1) >= days }] };
  }],
  // The profile lists the most recent degree first.
  [/\bhighest (level of )?(education|qualification|degree)\b/i, (c) => {
    const [ed] = c.profile.education ?? [];
    if (!ed || (c.kind !== 'text' && c.kind !== 'textarea')) return undefined;
    const end = dateRange(ed.dates)[1];
    const now = new Date();
    const pursuing = end && (end.year > now.getFullYear() || (end.year === now.getFullYear() && end.month > now.getMonth() + 1));
    return { text: `${ed.degree}, ${ed.institution}${pursuing ? ' (pursuing)' : ''}` };
  }],
  // Total work experience in years; a question about one skill or tool ("with Python") is not this one.
  [/\bindustry\b.{0,30}\bspeciali[sz]/i, (c) => (c.answers.industry_specialization
    ? { text: c.answers.industry_specialization, option: [/\bdata\b|analytics/i, /\b(ai|artificial intelligence|machine learning)\b/i] } : undefined)],
  // "Do you hold the certifications outlined in the job description?" when the description names none.
  [/certifications?\b.{0,60}\b(outlined|listed|required|mentioned|specified) in the job description/i, (c) =>
    (/\b(certif\w*|clearance)\b/i.test(c.job.description ?? '') ? undefined
      : { option: [/not applicable|n\/a|^none/i, /^yes\b/i], text: 'Not applicable: the job description lists none' })],
  [/\byears of (relevant |total |work |professional |prior )?experience\b|\bexperience \(?in years\)?/i, (c) => {
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
  [/notice period|\bhow much notice\b/i, (c) => (c.answers.notice_period == null ? undefined
    : { text: String(c.answers.notice_period), option: [new RegExp(`^${c.answers.notice_period}\\b`), /immediate|^0\b|no notice|not applicable/i] })],
  [/\b(current|present)\b.{0,25}\b(ctc|salary|compensation|pay)\b/i, (c) => (c.answers.current_ctc == null ? undefined
    : { text: String(c.answers.current_ctc), option: [/^0\b|not applicable|n\/a|student|fresher/i] })],
  // The candidate's own figures (₹7 LPA full-time, ₹40,000 a month for internships), converted to the
  // unit the question names; with no unit named, the unit is written out.
  [/\bexpected\b.{0,10}\b(ctc|salary|compensation|pay|stipend)\b|\b(salary|pay|compensation|ctc) expectations?\b/i, (c) => {
    const internship = c.job.employment_type === 'internship';
    const stipend = c.answers.expected_internship_stipend_monthly;
    const yearly = internship ? (stipend == null ? null : stipend * 12) : c.answers.expected_ctc;
    if (yearly == null) return undefined;
    const monthly = internship ? stipend : Math.round(yearly / 12);
    if (/lpa|lakh/i.test(c.label)) return { text: String(lpa(yearly)) };
    if (/month/i.test(c.label)) return { text: String(monthly) };
    if (/annum|annual|year/i.test(c.label)) return { text: String(yearly) };
    return { text: internship ? `${monthly} per month` : `${lpa(yearly)} LPA` };
  }],
  [/^gender$|\bgender\b/i, (c) => (c.answers.gender ? { option: [new RegExp(`^${escapeRe(c.answers.gender)}$`, 'i')] } : undefined)],
  // Being considered for the employer's other open positions (the candidate said yes on 2026-10-18).
  [/(other|additional) (open )?(positions|roles|vacancies|opportunities) than|considered? (me )?for (other|future) (open )?(positions|roles|vacancies|opportunities)|\btalent pool\b/i,
    (c) => (c.kind === 'checkbox' ? (c.answers.consider_for_other_roles ? { yes: true } : undefined) : yes(c.answers.consider_for_other_roles))],
  // Marketing opt-ins are never given: a tick box stays unticked and a required yes/no is answered no. A
  // required consent to the employer's terms or privacy notice is ticked (the candidate authorized both
  // on 2026-10-17).
  [/job alert|newsletter|marketing|talent (community|network)|future (opportunit|role|position)|contact me about|keep me (informed|updated)|receive (\w+ )?communications?\b.*\bevents?\b/i,
    (c) => (c.kind === 'dropdown' || c.kind === 'radio' ? { option: [/^(no|i do not|i don't|do not|disagree|decline)\b/i] } : undefined)],
  [/\b(consent|agree|acknowledge|accept)\b.*\b(terms|conditions|privacy|policy|notice)\b|\b(terms|privacy)\b.*\b(consent|agree|accept)/i,
    (c) => (c.kind === 'checkbox' && c.required ? { yes: true } : undefined)],
  // Voluntary self-identification: declining is a true answer and the only one CareerPilot gives.
  [/\b(ethnic|race|racial|veteran|disabilit|hispanic|latino|sexual orientation|pronoun)/i,
    (c) => (c.required ? { option: [/decline|not wish|prefer not|do not want|choose not|rather not|not to (self.)?identify|not disclos/i] } : undefined)],
  [/^e-?mail( address)?$/i, (c) => (c.profile.email ? { text: c.profile.email } : undefined)],
  [/^address line 1$|^street address|^address$/i, (c) => (c.answers.address_line1 ? { text: c.answers.address_line1 } : undefined)],
  [/^address line 2$/i, (c) => (c.answers.address_line2 ? { text: c.answers.address_line2 } : undefined)],
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
  // Yes/no options also come worded as consent ("I agree" / "I do not agree").
  const wantsYesNo = a.yes === undefined ? null
    : [a.yes ? /^(yes|i agree|agree|i consent|i accept|accept)\b/i : /^(no|i do not|i don't|do not|disagree|decline)\b/i];
  switch (q.kind) {
    case 'dropdown': return choose(page, q.field, wantsYesNo ?? a.option ?? [new RegExp(`^${escapeRe(a.text ?? '')}$`, 'i')]);
    case 'date': return { chosen: (await setDate(page, page, q.field, a.date)) ? 'date set' : undefined };
    case 'text': case 'textarea': {
      // A yes/no question in a text box: "No" as it is; a "yes" there usually owes details ("If yes, please
      // provide..."), so it is typed only when the question asks for none.
      const text = a.text ?? (a.yes === false ? 'No' : a.yes === true && !/\bif (yes|so)\b/i.test(q.label) ? 'Yes' : null);
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
      if (a === undefined && q.required && ctx.draft && (q.kind === 'textarea' || q.kind === 'text')
        && OPEN_QUESTION.test(q.label) && !DISCLOSURE.test(q.label)) {
        const text = await ctx.draft(q.label);
        if (text) { a = { text }; drafted.set(q.field, a); }
      }
      if (a === undefined) {
        if (q.required) unknown.set(q.field, q.label);
        continue;
      }
      const r = await applyAnswer(page, q, a);
      filled.push({ question: q.label.slice(0, 120), answer: r.chosen ?? null });
      if (q.required && !r.chosen) unknown.set(q.field, `${q.label}${r.options ? ` (offered: ${r.options.filter((o) => !/^select one$/i.test(o)).slice(0, 8).join(', ')})` : ''}`);
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
  return unknown.size ? { filled, stop: 'blocked', reason: `Needs your answer: ${[...unknown.values()].map((u) => `"${u.slice(0, 200)}"`).join('; ')}` } : { filled };
}

const STEPS = [
  [/my information/i, myInformation],
  [/my experience/i, myExperience],
  [/application questions|questionnaire/i, applicationQuestions],
  [/voluntary disclosures|self.?identif/i, applicationQuestions],
];

// Runs the application up to Review; submits only when dryRun is false. Returns
// {stop: 'submitted'|'review'|'blocked'|'needs_you'|'explored', step, reason?, fields?, trail}.
// explore: on a step with no filler yet, return its fields instead of a 'blocked' stop (development aid).
// draft(question): an answer to an open question, or null (see OPEN_QUESTION).
export async function applyWorkday({ page, job, profile, resumePath, db, gmail, dryRun = true, explore = false, draft = null, shot = async () => {}, log = () => {} }) {
  const host = portalHost(job.url);
  const answers = profile.answers ?? {};
  const trail = [];
  // Whether the candidate applied to this employer before: another posting here that CareerPilot tracked
  // to submitted or later, or one they named (answers.applied_before); unknown until they have answered.
  const tracked = await one(db, `SELECT count(*) n FROM applications a JOIN jobs j ON j.id = a.job_id WHERE lower(j.company) = lower(?)
    AND j.id != ? AND a.status IN ('submitted', 'confirmed', 'assessment', 'interview', 'offer', 'rejected')`, [job.company, job.id]);
  const named = answers.applied_before;
  const appliedHere = Number(tracked?.n) > 0 || (Array.isArray(named) && named.some((n) => norm(n) === norm(job.company))) ? true
    : named == null ? undefined : false;
  const usable = (a) => a && (a.state === 'active' || a.state === 'unverified');
  // Signs in (when an account exists), then opens the application. Returns where it landed, or a stop.
  const begin = async () => {
    await openPosting(page, job.url);
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
    if (created?.reopen) where = await begin();
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
      // Workday confirms on the page ("Application Submitted", "Thank you for applying").
      const CONFIRMED = /application (has been |was )?submitted|thank(s| you) for (applying|your application)|successfully submitted|you('ve| have) (successfully )?applied/i;
      for (let i = 0; i < 60; i++) {
        await page.waitForTimeout(1000);
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
      return { stop: 'unconfirmed', step, reason: 'Submit was clicked but Workday showed no confirmation within 60 s', trail };
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
    const inIndia = /india|bengaluru|bangalore|hyderabad|pune|chennai|mumbai|delhi|gurgaon|gurugram|noida|kolkata/i.test(`${job.location ?? ''} ${job.url}`);
    const result = await fill(page, { profile, answers, job, host, resumePath, inIndia, draft, appliedHere });
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

