import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db.mjs';
import { COOKIE, verifySession } from '@/lib/session.mjs';
import { OAUTH_COOKIE, connectionStatus, oauthClient, originFor, redirectUriFor, startAuthorization } from '@/lib/gmail-oauth.mjs';

// GET /api/gmail/connect?mode=read|send — sends the signed-in candidate to Google's consent screen.
export async function GET(request) {
  const origin = originFor(request);
  if (!(await verifySession(request.cookies.get(COOKIE)?.value))) return NextResponse.redirect(`${origin}/login`);
  const back = (code) => NextResponse.redirect(`${origin}/settings?gmail=${code}#gmail`);
  if (!oauthClient() || !process.env.APP_ENCRYPTION_KEY) return back('not-configured');

  const mode = new URL(request.url).searchParams.get('mode') === 'send' ? 'send' : 'read';
  const status = await connectionStatus(await getDb());
  // Sending is only offered once the read-only test has passed for the connected mailbox.
  if (mode === 'send' && !(status.readTest?.ok && status.readTest.email === status.email)) return back('test-first');

  const { url, cookie } = startAuthorization({ mode, redirectUri: redirectUriFor(request), loginHint: status.email });
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_COOKIE, cookie, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/api/gmail', maxAge: 600,
  });
  return res;
}
