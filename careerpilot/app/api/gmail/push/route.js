import { getDb } from '@/lib/db.mjs';
import { handleGmailPush } from '@/lib/gmail-oauth.mjs';

// Pub/Sub's push endpoint for Gmail's new-mail notices. Outside the dashboard sign-in (proxy.js): the secret
// token in the subscription's URL is what authenticates it.
export async function POST(request) {
  const status = await handleGmailPush(await getDb(), { token: new URL(request.url).searchParams.get('token') });
  return new Response(null, { status });
}
