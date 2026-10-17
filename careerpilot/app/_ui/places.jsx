'use client';
import Link from 'next/link';
import { useState } from 'react';

// Where applications go, as a donut (part-to-whole at a glance, at most six slices: the top five and
// "Others") with a ranked legend that carries the exact numbers. Colors are the validated categorical
// slots in fixed order; "Others" is the neutral. Text never wears a slice color.
const SLOTS = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)'];
const pctOf = (n, total) => (total ? Math.round((100 * n) / total) : 0);

function Logo({ src, name, size = 20, width = size }) {
  const [failed, setFailed] = useState(false);
  const initials = String(name ?? '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  if (!src || failed) {
    return (
      <span aria-hidden="true" style={{ width, height: size, fontSize: size * 0.42 }}
        className="inline-flex shrink-0 items-center justify-center rounded bg-surface-2 font-semibold text-ink-2">{initials}</span>
    );
  }
  // Logos are drawn for their owner's own header, so some are white and some dark: a white tile in both
  // themes, with a hairline shadow that outlines white glyphs, keeps every one of them visible.
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded border border-line bg-white p-0.5" style={{ width, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- remote logos, no optimisation needed */}
      <img src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="max-h-full max-w-full object-contain"
        style={{ filter: 'drop-shadow(0 0 0.6px rgba(0,0,0,0.55))' }} />
    </span>
  );
}

export function PlacesDonut({ total, places }) {
  const rows = [
    ...places.shown.map((p, i) => ({ ...p, color: SLOTS[i] })),
    ...(places.others ? [{ label: 'Others', count: places.others.count, note: `${places.others.names} more`, color: 'var(--cat-other)' }] : []),
  ];
  const [active, setActive] = useState(null);
  const R = 62;
  const C = 2 * Math.PI * R;
  const GAP = 2; // surface gap between slices
  let offset = 0;
  const arcs = rows.map((r) => {
    const len = total ? (r.count / total) * C : 0;
    const arc = { ...r, dash: Math.max(0, len - GAP), offset };
    offset += len;
    return arc;
  });
  const shown = active == null ? null : rows[active];
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
      <div className="relative shrink-0" style={{ width: 160, height: 160 }}>
        <svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label={`Applications by site: ${rows.map((r) => `${r.label} ${r.count}`).join(', ')}`}>
          <g transform="rotate(-90 80 80)">
            {arcs.map((a, i) => (
              <circle key={a.label} cx="80" cy="80" r={R} fill="none" stroke={a.color} strokeWidth={active === i ? 20 : 16}
                strokeDasharray={`${a.dash} ${C - a.dash}`} strokeDashoffset={-a.offset}
                opacity={active == null || active === i ? 1 : 0.35} className="cursor-pointer transition-[opacity,stroke-width] duration-150"
                onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)} />
            ))}
          </g>
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {shown ? (
            <>
              <span className="text-xl font-semibold">{shown.count}</span>
              <span className="text-xs text-ink-2">{pctOf(shown.count, total)}% · {shown.label}</span>
            </>
          ) : (
            <>
              <span className="text-2xl font-semibold">{total}</span>
              <span className="text-xs text-ink-2">applications</span>
            </>
          )}
        </div>
      </div>
      <ol className="w-full min-w-0 space-y-1">
        {rows.map((r, i) => (
          <li key={r.label}>
            <button type="button" onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}
              className={`grid w-full grid-cols-[10px_20px_1fr_auto_3rem] items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm ${active === i ? 'bg-surface-2' : ''}`}>
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: r.color }} aria-hidden="true" />
              {r.label === 'Others' ? <span /> : <Logo src={r.logo} name={r.label} />}
              <span className="truncate">{r.label}{r.note && <span className="ml-1 text-xs text-ink-3">({r.note})</span>}</span>
              <span className="tabular-nums font-medium">{r.count}</span>
              <span className="text-right tabular-nums text-xs text-ink-3">{pctOf(r.count, total)}%</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function TopCompanies({ total, companies }) {
  const max = Math.max(1, ...companies.shown.map((c) => c.count));
  return (
    <ol className="space-y-2">
      {companies.shown.map((c) => (
        <li key={c.label}>
          <Link href={`/companies/${encodeURIComponent(c.label)}`} title={`${c.name}: ${c.count} applications`}
            className="group grid grid-cols-[44px_minmax(6rem,10rem)_1fr_auto] items-center gap-3 rounded-md px-1 py-1 hover:bg-surface-2">
            <Logo src={c.logo} name={c.name} size={28} width={44} />
            <span className="truncate text-sm group-hover:underline">{c.name}</span>
            <span className="h-2 rounded-[4px] bg-surface-2">
              <span className="block h-2 rounded-[4px]" style={{ width: `${(100 * c.count) / max}%`, background: 'var(--bar)' }} />
            </span>
            <span className="min-w-10 text-right text-sm tabular-nums">{c.count}</span>
          </Link>
        </li>
      ))}
      {companies.others && (
        <li className="grid grid-cols-[44px_minmax(6rem,10rem)_1fr_auto] items-center gap-3 px-1 py-1 text-sm text-ink-2">
          <span />
          <span>Others</span>
          <span className="text-xs text-ink-3">{companies.others.names} more companies</span>
          <span className="min-w-10 text-right tabular-nums">{companies.others.count}</span>
        </li>
      )}
      <li className="px-1 pt-1 text-xs text-ink-3">{total} applications across {companies.shown.length + (companies.others?.names ?? 0)} companies</li>
    </ol>
  );
}
