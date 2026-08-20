// app/api/mailchimp/connect/route.ts
//
// Starts the Mailchimp OAuth2 flow. Called by the MailchimpCard in
// Settings → Connections. Accepts ?location_id= (uuid or slug), which is
// honored for super_admin ONLY — see lib/mailchimp-oauth-guard for why an
// admin/owner's own location is used regardless of what they send.
//
// This route is reachable by bare URL, so authorization lives HERE and is
// re-checked at token exchange. It never starts a flow it could not protect:
// a missing client id or secret is a clean error, not an unprotected redirect.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { getAuthUrl } from '@/lib/mailchimp'
import {
  mintMailchimpOAuthState,
  resolveMailchimpTarget,
  targetFailureResponse,
} from '@/lib/mailchimp-oauth-guard'

export const runtime = 'nodejs'

// Every failure lands the owner back on the Connections screen with a reason
// the card can read, rather than on a JSON blob — this is a full-page redirect
// flow, and a raw 500 in the address bar is a dead end for a non-technical user.
function backToConnections(request: NextRequest, params: Record<string, string>) {
  const url = new URL('/', request.url)
  url.searchParams.set('nav', 'settings')
  url.searchParams.set('section', 'mailchimp')
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return NextResponse.redirect(url)
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const locationParam = searchParams.get('location_id')

  // 1. Session FIRST — an anonymous caller learns nothing about this
  //    deployment's credential state or which locations exist.
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // 2. Authorize AND pick the location in one call. For admin/owner the param
  //    above is ignored entirely; only super_admin can name a location.
  const target = await resolveMailchimpTarget(supabase, user.id, locationParam)
  if (!target.ok) {
    const fail = targetFailureResponse(target.reason)
    return NextResponse.json({ error: fail.error }, { status: fail.status })
  }

  // 3. Credentials. BOTH are required: the id starts the flow, and the secret
  //    both completes the exchange AND signs the state record. Starting a flow
  //    we could not finish or protect is worse than a clean error here.
  if (!process.env.MAILCHIMP_CLIENT_ID || !process.env.MAILCHIMP_CLIENT_SECRET) {
    return backToConnections(request, { mailchimp: 'error', reason: 'no_credentials' })
  }

  // 4. Mint the signed, short-TTL state bound to this location AND this user.
  const minted = mintMailchimpOAuthState({
    locationUuid: target.locationUuid,
    userId: user.id,
  })
  if (!minted) {
    return backToConnections(request, { mailchimp: 'error', reason: 'no_credentials' })
  }

  const res = NextResponse.redirect(getAuthUrl(minted.state))
  res.cookies.set(minted.cookie.name, minted.cookie.value, minted.cookie.options)
  return res
}
