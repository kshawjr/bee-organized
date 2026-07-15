// app/api/slack/connect/route.ts
// Initiates the "Add to Slack" OAuth v2 flow. Called by the SlackCard in the
// Communications tab. Expects ?location_id=… where location_id matches the
// locations.id (UUID) or locations.location_id (slug) — same contract as the
// Jobber connect route it mirrors.
//
// Requesting the `incoming-webhook` scope makes Slack's OWN consent screen show
// the workspace's channel picker and return incoming_webhook.channel_id in the
// token exchange — so we never need a separate in-app channel-picker UI.

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

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
  const locationId = searchParams.get('location_id')

  if (!locationId) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }

  const clientId = process.env.SLACK_CLIENT_ID

  if (!clientId) {
    const home = new URL('/', request.url)
    home.searchParams.set('slack', 'error')
    home.searchParams.set('reason', 'no_credentials')
    home.searchParams.set('loc', locationId)
    return NextResponse.redirect(home)
  }

  // State includes locationId + random nonce for CSRF protection — the callback
  // recovers the locationId from state to bind the token to the right location
  // (identical association mechanism to the Jobber flow).
  const state = `${locationId}:${crypto.randomBytes(16).toString('hex')}`
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/slack/callback`

  const params = new URLSearchParams({
    client_id: clientId,
    scope: SLACK_SCOPES,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
  })

  return NextResponse.redirect(`${SLACK_AUTH_URL}?${params.toString()}`)
}
