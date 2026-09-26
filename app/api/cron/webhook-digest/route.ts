// app/api/cron/webhook-digest/route.ts
//
// GET /api/cron/webhook-digest — Vercel cron entrypoint, fires once daily
// at 10:00 UTC (vercel.json: "0 10 * * *" — 6am EDT / 5am EST; the DST
// drift is accepted, no timezone gate). Real-time failures are covered
// separately by the ~5-minute watermark cron (app/api/cron/failure-alerts,
// issue 159); this digest is the once-a-day rundown.
//
// Reports ONLY what Kevin should know about but that is not an emergency:
// Jobber changes that never landed after their retries, and things that are
// STUCK (stalled imports, sends held for a missing rate or booking link,
// locations still disconnected from Jobber). See lib/webhook-digest for the
// rule and for what is deliberately never a line.
//
// SILENT WHEN EVERY COUNT IS ZERO: no "all healthy" message, ever. Returns
// 200 { posted:false, suppressed:true } and still writes the heartbeat row,
// so a quiet day and a dead cron stay distinguishable in System health.
//
// Auth: same convention as send-drips — Vercel cron sends
// `Authorization: Bearer <CRON_SECRET>`; manual testing also accepts
// `?secret=<value>`. Missing CRON_SECRET is fail-closed (500).
//
// Slack transport: lib/slack.ts posts to SLACK_WEBHOOK_URL (unchanged
// destination). If that env var is missing, the run is a logged no-op
// returning { posted:false, skipped:'no_webhook_url' } — 200, not 5xx,
// so the cron doesn't page as a function failure while Slack wiring is
// pending.
//
// CRON REGISTRATION CAVEAT: Vercel crons pin to the deployment that
// registered them — after this schedule change lands, check the Vercel
// dashboard's Cron tab and Redeploy if the new daily cadence didn't take.

import { NextRequest, NextResponse } from 'next/server'
import { fetchWebhookLogEvents } from '@/lib/webhook-observability'
import { buildWebhookDigest } from '@/lib/webhook-digest'
import { fetchImportHealth } from '@/lib/import-health'
import { fetchRateHealth } from '@/lib/rate-health'
import { fetchBookingLinkHealth } from '@/lib/booking-link-health'
import { resolveInternalOrigin, probeInternalOriginGated } from '@/lib/internal-origin'
import { postSlackMessage } from '@/lib/slack'
import { recordDigestRun } from '@/lib/digest-runs'
import { supabaseService } from '@/lib/supabase-service'
import { parseReconnectStamp } from '@/lib/jobber-reconnect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// force-no-store on EVERY fetch in this route. supabase-js reads go through the
// Next-patched global fetch as un-annotated GETs (no cache option — see
// @supabase/postgrest-js), so Next's Data Cache caches them. Time-windowed reads
// (webhook events, created_at>=now-24h) dodge it — their URL changes each run — but
// the STATIC reads (rate-health, booking-link-health: `locations` on a constant
// predicate) hit a stable URL and were served frozen for days, across redeploys,
// with no revalidate to expire them: the digest kept naming locations whose rate
// was long since set (#95). `dynamic='force-dynamic'` recomputes the route but did
// not propagate no-store to these nested library GETs in 14.2.3; fetchCache does.
export const fetchCache = 'force-no-store'
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
    const nowMs = Date.now()
    const { events } = await fetchWebhookLogEvents({ window: '24h' })
    const appUrl = (
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      ''
    ).replace(/\/$/, '')

    // Import health (item 2): failed + stalled jobs in the window. Best-effort
    // — a hiccup reading import_jobs must not take down the webhook digest, so
    // degrade to empty rather than failing the whole run.
    let importJobs: Awaited<ReturnType<typeof fetchImportHealth>> = { failed: [], stalled: [], bounced: [] }
    try {
      importJobs = await fetchImportHealth({ nowMs })
    } catch (err: any) {
      console.error('[cron webhook-digest] import health query failed (non-fatal)', err?.message || err)
    }

    // Origin health assertion (item 3): probe the SAME non-SSO origin the
    // sweeper / self-chain use. If it's SSO-gated, every import self-resume
    // bounces — escalate that into the digest instead of a silent warn.
    // probeInternalOriginGated swallows its own errors (returns null).
    const internalOrigin = resolveInternalOrigin(req.nextUrl.origin)
    const originGated = await probeInternalOriginGated(internalOrigin)
    if (originGated === true) {
      console.error(`[cron webhook-digest] internal re-poke origin is SSO-GATED (${internalOrigin}) — imports cannot self-resume`)
    }

    // Blank-rate hold rollup: active locations on rate-quoting default
    // paths (-a/-b) with no rate_per_hour — their sends are HELD by
    // lib/rate-guard. fetchRateHealth never throws (degrades to empty).
    const rateHealth = await fetchRateHealth()

    // Missing-booking-link rollup: active locations on booking default paths
    // (-b/-d) with no calendar_link — their booking sends are HELD by
    // lib/booking-link. Also never throws (degrades to empty).
    const bookingLinkHealth = await fetchBookingLinkHealth()

    // Locations still waiting on a Jobber reconnect (the instant rail alerted
    // when they were stamped; this is the daily "still broken"). Best-effort:
    // a failed read degrades to none rather than killing the digest.
    let reconnectLocations: Array<{ location_id: string; name: string | null }> = []
    try {
      const { data } = await supabaseService
        .from('locations')
        .select('location_id, name, last_sync_status')
      reconnectLocations = ((data as any[]) || [])
        .filter(l => parseReconnectStamp(l.last_sync_status) != null)
        .map(l => ({ location_id: l.location_id, name: l.name ?? null }))
    } catch (err: any) {
      console.error('[cron webhook-digest] reconnect read failed (non-fatal)', err?.message || err)
    }

    digest = buildWebhookDigest({
      events,
      appUrl,
      windowLabel: 'last 24h',
      nowMs,
      rateHealth,
      reconnect: { locations: reconnectLocations },
      bookingLinkHealth,
      importHealth: {
        failed: importJobs.failed,
        stalled: importJobs.stalled,
        bounced: importJobs.bounced,
        originGated,
        originTarget: internalOrigin,
        nowMs,
      },
    })
  } catch (err: any) {
    console.error('[cron webhook-digest] query failed', err?.message || err)
    return NextResponse.json({ error: 'digest_query_failed' }, { status: 500 })
  }

  // ─── Silent when every count is zero ───────────────────────────
  // A digest arriving should mean something needs a look. Nothing to say →
  // post nothing (200, not a failure).
  if (digest.suppressed) {
    console.log(
      `[cron webhook-digest] window=24h suppressed (nothing to report) leadsIn=${digest.leadsLanded} ` +
        `jobberLanded=${digest.jobberLanded} recovered=${digest.selfHeals}`,
    )
    // Persist the heartbeat even when nothing is posted — a quiet window is
    // still proof the cron is alive. Fail-soft (never throws, no-ops
    // pre-migration).
    await recordDigestRun(digest, { ok: false })
    return NextResponse.json({ ok: true, posted: false, suppressed: true })
  }

  // ─── Post ──────────────────────────────────────────────────────
  const post = await postSlackMessage(digest.text)
  // Record the run regardless of the Slack outcome — the row is the liveness
  // proof, and a post failure is itself worth capturing (posted:false).
  await recordDigestRun(digest, { ok: post.ok, skipped: post.skipped })
  if (!post.ok && post.error) {
    // Slack itself errored (bad URL, 4xx/5xx) — surface as a failure so
    // it shows up in Vercel's cron logs.
    return NextResponse.json(
      { error: 'slack_post_failed', detail: post.error },
      { status: 502 },
    )
  }

  console.log(
    `[cron webhook-digest] window=24h posted=${post.ok} neverLanded=${digest.neverLanded} ` +
      `reconnectRequired=${digest.reconnectRequired} ` +
      `importFailed=${digest.importFailed} importStalled=${digest.importStalled} importOriginGated=${digest.importOriginGated} ` +
      `rateMissing=${digest.rateMissing} bookingLinkMissing=${digest.bookingLinkMissing} ` +
      `recovered=${digest.selfHeals}${post.skipped ? ` skipped=${post.skipped}` : ''}`,
  )
  return NextResponse.json({
    ok: true,
    posted: post.ok,
    ...(post.skipped ? { skipped: post.skipped } : {}),
    suppressed: false,
    neverLanded: digest.neverLanded,
    reconnectRequired: digest.reconnectRequired,
    importStalled: digest.importStalled,
    importOriginGated: digest.importOriginGated,
    rateMissing: digest.rateMissing,
    bookingLinkMissing: digest.bookingLinkMissing,
  })
}
