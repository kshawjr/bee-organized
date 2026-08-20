// app/api/mailchimp/callback/route.ts
//
// Mailchimp OAuth2 callback. Stores the per-location access token + server
// prefix + account name, and flips mailchimp_connected true.
//
// ── WHAT THIS ROUTE DELIBERATELY DOES NOT DO ────────────────────────────────
// It does not pick an audience, and it does not touch mailchimp_sync_live.
// A freshly connected location lands with mailchimp_list_id NULL and
// mailchimp_sync_live FALSE, which is the "connected but not finished setting
// up" state the card renders. sync_live is the fail-closed gate Kevin turns on
// per location by hand, the same as notifications_live — nothing in the owner
// UI reads or writes it.
//
// ── METADATA FAILURE IS FATAL, AND THAT IS THE POINT ────────────────────────
// The token is useless without the server prefix: Mailchimp shards accounts
// across data centres and the prefix IS the API host. If metadata fails we
// store NOTHING — not the token, not the connected flag. A half-write here
// would produce a row that reads "connected" in the UI and 404s on every call
// it will ever make, which is strictly worse than a clean error the owner can
// act on by pressing Connect again.
//
// ── THE LOCATION COMES FROM THE SIGNED COOKIE, NEVER THE STATE STRING ───────
// See lib/mailchimp-oauth-guard. The state string must agree with the signed
// record, the nonce must be unconsumed and unexpired, and the caller must STILL
// be authorized for that location at exchange time. FAILS CLOSED: every
// unverifiable state reaches no write. The state cookie is cleared on EVERY
// response — success, rejection, or Mailchimp-side error — so it is single-use
// by construction.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { exchangeCode, getMetadata } from '@/lib/mailchimp'
import {
  MAILCHIMP_OAUTH_STATE_COOKIE,
  consumeMailchimpOAuthState,
  resolveMailchimpTarget,
} from '@/lib/mailchimp-oauth-guard'

export const runtime = 'nodejs'

// ALWAYS clears the state cookie — the record is spent the moment this route
// runs, whatever the outcome.
function backToConnections(request: NextRequest, params: Record<string, string>) {
  const url = new URL('/', request.url)
  url.searchParams.set('nav', 'settings')
  url.searchParams.set('section', 'mailchimp')
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const res = NextResponse.redirect(url)
  res.cookies.set(MAILCHIMP_OAUTH_STATE_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/mailchimp',
    maxAge: 0,
  })
  return res
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const oauthErr = searchParams.get('error')

  if (oauthErr || !code || !state) {
    return backToConnections(request, { mailchimp: 'error', reason: oauthErr || 'denied' })
  }

  // 1. STATE — verify the signed cookie record and consume the nonce. Anything
  //    unverifiable stops here, before the location is even read.
  const verdict = consumeMailchimpOAuthState(
    request.cookies.get(MAILCHIMP_OAUTH_STATE_COOKIE)?.value,
    state,
  )
  if (!verdict.ok) {
    console.error('[mailchimp-callback] state rejected —', verdict.failure)
    return backToConnections(request, { mailchimp: 'error', reason: 'invalid_state' })
  }
  const locationUuid = verdict.locationUuid

  try {
    // 2. RE-AUTHORIZE at exchange time. The session must still be the user who
    //    started the flow, and that user must still resolve to THIS location —
    //    initiation-time approval is not carried forward.
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || user.id !== verdict.userId) {
      console.error('[mailchimp-callback] session does not match the state record')
      return backToConnections(request, { mailchimp: 'error', reason: 'unauthorized' })
    }

    // Re-resolved through the same rule the connect route used, then required
    // to land on the SAME location. For an owner this re-derives their own
    // location; for a super_admin the signed record supplies the target.
    const target = await resolveMailchimpTarget(supabase, user.id, locationUuid)
    if (!target.ok || target.locationUuid !== locationUuid) {
      console.error('[mailchimp-callback] caller no longer authorized for', locationUuid)
      return backToConnections(request, { mailchimp: 'error', reason: 'forbidden' })
    }

    // 3. Confirm the location still exists (source of truth), keyed on the uuid
    //    from the SIGNED record — the state string is never a lookup key.
    const { data: loc, error: locErr } = await supabaseService
      .from('locations')
      .select('id, location_id, name')
      .eq('id', locationUuid)
      .maybeSingle()
    if (locErr || !loc) {
      console.error('[mailchimp-callback] location not found:', locationUuid, locErr)
      return backToConnections(request, { mailchimp: 'error', reason: 'location_not_found' })
    }

    // 4. Exchange the code for an access token. No refresh token comes back and
    //    none is expected — Mailchimp tokens do not expire (see lib/mailchimp).
    const token = await exchangeCode(code)
    if (!token.ok) {
      console.error('[mailchimp-callback] token exchange failed —', token.error)
      return backToConnections(request, { mailchimp: 'error', reason: 'token_exchange_failed' })
    }

    // 5. Metadata IMMEDIATELY, and before any write. A token without its server
    //    prefix cannot address the API at all — so this failing means we store
    //    nothing and say so, rather than persisting a connection that is dead
    //    on arrival.
    const meta = await getMetadata(token.accessToken)
    if (!meta.ok) {
      console.error('[mailchimp-callback] metadata failed —', meta.error, '— nothing stored')
      return backToConnections(request, { mailchimp: 'error', reason: 'metadata_failed' })
    }

    // 6. ONE write, with the prefix and the token together. mailchimp_list_id
    //    stays NULL (the owner picks an audience next) and mailchimp_sync_live
    //    stays FALSE — neither is set here, and sync_live is never set by any
    //    owner-reachable route.
    const { error: writeErr } = await supabaseService
      .from('locations')
      .update({
        mailchimp_access_token: token.accessToken,
        mailchimp_server_prefix: meta.dc,
        mailchimp_account_name: meta.accountName || null,
        mailchimp_connected: true,
        mailchimp_connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', loc.id)

    if (writeErr) {
      console.error('[mailchimp-callback] Supabase write failed:', writeErr)
      return backToConnections(request, { mailchimp: 'error', reason: 'supabase_write_failed' })
    }

    console.log('✓ Mailchimp connected for', loc.location_id || loc.id, '→', meta.accountName, `(${meta.dc})`)
    return backToConnections(request, { mailchimp: 'connected' })
  } catch (err) {
    console.error('[mailchimp-callback] error:', err)
    return backToConnections(request, { mailchimp: 'error', reason: 'callback_failed' })
  }
}
