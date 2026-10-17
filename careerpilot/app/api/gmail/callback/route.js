import { NextResponse } from 'next/server';
import { audit, getDb } from '@/lib/db.mjs';
import { COOKIE, verifySession } from '@/lib/session.mjs';
import { OAUTH_COOKIE, completeAuthorization, originFor } from '@/lib/gmail-oauth.mjs';

// GET /api/gmail/callback — Google redirects here after the consent screen.
export async function GET(request) {
  const origin = originFor(request);
  if (!(await verifySession(request.cookies.get(COOKIE)?.value))) return NextResponse.redirect(`${origin}/login`);
  const params = new URL(request.url).searchParams;
  const db = await getDb();
  const result = await completeAuthorization(db, {
    query: { code: params.get('code'), state: params.get('state'), error: params.get('error') },
    cookie: request.cookies.get(OAUTH_COOKIE)?.value ?? '',
  });
  await audit(db, 'gmail', 'connection', result.ok ? 'connected' : 'connect_failed', {
    detail: result.ok ? { scopes: result.scopes } : { error: result.error },
  });
  const target = new URL(`${origin}/settings#gmail`);
  if (result.ok) target.searchParams.set('gmail', result.sendRequested ? (result.sendGranted ? 'send-enabled' : 'send-declined') : 'connected');
  else target.searchParams.set('gmail_error', result.error);
  const res = NextResponse.redirect(target);
  res.cookies.set(OAUTH_COOKIE, '', { httpOnly: true, path: '/api/gmail', maxAge: 0 });
  return res;
}
