// app/api/slack/callback/route.ts
// "Add to Slack" OAuth v2 callback. Supabase-primary bot-token storage.
//
// Stores the per-location BOT token + team + the channel Slack's own consent
// screen picked (incoming_webhook.channel_id/channel). No refresh token, no
// expiry: rotation is OFF, bot tokens don't expire. SKIPS the Jobber callback's
// Zoho dual-write + team-roster sync (both Jobber-specific).
//
// ── WHAT THE STATE IS NOW ───────────────────────────────────────────────────
// This route used to take the ?state= string at face value: split off the
// locationId, look it up, write a bot token onto it. The nonce half was never
// checked, so the "CSRF protection" comment on the connect route described
// something that did not happen — any workspace could be bound to any location
// whose slug an attacker could guess.
//
// The location a token is written to now comes from the SIGNED COOKIE RECORD
// minted by the connect route (lib/slack-oauth-guard), never from the state
// string. The state string must AGREE with that record, the nonce must be
// unconsumed and unexpired, and the caller must STILL be authorized for that
// location at exchange time — a role or location change between initiating and
// finishing the install is not honored.
//
// FAILS CLOSED: every unverifiable state redirects home with an error and
// reaches no write. The state cookie is cleared on EVERY response — success,
// rejection, or Slack-side error — so it is single-use by construction.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import {
  SLACK_OAUTH_STATE_COOKIE,
  authorizeSlackConnect,
  consumeSlackOAuthState,
} from '@/lib/slack-oauth-guard'

export const runtime = 'nodejs'

const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access'

// Helper: build a redirect back to BeeHub root with query params (mirrors the
// Jobber callback's ?jobber=… pattern). ALWAYS clears the state cookie — the
// record is spent the moment this route runs, whatever the outcome.
function redirectHome(request: NextRequest, params: Record<string, string>) {
  const url = new URL('/', request.url)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const res = NextResponse.redirect(url)
  res.cookies.set(SLACK_OAUTH_STATE_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/slack',
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
    return redirectHome(request, { slack: 'error', reason: oauthErr || 'denied' })
  }

  // 1. STATE — verify the signed cookie record and consume the nonce. Anything
  //    unverifiable stops here, before the location is even read.
  const verdict = consumeSlackOAuthState(
    request.cookies.get(SLACK_OAUTH_STATE_COOKIE)?.value,
    state,
  )
  if (!verdict.ok) {
    console.error('[slack-callback] state rejected —', verdict.failure)
    return redirectHome(request, { slack: 'error', reason: 'invalid_state' })
  }
  const locationUuid = verdict.locationUuid

  try {
    // 2. RE-AUTHORIZE at exchange time. The session must still be the user who
    //    started the flow, and that user must still be authorized for this
    //    location — initiation-time approval is not carried forward.
    const supabase = await createServerSupabaseClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || user.id !== verdict.userId) {
      console.error('[slack-callback] session does not match the state record')
      return redirectHome(request, { slack: 'error', reason: 'unauthorized', loc: locationUuid })
    }

    const authz = await authorizeSlackConnect(supabase, user.id, locationUuid)
    if (!authz.ok) {
      console.error('[slack-callback] caller no longer authorized —', authz.reason)
      return redirectHome(request, { slack: 'error', reason: 'forbidden', loc: locationUuid })
    }

    // 3. Verify the location still exists (source of truth). Keyed on the uuid
    //    from the SIGNED record — the state string is never a lookup key.
    const { data: supaLoc, error: supaErr } = await supabaseService
      .from('locations')
      .select('id, location_id, name')
      .eq('id', locationUuid)
      .single()

    if (supaErr || !supaLoc) {
      console.error('[slack-callback] location not found:', locationUuid, supaErr)
      return redirectHome(request, { slack: 'error', reason: 'location_not_found', loc: locationUuid })
    }

    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/slack/callback`

    // 4. Exchange the auth code for a bot token (form-encoded, like Jobber).
    const tokenRes = await fetch(SLACK_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.SLACK_CLIENT_ID!,
        client_secret: process.env.SLACK_CLIENT_SECRET!,
        redirect_uri: redirectUri,
      }),
      cache: 'no-store',
    })

    // Slack always returns JSON here, but the outcome is in the body's
    // { ok, error } — an HTTP 200 with ok:false is still a failure.
    const tokenText = await tokenRes.text()
    let payload: any
    try {
      payload = JSON.parse(tokenText)
    } catch {
      console.error('[slack-callback] token parse error:', tokenText.slice(0, 300))
      return redirectHome(request, { slack: 'error', reason: 'token_parse_failed', loc: locationUuid })
    }

    if (!payload?.ok || !payload?.access_token) {
      console.error('[slack-callback] oauth.v2.access not ok:', payload?.error || payload)
      return redirectHome(request, {
        slack: 'error',
        reason: payload?.error || 'no_access_token',
        loc: locationUuid,
      })
    }

    // 5. Pull the bot token, team, and the channel Slack's consent screen chose.
    const botToken = payload.access_token as string // xoxb-…
    const teamId = payload.team?.id ?? null
    const teamName = payload.team?.name ?? null
    const channelId = payload.incoming_webhook?.channel_id ?? null
    const channelName = payload.incoming_webhook?.channel ?? null

    // 6. Supabase write — REQUIRED (source of truth). PK-keyed on the uuid,
    //    mirroring the Jobber callback. slack_bot_token is server-only.
    const { error: writeErr } = await supabaseService
      .from('locations')
      .update({
        slack_bot_token: botToken,
        slack_team_id: teamId,
        slack_team_name: teamName,
        slack_channel_id: channelId,
        slack_channel_name: channelName,
        slack_connected: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', supaLoc.id)

    if (writeErr) {
      console.error('[slack-callback] Supabase write failed:', writeErr)
      return redirectHome(request, { slack: 'error', reason: 'supabase_write_failed', loc: locationUuid })
    }
    console.log('✓ Slack connected for', supaLoc.location_id || supaLoc.id, '→', teamName, channelName)

    return redirectHome(request, {
      slack: 'connected',
      loc: supaLoc.location_id || supaLoc.id,
      team: teamName || '',
      channel: channelName || '',
    })
  } catch (err) {
    console.error('[slack-callback] error:', err)
    return redirectHome(request, { slack: 'error', reason: 'callback_failed', loc: locationUuid })
  }
}
