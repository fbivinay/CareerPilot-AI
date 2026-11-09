'use client';
import { useActionState } from 'react';
import { sendBulkEmail } from '../actions.js';

const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

// Paste one or many addresses; each gets its own email (subject, text and resume from the saved template).
// The addresses are queued here and sent on GitHub, so results show up on the next page load.
export function BulkSend({ subject, pending, last }) {
  const [state, send, sending] = useActionState(sendBulkEmail, null);
  const sent = last?.results?.filter((r) => r.ok).length ?? 0;
  return (
    <form action={send} className="card mb-10 space-y-3 p-5">
      <p className="text-sm text-ink-2">
        Sends <strong>{subject ?? 'your saved email'}</strong> with your resume attached, as a separate email to each address. Up to 50 at a time.
      </p>
      <textarea name="addresses" rows={4} required placeholder={'hr@company.com\nrecruiter@other.com, careers@third.in'}
        className="field w-full rounded-2xl font-mono text-sm" />
      <button disabled={sending} className="btn-primary px-4 py-1.5 text-sm">{sending ? 'Queuing…' : 'Send'}</button>
      {state?.error && <p className="text-sm text-bad">{state.error}</p>}
      {state?.queued && (
        <p className="text-sm font-medium">
          {state.queued} queued. {state.started ? 'Sending now; refresh in about a minute to see each result.' : 'They go out with the next pipeline run (within 30 minutes).'}
        </p>
      )}
      {pending > 0 && !state?.queued && <p className="text-sm text-ink-2">{pending} waiting to be sent. Refresh in a minute.</p>}
      {last?.error && <p className="text-sm text-bad">Last batch ({fmt(last.at)}): {last.error}</p>}
      {last?.results && (
        <details className="text-sm">
          <summary className="cursor-pointer">Last batch ({fmt(last.at)}): {sent} of {last.results.length} sent</summary>
          <ul className="mt-1 space-y-0.5">
            {last.results.map((r) => (
              <li key={r.email} className={r.ok ? 'text-ink-2' : 'text-bad'}>{r.ok ? '✓' : '✗'} {r.email}{r.error && ` — ${r.error}`}</li>
            ))}
          </ul>
        </details>
      )}
    </form>
  );
}
