// app/api/cron/webhook-digest/route.ts
//
// GET /api/cron/webhook-digest — Vercel cron entrypoint, fires twice
// daily (vercel.json: "0 0,12 * * *" UTC ≈ 8am/8pm ET in summer).
//
// Queries the last 12h of webhook sync_log activity (same enrichment
// as the admin Webhooks tab) and posts a Slack digest of FAILURES
// (processing errored) + DIDN'T-LAND rows (processed but the record
// never reached its expected state). A quiet window still posts a
// short "all clear" so a dead digest is distinguishable from a quiet
// one.
//
// Auth: same convention as send-drips — Vercel cron sends
// `Authorization: Bearer <CRON_SECRET>`; manual testing also accepts
// `?secret=<value>`. Missing CRON_SECRET is fail-closed (500).
//
// Slack transport: lib/slack.ts posts to SLACK_WEBHOOK_URL. If that
// env var is missing, the run is a logged no-op returning
// { posted:false, skipped:'no_webhook_url' } — 200, not 5xx, so the
// cron doesn't page as a function failure while Slack wiring is
// pending.
//
// CRON REGISTRATION CAVEAT: Vercel crons pin to the deployment that
// registered them — after this lands, check the Vercel dashboard's
// Cron tab and Redeploy if the new cron didn't register.

import { NextRequest, NextResponse } from 'next/server'
import { fetchWebhookLogEvents } from '@/lib/webhook-observability'
import { buildWebhookDigest } from '@/lib/webhook-digest'
import { postSlackMessage } from '@/lib/slack'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron webhook-digest] CRON_SECRET not set; refusing to run')
    return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 500 })
  }
  const header = req.headers.get('authorization')
  const queryToken = req.nextUrl.searchParams.get('secret')
  if (header !== `Bearer ${secret}` && queryToken !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // ─── Query + format ────────────────────────────────────────────
  let digest
  try {
    const { events } = await fetchWebhookLogEvents({ window: '12h' })
    const appUrl = (
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      ''
    ).replace(/\/$/, '')
    digest = buildWebhookDigest({ events, appUrl, windowLabel: 'last 12h' })
  } catch (err: any) {
    console.error('[cron webhook-digest] query failed', err?.message || err)
    return NextResponse.json({ error: 'digest_query_failed' }, { status: 500 })
  }

  // ─── Post ──────────────────────────────────────────────────────
  const post = await postSlackMessage(digest.text)
  if (!post.ok && post.error) {
    // Slack itself errored (bad URL, 4xx/5xx) — surface as a failure so
    // it shows up in Vercel's cron logs.
    return NextResponse.json(
      { error: 'slack_post_failed', detail: post.error, allClear: digest.allClear },
      { status: 502 },
    )
  }

  console.log(
    `[cron webhook-digest] window=12h events=${digest.totalEvents} failures=${digest.failures} stuck=${digest.stuck} posted=${post.ok}${post.skipped ? ` skipped=${post.skipped}` : ''}`,
  )
  return NextResponse.json({
    ok: true,
    posted: post.ok,
    ...(post.skipped ? { skipped: post.skipped } : {}),
    allClear: digest.allClear,
    failures: digest.failures,
    stuck: digest.stuck,
    events: digest.totalEvents,
  })
}
