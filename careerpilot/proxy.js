import { NextResponse } from 'next/server';
import { COOKIE, verifySession } from './lib/session.mjs';

// Every page and server action requires a valid session, except sign-in, the two public pages (about,
// privacy) that Google's OAuth consent screen links to, and Gmail's push endpoint, which checks its own token.
export async function proxy(request) {
  if (await verifySession(request.cookies.get(COOKIE)?.value)) return NextResponse.next();
  const url = new URL('/login', request.url);
  if (request.nextUrl.pathname !== '/') url.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!login|about|privacy|api/gmail/push|_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
