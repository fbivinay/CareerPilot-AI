// Fills an ATS application form (Greenhouse, Lever, Ashby, …) in the candidate's own browser: the standard
// fields, the resume, and the employer's own questions, answered with the same rules as Workday forms
// (answerFor). Never answers a question it has no verified answer for, never touches a CAPTCHA, never
// submits: the candidate reviews the form and clicks Submit.
import { answerFor, best, draftable, escapeRe } from './apply/workday.mjs';

export const CONFIRMATION = /thank(s| you) for (applying|your application)|application (has been |was )?(submitted|received)|we('ve| have) received your application|successfully (applied|submitted)/i;

// The page that holds the form for each ATS.
export function applyUrl(url) {
  const u = new URL(url);
  if (u.hostname === 'jobs.lever.co' && !u.pathname.endsWith('/apply')) u.pathname = u.pathname.replace(/\/$/, '') + '/apply';
  if (u.hostname === 'jobs.ashbyhq.com' && !u.pathname.endsWith('/application')) u.pathname = u.pathname.replace(/\/$/, '') + '/application';
  return u.toString();
}

const FIELDS = [
  ['first_name', [/^first name/i, /first\s*name/i]],
  ['last_name', [/^last name/i, /last\s*name|surname/i]],
  ['full_name', [/^full name/i, /^name\b/i]],
  ['email', [/^email/i, /e-?mail/i]],
  ['phone', [/^phone/i, /phone|mobile/i]],
  ['linkedin', [/linkedin/i]],
  ['github', [/github/i]],
  ['portfolio', [/portfolio|website|personal site/i]],
  ['location', [/current location|^location|^city/i]],
];

async function fillOne(page, labels, value) {
  if (value == null || value === '') return false;
  for (const re of labels) {
    const field = page.getByLabel(re).first();
    try {
      if (await field.isVisible({ timeout: 500 }) && await field.isEditable() && !(await field.inputValue())) {
        await field.fill(String(value));
        return true;
      }
    } catch { /* not on this form, or not a text input */ }
  }
  return false;
}

// Every question on the form, read in the page: its label as a person reads it (for a set of options, the
// question they answer, not an option's own label), its kind, whether it is required and already
// answered, and its options. Each control is tagged data-cp-q (and options data-cp-opt) to be found again.
// (Passed to page.evaluate: it runs in the page; it is not a string eval.)
function readQuestions() {
  const text = (n) => (n?.innerText ?? n?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const shown = (el) => !!(el.offsetParent || el.getClientRects().length);
  const own = (el) => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return text(l); }
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ');
    return el.getAttribute('aria-label') || text(el.closest('label'));
  };
  // The question a field or a set of options answers: everything its box says except the options' own
  // labels, so a description carrying the real question counts too (Greenhouse: "Personalised Question",
  // then "Please select your gender:"; Lever puts the question in the card's heading).
  const groupOf = (el) => {
    const box = el.closest('fieldset, .application-question, [class*="fieldEntry"], [class*="question"], [role="radiogroup"], [role="group"]');
    if (!box) return '';
    // Only a box holding this one question: a wider one would lend another question's words.
    const controls = [...box.querySelectorAll('input:not([type=hidden]), textarea, select')];
    if (!controls.every((c) => c === el || (el.name && c.name === el.name))) return '';
    let rest = text(box);
    for (const input of box.querySelectorAll('input')) { const o = own(input); if (o) rest = rest.split(o).join(' '); }
    return rest.replace(/\s+/g, ' ').trim();
  };
  const out = [];
  const groups = new Map();
  let n = 0;
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=submit]):not([type=button]), textarea, select')) {
    // A styled option hides its own input and shows its label instead (Ashby).
    const optionLabel = (el.type === 'radio' || el.type === 'checkbox') && (el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)));
    if (!shown(el) && !(optionLabel && shown(optionLabel))) continue;
    const kind = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.type === 'radio' ? 'radio'
      : el.type === 'checkbox' ? 'checkbox' : el.getAttribute('role') === 'combobox' || el.closest('[class*="select__"]') ? 'combobox' : 'text';
    const required = el.required || el.getAttribute('aria-required') === 'true';
    if (kind === 'radio' || kind === 'checkbox') {
      const name = el.name || el.id;
      let g = groups.get(name);
      if (!g) { g = { key: `q${n++}`, kind, inputs: [], required: false, group: groupOf(el) }; groups.set(name, g); out.push(g); }
      el.dataset.cpQ = g.key;
      el.dataset.cpOpt = String(g.inputs.length);
      g.inputs.push({ label: own(el), checked: el.checked });
      g.required ||= required;
      continue;
    }
    const key = `q${n++}`;
    el.dataset.cpQ = key;
    out.push({ key, kind, label: own(el) || groupOf(el), required, filled: kind === 'select' ? el.selectedIndex > 0 : !!el.value?.trim(),
      options: kind === 'select' ? [...el.options].map((o) => o.text.trim()).filter((t) => t && !/^(select|choose)\b/i.test(t)) : undefined });
  }
  const clean = (s) => String(s ?? '').replace(/\s*[*✱]+\s*$/, '').trim();
  return out.map((q) => (q.inputs ? {
    key: q.key, kind: q.kind, multi: q.kind === 'checkbox' && q.inputs.length > 1,
    // A lone tick box is its own question ("I accept the privacy policy"); options answer the group's, even a
    // single one (Ashby: "Desired work location", with only "Bangalore").
    label: clean(q.kind === 'checkbox' && q.inputs.length === 1 ? q.inputs[0].label : q.group || q.inputs[0].label),
    required: q.required || /[*✱]\s*$/.test(q.group ?? ''), options: q.inputs.map((i) => i.label), filled: q.inputs.some((i) => i.checked),
  } : { ...q, required: q.required || /[*✱]\s*$/.test(q.label), label: clean(q.label) }));
}

// Ticks an option; one whose input is hidden behind a styled label (Ashby) is ticked through its label.
async function choose(option) {
  try { await option.check({ force: true, timeout: 3000 }); } catch { /* hidden input */ }
  if (await option.isChecked().catch(() => false)) return;
  const id = await option.getAttribute('id');
  const label = id ? option.page().locator(`label[for="${id}"]`) : option.locator('xpath=ancestor::label[1]');
  await label.first().click();
}

const YES = /^(yes|i agree|agree|i consent|i accept|accept|i acknowledge|acknowledge|opt-?in)\b/i;
const NO = /^(no|i do not|i don't|do not|disagree|decline|i will not|opt-?out)\b/i;

async function answerOne(page, q, a) {
  const at = page.locator(`[data-cp-q="${q.key}"]`);
  const wants = a.yes !== undefined ? [a.yes ? YES : NO] : a.option ?? (a.text != null ? [new RegExp(`^${escapeRe(a.text)}$`, 'i')] : []);
  switch (q.kind) {
    case 'text': case 'textarea': {
      const text = a.text ?? (a.yes === false ? 'No' : null);
      if (text == null) return false;
      await at.first().fill(String(text));
      return true;
    }
    case 'select': {
      const i = best(q.options, wants);
      if (i < 0) return false;
      await at.first().selectOption({ label: q.options[i] });
      return true;
    }
    case 'radio': {
      const i = best(q.options, wants);
      if (i < 0) return false;
      await choose(page.locator(`[data-cp-q="${q.key}"][data-cp-opt="${i}"]`));
      return true;
    }
    case 'checkbox': {
      if (q.multi) {
        const picked = q.options.map((o, i) => (wants.some((re) => re.test(o)) ? i : -1)).filter((i) => i >= 0);
        for (const i of picked) await choose(page.locator(`[data-cp-q="${q.key}"][data-cp-opt="${i}"]`));
        return picked.length > 0;
      }
      if (a.yes === false) return true; // left unticked is the answer
      if (a.yes !== true) return false;
      await choose(at.first());
      return true;
    }
    case 'combobox': {
      await at.first().click();
      await at.first().fill(String(a.search ?? a.text ?? ''));
      await page.waitForTimeout(800);
      const options = page.locator('[role="option"]');
      const i = best(await options.allInnerTexts(), wants);
      if (i < 0) { await page.keyboard.press('Escape'); return false; }
      await options.nth(i).click();
      return true;
    }
    default: return false;
  }
}

// The employer's own questions, answered from the profile (ctx as askContext builds it, plus an optional
// ctx.draft for open questions). Fills only what is empty. Returns what it answered and the required
// questions left for the candidate.
export async function answerQuestions(page, ctx) {
  const answered = [];
  const left = [];
  for (const q of await page.evaluate(readQuestions)) {
    if (q.filled || !q.label) continue;
    const kind = q.kind === 'select' || q.kind === 'combobox' ? 'dropdown' : q.kind;
    let a = answerFor({ label: q.label, kind, required: q.required }, ctx);
    if (a === undefined && ctx.draft && draftable({ ...q, kind })) { const text = await ctx.draft(q.label); if (text) a = { text }; }
    const done = a !== undefined && await answerOne(page, q, a).catch(() => false);
    if (done) answered.push(q.label.slice(0, 80));
    else if (q.required) left.push(q.label.slice(0, 120));
  }
  return { answered, left };
}

// Returns the names of the fields it filled and whether a resume was attached. The resume goes first:
// Lever and Ashby read it and rewrite the fields, which would undo anything typed before.
export async function prefillPage(page, fields, resumePath) {
  let resume = false;
  // The resume field itself, not an "autofill from resume" box that some forms (Ashby) put first.
  const upload = page.locator('input[type=file][name*="resume" i], input[type=file][id*="resume" i]').or(page.locator('input[type=file]')).first();
  if (resumePath && await upload.count()) {
    try { await upload.setInputFiles(resumePath); resume = true; } catch { /* custom uploader; candidate attaches manually */ }
    if (resume) { // wait out the form's own resume reading ("Analyzing resume…", "Parsing your resume…"), which starts a moment later
      await page.waitForTimeout(3000);
      for (let i = 0; i < 25 && /analy[sz]ing (your )?resume|parsing your resume|autofilling/i.test(await page.locator('body').innerText().catch(() => '')); i++) await page.waitForTimeout(1000);
      await page.waitForTimeout(1500);
    }
  }
  // The phone keeps its +91 prefix: Greenhouse's phone widget uses it to pick the country itself.
  const values = { ...fields, full_name: [fields.first_name, fields.last_name].filter(Boolean).join(' ') };
  const filled = [];
  for (const [name, labels] of FIELDS) if (await fillOne(page, labels, values[name])) filled.push(name);
  return { filled, resume };
}
