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

// ── What "Add to Slack" asks each workspace for ──────────────
// Slack fixes a workspace's permissions at install: adding one later means
// every location reconnects again (there are 44). So this list is decided as
// a whole, it must match Bot Token Scopes in the Slack app's own settings,
// and the callback records what each install was actually granted in
// locations.slack_scopes (lib/slack-scopes.ts).
//
// IN USE
//   chat:write          post the new-lead notice and the job card
//   chat:write.public   …to a public channel the app was never invited to
//   channels:read       channel names and ids
//   incoming-webhook    makes Slack's own screen ask which channel leads go
//                       to, and hands back its id and name
//   users:read          who clicked a button on a lead card
//   users:read.email    …and their email, to match them to a Bee Hub user;
//                       also finds a bee in Slack by email
//   channels:manage     job channels: make, invite, remove, archive,
//                       unarchive. PUBLIC channels only
//   pins:write          pin the job card (lib/job-channel-card.ts). A
//                       location that connected before this was asked for
//                       gets its cards posted and simply not pinned
//
// REQUESTED ON PURPOSE, NOT USED YET — DO NOT DELETE AS DEAD.
// Kevin approved each in the Slack app's settings on 2026-11-12, ahead of
// asking 43 owners to reconnect once. Taking one out here means that when it
// is wanted, all of them reconnect again.
//   groups:write        make and manage PRIVATE channels. Job channels are
//                       public today and the job card puts a client's home
//                       address in them. If that ever becomes a problem,
//                       private channels are the fix, and this is the
//                       permission they need
//   pins:read           see what is pinned in a channel (to find or replace
//                       the job card later). The card does not need it yet
//   channels:join       join a public channel someone made by hand, so a
//                       job can adopt it
//   bookmarks:write     put an "Open in Bee Hub" link in a channel's header
//   files:write         post a file — a quote, photos
//   reactions:write     mark a message, e.g. tick the card when a job is done
//   commands            (added to this list 2026-11-13, after Kevin added it
//                       in the Slack app's settings) a slash command and a
//                       message shortcut, so a ZB can file a ticket from
//                       Slack without Bee Hub ever reading their channels:
//                       Slack hands over only what the person typed, or the
//                       one message they chose. Nothing uses it yet — no
//                       command or shortcut is built
//
// DELIBERATELY NOT REQUESTED: channels:history. It would let the app read
// every message in every public channel of a franchise's workspace. Their
// Slack is theirs (Kevin's standing rule), and it would make the approval
// screen 43 owners see look far more invasive than anything here needs.
// Nothing may be built that needs it. lib/beta-slack-scope-list.test.ts
// fails if it, or any other "read their messages" permission, appears.
const SLACK_SCOPES = [
  'chat:write', 'chat:write.public', 'channels:read', 'channels:manage', 'incoming-webhook', 'users:read', 'users:read.email',
  'pins:write', 'pins:read', 'channels:join', 'bookmarks:write', 'files:write', 'reactions:write', 'groups:write',
  'commands',
].join(',')

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
