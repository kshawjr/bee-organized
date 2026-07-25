// app/api/slack/connect/route.ts
// Initiates the "Add to Slack" OAuth v2 flow. Called by the SlackCard in the
// Communications tab. Expects ?location_id=… where location_id matches the
// locations.id (UUID) or locations.location_id (slug) — same contract as the
// Jobber connect route it mirrors.
//
// Requesting the `incoming-webhook` scope makes Slack's OWN consent screen show
// the workspace's channel picker and return incoming_webhook.channel_id in the
// token exchange — so we never need a separate in-app channel-picker UI.
//
// ── AUTHORIZATION (this route is reachable by bare URL) ─────────────────────
// This used to be open: no session check, no role check. The SlackCard's
// owner-only placement in Settings was the ONLY thing standing in front of it,
// and a UI gate is not a gate — middleware.ts requires no session either (it
// only bounces disabled users). Anyone who guessed a slug could send this route
// their own Slack workspace and, via the callback, take over that location's
// lead notifications. Authorization now lives HERE, in the shared guard, and is
// re-checked at token exchange.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import {
  authorizeSlackConnect,
  mintSlackOAuthState,
  resolveSlackLocation,
} from '@/lib/slack-oauth-guard'

export const runtime = 'nodejs'

const SLACK_AUTH_URL = 'https://slack.com/oauth/v2/authorize'

// Bot scopes: chat:write to post the notification, chat:write.public so the bot
// can post to a public channel it hasn't been manually invited to (kills the
// not_in_channel step at scale), channels:read for channel metadata,
// incoming-webhook so the install picks the target channel inside Slack and
// hands back its id/name, and users:read + users:read.email so users.info can
// resolve a clicking Slack user → email for touchpoint attribution (the email
// field requires users:read.email AND users.info itself requires users:read).
const SLACK_SCOPES =
  'chat:write,chat:write.public,channels:read,incoming-webhook,users:read,users:read.email'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const locationParam = searchParams.get('location_id')

  if (!locationParam) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }

  // 1. Session FIRST — an anonymous caller learns nothing about this
  //    deployment's credential state or which locations exist.
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // 2. Resolve the param (uuid OR slug) to a real location, then authorize
  //    against the RESOLVED uuid — never against the string the caller sent.
  const loc = await resolveSlackLocation(locationParam)
  if (!loc) {
    return NextResponse.json({ error: 'location not found' }, { status: 404 })
  }

  const authz = await authorizeSlackConnect(supabase, user.id, loc.id)
  if (!authz.ok) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // 3. Credentials. Both are required: the id starts the flow, and the secret
  //    both completes the exchange AND signs the state record — starting a flow
  //    we could not finish or protect is worse than a clean error here.
  const clientId = process.env.SLACK_CLIENT_ID
  if (!clientId || !process.env.SLACK_CLIENT_SECRET) {
    const home = new URL('/', request.url)
    home.searchParams.set('slack', 'error')
    home.searchParams.set('reason', 'no_credentials')
    home.searchParams.set('loc', locationParam)
    return NextResponse.redirect(home)
  }

  // 4. Mint the state: a server-generated nonce bound to this location AND this
  //    user, signed and carried in a short-TTL httpOnly cookie the callback
  //    verifies. The ?state= string keeps its `${locationUuid}:${nonce}` shape,
  //    but the callback trusts the signed cookie record, not that string.
  const minted = mintSlackOAuthState({ locationUuid: loc.id, userId: user.id })
  if (!minted) {
    const home = new URL('/', request.url)
    home.searchParams.set('slack', 'error')
    home.searchParams.set('reason', 'no_credentials')
    home.searchParams.set('loc', locationParam)
    return NextResponse.redirect(home)
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/slack/callback`

  const params = new URLSearchParams({
    client_id: clientId,
    scope: SLACK_SCOPES,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: minted.state,
  })

  const res = NextResponse.redirect(`${SLACK_AUTH_URL}?${params.toString()}`)
  res.cookies.set(minted.cookie.name, minted.cookie.value, minted.cookie.options)
  return res
}
