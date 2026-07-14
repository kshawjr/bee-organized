// app/api/slack/interactivity/route.ts
// ─────────────────────────────────────────────────────────────
// Inbound Slack interactivity endpoint — handles the "Log call" button on the
// per-location new-lead card (lib/slack-bot.ts buildLeadSlackMessage).
//
// SECURITY BOUNDARY: Slack signs every interactive payload. We verify the
// signature (HMAC-SHA256 over `v0:${ts}:${rawBody}` with SLACK_SIGNING_SECRET)
// and reject a bad/absent/stale signature with 401 — an unsigned or forged
// request must NEVER write data. A 5-minute timestamp window blocks replays.
//
// On a verified `log_call` action: resolve the clicking Slack user → hub_user
// by email (users.info via the location bot token → match hub_users.email),
// then log a CALL touchpoint through the SAME writer the in-record "Log call"
// uses (lib/touchpoints.ts logCallTouchpoint) so the row is indistinguishable.
// Unknown clicker → user_id=null (unattributed), never a failure.
//
// FAIL-SOFT: past signature verification, every error is logged loudly but the
// endpoint still returns 200 so Slack shows no broken-button error. Slack
// requires an ack within 3s; the DB write + one users.info call are well under
// that. The clicker gets an ephemeral confirmation via response_url.
//
// SLACK APP CONFIG (register once): Interactivity & Shortcuts → Request URL =
//   ${NEXT_PUBLIC_APP_URL}/api/slack/interactivity
// plus the `users:read.email` scope (reinstall to each workspace) and
// SLACK_SIGNING_SECRET in Vercel env (Production + Preview).
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { supabaseService } from '@/lib/supabase-service'
import { getSlackUserEmail } from '@/lib/slack-bot'
import { logCallTouchpoint } from '@/lib/touchpoints'

export const runtime = 'nodejs'

// ── Signature verification ────────────────────────────────────
// Reject (false) on any doubt: missing secret/headers, stale timestamp,
// length mismatch, or HMAC mismatch. timingSafeEqual guards the compare.
function verifySlackSignature(rawBody: string, timestamp: string | null, signature: string | null): boolean {
  const secret = process.env.SLACK_SIGNING_SECRET
  if (!secret || !timestamp || !signature) return false

  // Replay window: reject anything more than 5 minutes off our clock.
  const tsNum = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(tsNum)) return false
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - tsNum) > 60 * 5) return false

  const expected = 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Escape LIKE metacharacters so an email's % or _ can't turn into a wildcard.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

async function postEphemeral(responseUrl: string | undefined, text: string): Promise<void> {
  if (!responseUrl) return
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
      cache: 'no-store',
    })
  } catch (err: any) {
    console.error('[slack-interactivity] ephemeral post failed —', err?.message || err)
  }
}

// Resolve the clicker + write the call touchpoint. All fail-soft: any problem
// posts a clear ephemeral note and returns without throwing.
async function handleLogCall(args: {
  leadId: string | undefined
  slackUserId: string | undefined
  responseUrl: string | undefined
}): Promise<void> {
  const { leadId, slackUserId, responseUrl } = args
  if (!leadId) return

  // Lead → its location (for scoping + the bot token used to resolve the user).
  const { data: lead } = await supabaseService
    .from('leads')
    .select('id, location_uuid, name')
    .eq('id', leadId)
    .maybeSingle()
  if (!lead) {
    await postEphemeral(responseUrl, ':warning: Could not find that lead in Bee Hub.')
    return
  }

  const { data: loc } = await supabaseService
    .from('locations')
    .select('id, slack_bot_token, slack_connected')
    .eq('id', lead.location_uuid)
    .maybeSingle()

  // Clicker → hub_user by email (fail-soft; null = unattributed).
  let userId: string | null = null
  let who = ''
  try {
    if (loc?.slack_bot_token && slackUserId) {
      const email = await getSlackUserEmail(loc.slack_bot_token, slackUserId)
      if (email) {
        const { data: hu } = await supabaseService
          .from('hub_users')
          .select('id, full_name, first_name')
          .ilike('email', escapeLike(email))
          .maybeSingle()
        if (hu) {
          userId = hu.id
          who = hu.full_name || hu.first_name || email
        }
      }
    }
  } catch (err: any) {
    console.error('[slack-interactivity] user resolve failed —', err?.message || err)
  }

  // Reuse the EXACT in-record call logger.
  const res = await logCallTouchpoint({
    leadId: lead.id,
    locationUuid: lead.location_uuid,
    userId,
  })
  if (!res.ok) {
    console.error('[slack-interactivity] logCallTouchpoint failed —', res.error)
    await postEphemeral(responseUrl, ':warning: Could not log the call — try again from the record.')
    return
  }

  await postEphemeral(
    responseUrl,
    userId
      ? `:white_check_mark: Call logged by ${who}.`
      : ":white_check_mark: Call logged (unattributed — your Slack email isn't a Bee Hub user).",
  )
}

export async function POST(req: NextRequest) {
  // Raw body is required BEFORE any parsing — the signature is over the exact bytes.
  const rawBody = await req.text()
  const timestamp = req.headers.get('x-slack-request-timestamp')
  const signature = req.headers.get('x-slack-signature')

  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    // The security boundary: no signature, no write.
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  // Slack posts application/x-www-form-urlencoded with a single `payload` field
  // holding URL-encoded JSON.
  let payload: any
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get('payload') || '{}')
  } catch {
    // Malformed but signed — ack so Slack doesn't retry/flag it.
    return NextResponse.json({ ok: true })
  }

  try {
    const action = (payload.actions || []).find((a: any) => a?.action_id === 'log_call')
    if (action) {
      await handleLogCall({
        leadId: action.value,
        slackUserId: payload.user?.id,
        responseUrl: payload.response_url,
      })
    }
  } catch (err: any) {
    // Never surface a broken-button error to Slack — log loudly, ack cleanly.
    console.error('[slack-interactivity] handler threw —', err?.message || err)
  }

  // Always a fast, clean 200 (empty body leaves the original card intact; the
  // confirmation went out ephemerally via response_url).
  return NextResponse.json({ ok: true })
}
