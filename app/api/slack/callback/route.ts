// app/api/slack/callback/route.ts
// "Add to Slack" OAuth v2 callback. Supabase-primary bot-token storage.
// Accepts state in the form "<locationId>:<nonce>" where locationId can be
// either locations.id (UUID) or locations.location_id (slug) — same association
// mechanism as the Jobber callback it mirrors.
//
// Stores the per-location BOT token + team + the channel Slack's own consent
// screen picked (incoming_webhook.channel_id/channel). No refresh token, no
// expiry: rotation is OFF, bot tokens don't expire. SKIPS the Jobber callback's
// Zoho dual-write + team-roster sync (both Jobber-specific).

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'

const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Helper: build a redirect back to BeeHub root with query params (mirrors the
// Jobber callback's ?jobber=… pattern).
function redirectHome(request: NextRequest, params: Record<string, string>) {
  const url = new URL('/', request.url)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return NextResponse.redirect(url)
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const oauthErr = searchParams.get('error')

  if (oauthErr || !code || !state) {
    return redirectHome(request, { slack: 'error', reason: oauthErr || 'denied' })
  }

  const locationId = state.split(':')[0]
  const isUuid = UUID_RE.test(locationId)
  const lookupField = isUuid ? 'id' : 'location_id'

  try {
    // 1. Verify the location exists in Supabase (source of truth).
    const { data: supaLoc, error: supaErr } = await supabaseService
      .from('locations')
      .select('id, location_id, name')
      .eq(lookupField, locationId)
      .single()

    if (supaErr || !supaLoc) {
      console.error('[slack-callback] location not found:', locationId, supaErr)
      return redirectHome(request, { slack: 'error', reason: 'location_not_found', loc: locationId })
    }

    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/slack/callback`

    // 2. Exchange the auth code for a bot token (form-encoded, like Jobber).
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
      return redirectHome(request, { slack: 'error', reason: 'token_parse_failed', loc: locationId })
    }

    if (!payload?.ok || !payload?.access_token) {
      console.error('[slack-callback] oauth.v2.access not ok:', payload?.error || payload)
      return redirectHome(request, {
        slack: 'error',
        reason: payload?.error || 'no_access_token',
        loc: locationId,
      })
    }

    // 3. Pull the bot token, team, and the channel Slack's consent screen chose.
    const botToken = payload.access_token as string // xoxb-…
    const teamId = payload.team?.id ?? null
    const teamName = payload.team?.name ?? null
    const channelId = payload.incoming_webhook?.channel_id ?? null
    const channelName = payload.incoming_webhook?.channel ?? null

    // 4. Supabase write — REQUIRED (source of truth). PK-keyed on the uuid,
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
      return redirectHome(request, { slack: 'error', reason: 'supabase_write_failed', loc: locationId })
    }
    console.log('✓ Slack connected for', supaLoc.location_id || supaLoc.id, '→', teamName, channelName)

    return redirectHome(request, {
      slack: 'connected',
      loc: locationId,
      team: teamName || '',
      channel: channelName || '',
    })
  } catch (err) {
    console.error('[slack-callback] error:', err)
    return redirectHome(request, { slack: 'error', reason: 'callback_failed', loc: locationId })
  }
}
