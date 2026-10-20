import Link from 'next/link';
import { CountUp } from './count-up.jsx';

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
    <div className="page-head mb-8 flex flex-wrap items-end justify-between gap-5">
      <div className="min-w-0 max-w-4xl">
        <h1 className="h2 break-words"><span className="d-line"><span>{title}</span></span></h1>
        {sub && <p className="lead d-up mt-3 max-w-[46rem]" style={{ animationDelay: '.1s' }}>{sub}</p>}
      </div>
      {children && <div className="d-up" style={{ animationDelay: '.16s' }}>{children}</div>}
    </div>
  );
}

export function Card({ title, action, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <div className="flex items-center justify-between gap-3 border-b-[3px] border-line px-5 py-3">
          <h2 className="font-display text-[17px] font-extrabold tracking-[-0.02em]">{title}</h2>
          {action}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

// A statistic is always a link to the exact list it counts. A tone paints the whole tile, like the
// reference's yellow, teal and pink figure pills.
const TONE_BG = { bad: 'bg-pink', warn: 'bg-yellow', good: 'bg-teal' };

export function Stat({ label, value, to, hint, tone }) {
  return (
    <Link href={to} className={`tile tile-hover block p-4 ${TONE_BG[tone] ?? ''}`}>
      <div className="text-[12px] font-bold uppercase tracking-[0.08em]">{label}</div>
      <div className="figure mt-2 text-[34px] leading-none"><CountUp value={Number(value ?? 0)} /></div>
      {hint && <div className={`mt-2 text-xs ${tone ? '' : 'text-ink-2'}`}>{hint}</div>}
    </Link>
  );
}

const BADGE = {
  qualified: 'good', ready: 'accent', submitted: 'accent', confirmed: 'accent', assessment: 'warn', interview: 'good', offer: 'good',
  rejected: 'bad', blocked: 'warn', failed: 'bad', excluded: 'muted', expired: 'muted', duplicate: 'muted', withdrawn: 'muted',
  sent: 'accent', unknown: 'warn', sending: 'warn', high: 'good', low: 'warn',
};
// Ink text on every colour: cream on teal or pink is too faint at badge size.
const BADGE_CLS = { good: 'bg-teal', accent: 'bg-peri', warn: 'bg-yellow', bad: 'bg-pink', muted: 'bg-surface-2 text-ink-2' };
const LABEL = { qualified: 'Qualified', ready: 'Ready to apply', submitted: 'Submitted', confirmed: 'Confirmed', high: 'Verified', low: 'Needs review' };

export function Badge({ value, children }) {
  if (!value) return null;
  return (
    <span className={`badge whitespace-nowrap px-2 py-px text-[10px] leading-[1.6] tracking-[0.08em] ${BADGE_CLS[BADGE[value] ?? 'muted']}`}>
      {children ?? LABEL[value] ?? String(value).replace(/_/g, ' ')}
    </span>
  );
}

export function Table({ head, children, empty = 'Nothing here yet.' }) {
  const rows = [children].flat(2).filter(Boolean);
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b-[3px] border-line bg-surface-2 text-ink-2">
          <tr>{head.map((h) => <th key={h} scope="col" className="kicker px-3 py-3 whitespace-nowrap">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.length ? rows : <tr><td colSpan={head.length} className="px-3 py-10 text-center text-ink-3">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export const Td = ({ children, className = '' }) => <td className={`px-3 py-2.5 align-top ${className}`}>{children}</td>;
export const A = ({ to, children, external }) => external
  ? <a href={to} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap font-medium text-accent decoration-2 underline-offset-2 hover:underline">{children} ↗</a>
  : <Link href={to} className="decoration-2 underline-offset-2 hover:text-accent hover:underline">{children}</Link>;

export function Pager({ base, params, total, page, size = 50 }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return (
    <div className="mt-6 flex items-center justify-between gap-3 text-sm font-medium text-ink-2">
      <span>{fmtNum(total)} result{total === 1 ? '' : 's'}{pages > 1 ? ` · page ${page} of ${pages}` : ''}</span>
      <div className="flex gap-3">
        {page > 1 && <Link className="btn-ghost px-4 py-1.5 text-sm" href={href(base, params, { page: page - 1 })}>← Previous</Link>}
        {page < pages && <Link className="btn-ghost px-4 py-1.5 text-sm" href={href(base, params, { page: page + 1 })}>Next →</Link>}
      </div>
    </div>
  );
}

// GET filter form: plain HTML, works without client JS, every state is a shareable URL.
export function Filters({ base, params, fields }) {
  return (
    <form action={base} className="card mb-8 flex flex-wrap items-end gap-3 p-4">
      {fields.map((f) => (
        <label key={f.name} className="flex flex-col gap-1.5">
          <span className="kicker pl-1 text-ink-2">{f.label}</span>
          {f.options ? (
            <select name={f.name} defaultValue={params[f.name] ?? f.default ?? ''} className="field">
              {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          ) : (
            <input name={f.name} defaultValue={params[f.name] ?? ''} placeholder={f.placeholder} className="field w-52" />
          )}
        </label>
      ))}
      <button className="btn-primary px-5 py-1.5 text-sm">Apply</button>
      <Link href={base} className="px-2 py-1.5 text-sm font-semibold text-ink-2 hover:text-ink">Reset</Link>
    </form>
  );
}

// Horizontal bars: one series, one hue, value labelled at the bar end, row links to its drill-down.
export function Bars({ rows, max }) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => (
        <li key={r.label}>
          <Link href={r.to} className="group grid grid-cols-[minmax(7rem,12rem)_1fr_auto] items-center gap-3 rounded-xl px-1.5 py-1 hover:bg-surface-2"
            title={`${r.label}: ${fmtNum(r.value)}${r.note ? ` (${r.note})` : ''}`}>
            <span className="truncate text-sm text-ink-2 group-hover:text-ink">{r.label}</span>
            <span className="h-3.5 overflow-hidden rounded-full border-2 border-line bg-surface-2">
              <span className="d-grow block h-full rounded-full" style={{ width: `${Math.max(r.value ? 1.5 : 0, (100 * r.value) / top)}%`, background: 'var(--bar)', animationDelay: `${0.2 + i * 0.05}s` }} />
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

// Marks a blocked application done: the candidate applied themselves (markDoneAction). Two clicks, like Drop.
export function DoneButton({ id, action }) {
  return (
    <details className="text-xs">
      <summary className="mt-1 cursor-pointer font-semibold text-accent hover:underline">Done</summary>
      <form action={action} className="mt-1.5">
        <input type="hidden" name="id" value={id} />
        <button className="btn-primary btn-sm">I applied: mark done</button>
      </form>
    </details>
  );
}

// Drops a job for good (dropJobAction). Two clicks and no script: "Drop" opens "Drop for good".
export function DropButton({ jobId, action }) {
  return (
    <details className="text-xs">
      <summary className="mt-1 cursor-pointer font-semibold text-ink-3 hover:text-bad">Drop</summary>
      <form action={action} className="mt-1.5">
        <input type="hidden" name="jobId" value={jobId} />
        <button className="btn-ghost btn-sm text-bad">Drop for good</button>
      </form>
    </details>
  );
}
