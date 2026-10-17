import { NextResponse } from 'next/server';
import { COOKIE, verifySession } from './lib/session.mjs';

// Every page and server action requires a valid session, except the login page itself.
export async function proxy(request) {
  if (await verifySession(request.cookies.get(COOKIE)?.value)) return NextResponse.next();
  const url = new URL('/login', request.url);
  if (request.nextUrl.pathname !== '/') url.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!login|_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
