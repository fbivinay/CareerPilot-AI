'use client';
import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { sendBulkEmail } from '../actions.js';
import { bulkEta, observedPace } from '@/lib/bulk-eta.mjs';

const DAILY_CAP = 499; // lib/outreach.mjs; bulk:last carries the cap in force once a run has started

const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
const STALE_MS = 3 * 60_000; // a run that stopped writing progress this long ago was cut off

// Paste one or many addresses; each gets its own email (subject, text and resume from the saved template).
// The addresses are queued here and sent on GitHub; the box follows the run live, refreshing every 3 seconds.
export function BulkSend({ subject, pending, last }) {
  const [state, send, sending] = useActionState(sendBulkEmail, null);
  const router = useRouter();
  const results = last?.results ?? [];
  const sent = results.filter((r) => r.ok).length;
  const running = !!last?.running && Date.now() - Date.parse(last.at) < STALE_MS;
  // A paused batch counts as waiting again once the page has restarted its sender (resumeBulkIfDue).
  const paused = !running && !!last?.paused && !last.restartedAt;
  const waiting = !running && !paused && (pending > 0 || !!state?.queued);
  // Reload at the resume time, so the page restarts the sender and shows it without a manual refresh.
  useEffect(() => {
    const ms = paused && pending > 0 ? Date.parse(last.resumeAt) - Date.now() : NaN;
    if (!(ms < 2 ** 31)) return;
    const t = setTimeout(() => router.refresh(), Math.max(ms, 0) + 5000);
    return () => clearTimeout(t);
  }, [paused, pending, last?.resumeAt, router]);
  useEffect(() => {
    if (!running && !waiting) return;
    // Every refresh re-reads the database: skip it in a hidden tab, and give up waiting on a run that never started.
    const since = Date.now();
    const t = setInterval(() => {
      if (waiting && Date.now() - since > STALE_MS) return clearInterval(t);
      if (!document.hidden) router.refresh();
    }, 3000);
    return () => clearInterval(t);
  }, [running, waiting, router]);

  return (
    <form action={send} className="card mb-10 space-y-3 p-5">
      <p className="text-sm text-ink-2">
        Sends <strong>{subject ?? 'your saved email'}</strong> with your resume attached, as a separate email to each address. Up to 50 at a time.
      </p>
      <textarea name="addresses" rows={4} required placeholder={'hr@company.com\nrecruiter@other.com, careers@third.in'}
        className="field w-full rounded-2xl font-mono text-sm" />
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={sending} className="btn-primary px-4 py-1.5 text-sm">{sending ? 'Queuing…' : 'Send'}</button>
        <button name="priority" value="1" disabled={sending} className="btn-ghost px-4 py-1.5 text-sm"
          title="Put these addresses ahead of everything already queued">Priority send</button>
      </div>
      {state?.error && <p className="text-sm text-bad">{state.error}</p>}
      {state?.priority && !sending && <p className="text-sm text-ink-2">{state.queued} moved to the front of the queue — they go out next.</p>}

      {running && <Progress last={last} sent={sent} pending={pending} />}
      {waiting && (
        <div className="space-y-2 pt-1">
          <p className="flex items-center gap-2 text-sm font-medium"><Dot />
            {pending || state?.queued} queued — starting the sender on GitHub (usually under a minute)…</p>
          <div className="bar"><div className="bar-sweep" /></div>
        </div>
      )}
      {paused && (
        <div className="space-y-1">
          <p className="text-sm text-bad">{pending > 0 && `${pending} waiting, paused: `}{last.paused} They go out automatically once Gmail allows.</p>
          {pending > 0 && last.resumeAt && (
            <p className="text-sm font-medium" suppressHydrationWarning>Next run starts around {fmt(last.resumeAt)}.</p>
          )}
        </div>
      )}
      {(running || waiting || paused) && <Eta last={last} remaining={pending || state?.queued || 0} />}
      {last?.error && <p className="text-sm text-bad">Last batch ({fmt(last.at)}): {last.error}</p>}
      {!running && results.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer">Last batch ({fmt(last.at)}): {sent} of {results.length} sent</summary>
          <Results results={results} />
        </details>
      )}
    </form>
  );
}

// Estimated finish of everything queued, from the 24-hour limit, the send log and this run's speed.
function Eta({ last, remaining }) {
  // Without the send log (a run from before the estimate existed) it would ignore the 24-hour cap: show nothing.
  if (!last?.sentTimes) return null;
  const cap = last.cap ?? DAILY_CAP;
  const at = bulkEta({ sentTimes: last?.sentTimes, remaining, cap, paceMs: observedPace(last) });
  if (!at) return null;
  return (
    <p className="text-sm text-ink-2" suppressHydrationWarning>
      {remaining} to go · all sent by around <strong>{fmt(at)}</strong>
      <span className="text-ink-3"> (estimate: {cap} emails per 24 hours at the current speed)</span>
    </p>
  );
}

function Progress({ last, sent, pending }) {
  const results = last.results;
  // Done so far plus what is still queued, so addresses added during the run count toward the total.
  const total = Math.max(results.length + pending, 1);
  const pct = Math.round((results.length / total) * 100);
  const skipped = results.length - sent;
  const latest = results.at(-1);
  return (
    <div className="space-y-2 pt-1" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium"><Dot />
          Sending… <span key={sent} className="tick text-2xl font-bold tabular-nums">{sent}</span> sent
          {skipped > 0 && <span className="text-ink-3">· {skipped} skipped</span>}
        </p>
        <p className="text-sm tabular-nums text-ink-2">{results.length} of {total} · {pct}%{pending > 0 && ` · ${pending} still queued`}</p>
      </div>
      <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="bar-fill" style={{ width: `${Math.max(pct, 3)}%` }} />
      </div>
      {latest && (
        <p key={latest.email} className="tick truncate text-xs text-ink-2">
          {latest.ok ? '✓ Sent to' : '✗ Skipped'} {latest.email}{latest.error && ` — ${latest.error}`}
        </p>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-ink-2">Show each address</summary>
        <Results results={results} />
      </details>
    </div>
  );
}

function Results({ results }) {
  return (
    <ul className="mt-1 max-h-64 space-y-0.5 overflow-y-auto">
      {results.map((r) => (
        <li key={r.email} className={r.ok ? 'text-ink-2' : 'text-bad'}>{r.ok ? '✓' : '✗'} {r.email}{r.error && ` — ${r.error}`}</li>
      ))}
    </ul>
  );
}

const Dot = () => (
  <span className="relative flex size-2.5">
    <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-75" />
    <span className="relative inline-flex size-2.5 rounded-full bg-accent" />
  </span>
);
