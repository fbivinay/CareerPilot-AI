'use client';
import { useActionState } from 'react';
import { disconnectGmail, runGmailReadTest, sendGmailSelfTest } from '../actions.js';

const NOTICES = {
  connected: ['good', 'Gmail connected with read-only access. Run the read-only test next.'],
  'send-enabled': ['good', 'Send permission granted. Sending is now enabled.'],
  'send-declined': ['warn', 'Google did not grant the send permission, so sending stays off. Reading still works.'],
  disconnected: ['good', 'Gmail disconnected and access revoked at Google.'],
  'not-configured': ['warn', 'The Google OAuth client is not configured yet (see the steps below).'],
  'test-first': ['warn', 'Run the read-only test first; sending can only be enabled after it passes.'],
};
const TONE = { good: 'bg-good-soft text-good', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad' };

const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');
const Button = ({ children, ...p }) => <button {...p} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">{children}</button>;
const LinkButton = ({ href, children }) => <a href={href} className="inline-block rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white">{children}</a>;

function Step({ n, title, done, children }) {
  return (
    <li className="flex gap-3">
      <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${done ? 'bg-good text-white' : 'bg-surface-2 text-ink-2'}`}>{done ? '✓' : n}</span>
      <div className="min-w-0 flex-1 text-sm"><div className="font-medium">{title}</div><div className="mt-1 space-y-2 text-ink-2">{children}</div></div>
    </li>
  );
}

export function GmailPanel({ status, notice, error }) {
  const [test, runTest, testing] = useActionState(runGmailReadTest, null);
  const [self, sendSelf, sending] = useActionState(sendGmailSelfTest, null);
  const readOk = test ? test.ok : status.readTest?.ok && status.readTest.email === status.email;
  const banner = error ? ['bad', error] : NOTICES[notice];

  return (
    <div className="space-y-4">
      {banner && <p className={`rounded-md px-3 py-2 text-sm ${TONE[banner[0]]}`}>{banner[1]}</p>}
      {status.error && <p className={`rounded-md px-3 py-2 text-sm ${TONE.bad}`}>{status.error} Reconnect below.</p>}
      <ol className="space-y-4">
        <Step n={1} title="Connect Gmail (read-only)" done={status.canRead}>
          {!status.configured ? (
            <p>Needs a Google OAuth client first. Add <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> and <code>APP_ENCRYPTION_KEY</code> to the server environment (see SETUP.md, “Gmail”), then reload this page.</p>
          ) : status.canRead ? (
            <p>Connected as <strong className="text-ink">{status.email}</strong>{status.sendGranted ? ' with read and send permission.' : ' with read-only permission.'}</p>
          ) : (
            <>
              <p>Opens Google’s sign-in. Google will say “Google hasn’t verified this app”: that is expected for a personal app. Choose <em>Advanced → Go to CareerPilot</em>, then allow reading your email.</p>
              <LinkButton href="/api/gmail/connect?mode=read">{status.error ? 'Reconnect Gmail' : 'Connect Gmail'}</LinkButton>
            </>
          )}
        </Step>

        <Step n={2} title="Run the read-only test" done={readOk}>
          <p>Reads your last 14 days of mail and sorts it in memory. Nothing is sent, changed or stored except the counts.</p>
          {status.readTest?.ok && !test && <p>Passed {fmt(status.readTest.at)}: {status.readTest.fetched} messages read from {status.readTest.email}.</p>}
          {status.canRead && (
            <form action={runTest}><Button disabled={testing}>{testing ? 'Reading…' : readOk ? 'Run again' : 'Run read-only test'}</Button></form>
          )}
          {test && !test.ok && <p className="text-bad">Test failed: {test.error}</p>}
          {test?.ok && (
            <div className="rounded-md border border-line p-3">
              <p className="text-good">Passed: read {test.fetched} messages from {test.email}.</p>
              <p className="mt-1">By category: {Object.entries(test.categories).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ') || 'no messages in the last 14 days'}</p>
              {test.samples.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs">
                  {test.samples.map((s, i) => <li key={i}><span className="text-ink">{s.category.replace(/_/g, ' ')}</span> · {s.subject} <span className="text-ink-3">({s.from}, {fmt(s.date)})</span></li>)}
                </ul>
              )}
            </div>
          )}
        </Step>

        <Step n={3} title="Enable sending" done={status.canSend}>
          {status.canSend ? (
            <>
              <p>Sending is enabled. Applications and outreach go out only within the limits and sending window below.</p>
              <form action={sendSelf}><Button disabled={sending}>{sending ? 'Sending…' : 'Send a test email to myself'}</Button></form>
              {self && <p className={self.ok ? 'text-good' : 'text-bad'}>{self.ok ? `Sent to ${self.sentTo}. Check your inbox.` : self.error}</p>}
            </>
          ) : readOk ? (
            <>
              <p>Adds Google’s “send email on your behalf” permission. CareerPilot only sends what the outreach rules allow, from your own Gmail.</p>
              <LinkButton href="/api/gmail/connect?mode=send">Enable sending</LinkButton>
            </>
          ) : <p>Available after the read-only test passes.</p>}
        </Step>
      </ol>

      {status.connected && (
        <form action={disconnectGmail} className="border-t border-line pt-3">
          <button className="text-sm text-bad hover:underline">Disconnect Gmail and revoke access</button>
        </form>
      )}
      <p className="text-xs text-ink-3">The access token is encrypted in your database and used by the scheduled pipeline while your PC is off. Changing your Google password, or 6 months without use, ends access; reconnect here.</p>
    </div>
  );
}
