'use client';
import { useActionState } from 'react';
import { login } from '../actions.js';

export function LoginForm({ next }) {
  const [state, action, pending] = useActionState(login, null);
  return (
    <form action={action} className="mt-6 space-y-4">
      <input type="hidden" name="next" value={next} />
      <label className="block">
        <span className="kicker pl-1 text-ink-2">Password</span>
        <input type="password" name="password" required autoFocus autoComplete="current-password"
          className="field mt-1.5 w-full border-[3px] px-5 py-[13px] text-base font-semibold" />
      </label>
      {state?.error && <p role="alert" className="text-sm font-medium text-bad">{state.error}</p>}
      <button disabled={pending} className="btn-primary w-full px-7 py-[13px] text-base">
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
