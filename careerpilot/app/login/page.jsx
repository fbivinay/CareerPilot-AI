import { LoginForm } from './form.jsx';

export const metadata = { title: 'Sign in · CareerPilot' };

export default async function LoginPage({ searchParams }) {
  const { next } = await searchParams;
  return (
    <div className="mx-auto mt-24 max-w-sm rounded-xl border border-line bg-surface p-6">
      <h1 className="text-lg font-semibold">CareerPilot</h1>
      <p className="mt-1 text-sm text-ink-2">Private dashboard. Sign in to continue.</p>
      <LoginForm next={typeof next === 'string' ? next : '/'} />
    </div>
  );
}
