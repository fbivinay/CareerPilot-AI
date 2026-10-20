import { LoginForm } from './form.jsx';

export const metadata = { title: 'Sign in · CareerPilot' };

export default async function LoginPage({ searchParams }) {
  const { next } = await searchParams;
  return (
    <div className="card mx-auto mt-16 max-w-md p-7 sm:p-9">
      <span className="badge">Private dashboard</span>
      <h1 className="h2 mt-5"><span className="d-line"><span>CareerPilot</span></span></h1>
      <p className="mt-2 text-ink-2">Sign in to continue.</p>
      <LoginForm next={typeof next === 'string' ? next : '/'} />
    </div>
  );
}
