'use client';
import { useActionState } from 'react';
import { login } from '../actions.js';

export function LoginForm({ next }) {
  const [state, action, pending] = useActionState(login, null);
  return (
    <form action={action} className="mt-5 space-y-3">
      <input type="hidden" name="next" value={next} />
      <label className="block text-sm">
        <span className="text-ink-2">Password</span>
        <input type="password" name="password" required autoFocus autoComplete="current-password"
          className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-ink" />
      </label>
      {state?.error && <p role="alert" className="text-sm text-bad">{state.error}</p>}
      <button disabled={pending} className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-60">
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
