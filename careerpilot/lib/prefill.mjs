// Fills standard candidate fields on an ATS application form. Never ticks consent or declaration
// boxes, never answers screening questions it has no verified answer for, never submits.

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

// Returns the names of the fields it filled and whether a resume was attached.
export async function prefillPage(page, fields, resumePath) {
  // The phone keeps its +91 prefix: Greenhouse's phone widget uses it to pick the country itself.
  const values = { ...fields, full_name: [fields.first_name, fields.last_name].filter(Boolean).join(' ') };
  const filled = [];
  for (const [name, labels] of FIELDS) if (await fillOne(page, labels, values[name])) filled.push(name);
  let resume = false;
  const upload = page.locator('input[type=file]').first();
  if (resumePath && await upload.count()) {
    try { await upload.setInputFiles(resumePath); resume = true; } catch { /* custom uploader; candidate attaches manually */ }
  }
  return { filled, resume };
}
