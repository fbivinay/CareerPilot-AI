'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

const LINKS = [
  ['/', 'Overview'],
  ['/email', 'Email'],
  ['/pending', 'Pending'],
  ['/jobs', 'Jobs'],
  ['/applications', 'Applications'],
  ['/outreach', 'Outreach'],
  ['/inbox', 'Inbox'],
  ['/analytics', 'Analytics'],
  ['/settings', 'Settings'],
];
const PUBLIC = ['/login', '/about', '/privacy'];

// tristenobrien.ai's lockup (an ink tile beside the name in Archivo), with CareerPilot's own mark in the tile.
function Brand() {
  return (
    <Link href="/" className="flex shrink-0 select-none items-center gap-2.5">
      <span className="grid size-[34px] place-items-center rounded-[10px] border-[3px] border-ink bg-ink" aria-hidden="true">
        <svg viewBox="0 0 32 32" className="size-6"><path d="M9 21l7-11 7 11" fill="none" stroke="var(--cream)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <span className="flex flex-col justify-center gap-[2px] leading-none">
        <span className="font-display text-[17px] font-black tracking-[-0.03em] text-cream">CareerPilot<span className="caret" aria-hidden="true">_</span></span>
        <span className="hidden text-[10.5px] text-cream/75 sm:block">Personal job-search pipeline</span>
      </span>
    </Link>
  );
}

export function Nav() {
  const path = usePathname();
  // On a phone the links scroll sideways; keep the current page's pill in view, clear of the edge fade.
  useEffect(() => {
    document.querySelector('header [aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [path]);
  if (PUBLIC.includes(path)) return null;
  return (
    <header className="sticky top-0 z-40 border-b-[3px] border-ink bg-teal">
      <div className="mx-auto flex min-h-[66px] max-w-7xl items-center gap-4 px-4 sm:gap-6 sm:px-6">
        <Brand />
        <nav aria-label="Main" className="fade-more no-bar flex min-w-0 flex-1 items-center justify-end-safe gap-1 overflow-x-auto py-2 pr-2">
          {LINKS.map(([href, label]) => {
            const active = href === '/' ? path === '/' : path.startsWith(href);
            return (
              <Link key={href} href={href} aria-current={active ? 'page' : undefined}
                className={active ? 'btn-primary shrink-0 px-4 py-1.5 text-[14px]' : 'shrink-0 whitespace-nowrap px-3 py-2 text-[15px] font-bold text-cream transition-opacity hover:opacity-70'}>
                {label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  const path = usePathname();
  if (PUBLIC.includes(path)) return null;
  return (
    <footer className="border-t-[3px] border-ink bg-void py-12">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-6">
          <Brand />
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
            {LINKS.map(([href, label]) => (
              <Link key={href} href={href} className="text-[13.5px] font-medium text-cream/60 transition-colors hover:text-cream">{label}</Link>
            ))}
          </nav>
        </div>
        <p className="mt-8 border-t border-cream/10 pt-6 text-[13px] text-cream/60">CareerPilot is a private, single-user job-search assistant.</p>
      </div>
    </footer>
  );
}
