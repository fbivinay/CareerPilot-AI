'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  ['/', 'Overview'],
  ['/pending', 'Pending'],
  ['/jobs', 'Jobs'],
  ['/applications', 'Applications'],
  ['/outreach', 'Outreach'],
  ['/inbox', 'Inbox'],
  ['/analytics', 'Analytics'],
  ['/settings', 'Settings'],
];

export function Nav() {
  const path = usePathname();
  if (path === '/login') return null;
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-surface/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="py-3 text-[15px] font-semibold tracking-tight">CareerPilot</Link>
        <nav className="-mb-px flex gap-1 overflow-x-auto text-sm" aria-label="Main">
          {LINKS.map(([href, label]) => {
            const active = href === '/' ? path === '/' : path.startsWith(href);
            return (
              <Link key={href} href={href} aria-current={active ? 'page' : undefined}
                className={`whitespace-nowrap border-b-2 px-2.5 py-3 ${active ? 'border-accent text-ink font-medium' : 'border-transparent text-ink-2 hover:text-ink'}`}>
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
