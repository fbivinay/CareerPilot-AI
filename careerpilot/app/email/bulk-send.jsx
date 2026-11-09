'use client';
import { useActionState } from 'react';
import { sendBulkEmail } from '../actions.js';

// Paste one or many addresses; each gets its own email (subject, text and resume from the saved template).
export function BulkSend({ subject }) {
  const [state, send, sending] = useActionState(sendBulkEmail, null);
  const sent = state?.results?.filter((r) => r.ok).length ?? 0;
  return (
    <form action={send} className="card mb-10 space-y-3 p-5">
      <p className="text-sm text-ink-2">
        Sends <strong>{subject ?? 'your saved email'}</strong> with your resume attached, as a separate email to each address. Up to 50 at a time.
      </p>
      <textarea name="addresses" rows={4} required placeholder={'hr@company.com\nrecruiter@other.com, careers@third.in'}
        className="field w-full rounded-2xl font-mono text-sm" />
      <button disabled={sending} className="btn-primary px-4 py-1.5 text-sm">{sending ? 'Sending…' : 'Send'}</button>
      {state?.error && <p className="text-sm text-bad">{state.error}</p>}
      {state?.results && (
        <div className="text-sm">
          <p className="font-medium">{sent} of {state.results.length} sent.</p>
          <ul className="mt-1 space-y-0.5">
            {state.results.map((r) => (
              <li key={r.email} className={r.ok ? 'text-ink-2' : 'text-bad'}>{r.ok ? '✓' : '✗'} {r.email}{r.error && ` — ${r.error}`}</li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
