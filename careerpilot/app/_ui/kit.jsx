import Link from 'next/link';

export const ROLE_LABELS = { ai: 'AI / GenAI', ds: 'Data Science / ML', de: 'Data Engineering', da: 'Data / Product Analyst' };

export function href(base, params, patch = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...patch })) if (v != null && v !== '') sp.set(k, String(v));
  const q = sp.toString();
  return q ? `${base}?${q}` : base;
}

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—');
export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
export const fmtNum = (n) => Number(n ?? 0).toLocaleString('en-IN');
export const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');

export function fmtComp(j) {
  if (!j.comp_source || j.comp_max == null) return null;
  if (j.comp_currency && j.comp_currency !== 'INR') return `${j.comp_currency} ${fmtNum(j.comp_min)}–${fmtNum(j.comp_max)}`;
  if (j.comp_period === 'month') return `₹${fmtNum(j.comp_min)}${j.comp_max !== j.comp_min ? '–' + fmtNum(j.comp_max) : ''}/mo`;
  const l = (v) => (v / 1e5).toFixed(v % 1e5 ? 1 : 0);
  return `₹${l(j.comp_min)}${j.comp_max !== j.comp_min ? '–' + l(j.comp_max) : ''} LPA`;
}

export function PageHeader({ title, sub, children }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-1 text-sm text-ink-2">{sub}</p>}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, action, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-line bg-surface ${className}`}>
      {title && (
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          {action}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

// A statistic is always a link to the exact list it counts.
export function Stat({ label, value, to, hint, tone }) {
  const toneCls = tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'good' ? 'text-good' : 'text-ink';
  return (
    <Link href={to} className="group rounded-xl border border-line bg-surface p-4 transition hover:border-accent hover:shadow-sm">
      <div className="text-[13px] text-ink-2 group-hover:text-ink">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneCls}`}>{fmtNum(value)}</div>
      {hint && <div className="mt-1 text-xs text-ink-3">{hint}</div>}
    </Link>
  );
}

const BADGE = {
  qualified: 'good', ready: 'accent', submitted: 'accent', confirmed: 'accent', assessment: 'warn', interview: 'good', offer: 'good',
  rejected: 'bad', blocked: 'warn', failed: 'bad', excluded: 'muted', expired: 'muted', duplicate: 'muted', withdrawn: 'muted',
  sent: 'accent', unknown: 'warn', sending: 'warn', high: 'good', low: 'warn',
};
const BADGE_CLS = {
  good: 'bg-good-soft text-good', accent: 'bg-accent-soft text-accent', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad',
  muted: 'bg-surface-2 text-ink-2',
};
const LABEL = { qualified: 'Qualified', ready: 'Ready to apply', submitted: 'Submitted', confirmed: 'Confirmed', high: 'Verified', low: 'Needs review' };

export function Badge({ value, children }) {
  if (!value) return null;
  return (
    <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE_CLS[BADGE[value] ?? 'muted']}`}>
      {children ?? LABEL[value] ?? String(value).replace(/_/g, ' ')}
    </span>
  );
}

export function Table({ head, children, empty = 'Nothing here yet.' }) {
  const rows = [children].flat(2).filter(Boolean);
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line bg-surface-2 text-xs text-ink-2">
          <tr>{head.map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.length ? rows : <tr><td colSpan={head.length} className="px-3 py-8 text-center text-ink-3">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export const Td = ({ children, className = '' }) => <td className={`px-3 py-2 align-top ${className}`}>{children}</td>;
export const A = ({ to, children, external }) => external
  ? <a href={to} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{children} ↗</a>
  : <Link href={to} className="hover:text-accent hover:underline">{children}</Link>;

export function Pager({ base, params, total, page, size = 50 }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-ink-2">
      <span>{fmtNum(total)} result{total === 1 ? '' : 's'}{pages > 1 ? ` · page ${page} of ${pages}` : ''}</span>
      <div className="flex gap-2">
        {page > 1 && <Link className="rounded-md border border-line px-2.5 py-1 hover:border-accent" href={href(base, params, { page: page - 1 })}>← Previous</Link>}
        {page < pages && <Link className="rounded-md border border-line px-2.5 py-1 hover:border-accent" href={href(base, params, { page: page + 1 })}>Next →</Link>}
      </div>
    </div>
  );
}

// GET filter form: plain HTML, works without client JS, every state is a shareable URL.
export function Filters({ base, params, fields }) {
  return (
    <form action={base} className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-3">
      {fields.map((f) => (
        <label key={f.name} className="flex flex-col gap-1 text-xs text-ink-2">
          {f.label}
          {f.options ? (
            <select name={f.name} defaultValue={params[f.name] ?? f.default ?? ''} className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink">
              {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          ) : (
            <input name={f.name} defaultValue={params[f.name] ?? ''} placeholder={f.placeholder} className="w-48 rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink" />
          )}
        </label>
      ))}
      <button className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white">Apply</button>
      <Link href={base} className="px-2 py-1.5 text-sm text-ink-2 hover:text-ink">Reset</Link>
    </form>
  );
}

// Horizontal bars: one series, one hue, value labelled at the bar end, row links to its drill-down.
export function Bars({ rows, max }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.label}>
          <Link href={r.to} className="group grid grid-cols-[minmax(7rem,12rem)_1fr_auto] items-center gap-3 rounded-md px-1 py-0.5 hover:bg-surface-2"
            title={`${r.label}: ${fmtNum(r.value)}${r.note ? ` (${r.note})` : ''}`}>
            <span className="truncate text-sm text-ink-2 group-hover:text-ink">{r.label}</span>
            <span className="h-3 rounded-[4px] bg-surface-2">
              <span className="block h-3 rounded-[4px]" style={{ width: `${Math.max(r.value ? 1.5 : 0, (100 * r.value) / top)}%`, background: 'var(--bar)' }} />
            </span>
            <span className="min-w-12 text-right text-sm tabular-nums">{fmtNum(r.value)}{r.note && <span className="ml-1 text-xs text-ink-3">{r.note}</span>}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function KV({ items }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
        <div key={k} className="contents"><dt className="text-ink-2">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>
      ))}
    </dl>
  );
}

export function Timeline({ events }) {
  if (!events.length) return <p className="text-sm text-ink-3">No events.</p>;
  return (
    <ol className="space-y-2 text-sm">
      {events.map((e) => {
        const d = e.detail ? JSON.parse(e.detail) : {};
        return (
          <li key={e.id} className="flex gap-3">
            <span className="w-32 shrink-0 text-xs text-ink-3">{fmtDateTime(e.at)}</span>
            <span>
              <span className="font-medium">{e.action}</span>
              {e.to_status && <> {e.from_status ? `${e.from_status} → ` : '→ '}<Badge value={e.to_status} /></>}
              {(d.reason || d.detail?.reason || d.by) && <span className="text-ink-2"> · {d.reason ?? d.detail?.reason ?? ''} {d.by ? `(${d.by})` : ''}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export const gmailLink = (threadId) => `https://mail.google.com/mail/u/0/#all/${threadId}`;
export const host = (u) => { try { return new URL(u).hostname; } catch { return u; } };

// Drops a job for good (dropJobAction). Two clicks and no script: "Drop" opens "Drop for good".
export function DropButton({ jobId, action }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-ink-3 hover:text-bad">Drop</summary>
      <form action={action} className="mt-1">
        <input type="hidden" name="jobId" value={jobId} />
        <button className="whitespace-nowrap rounded border border-bad px-2 py-0.5 text-bad hover:bg-bad-soft">Drop for good</button>
      </form>
    </details>
  );
}
