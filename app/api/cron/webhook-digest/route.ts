// app/api/cron/webhook-digest/route.ts
//
// GET /api/cron/webhook-digest — Vercel cron entrypoint, fires every 3
// hours around the clock (vercel.json: "0 */3 * * *" UTC).
//
// Queries the last 3h of webhook sync_log activity (same enrichment as
// the admin Webhooks tab) and posts a Slack digest that LEADS with
// lead-intake health (website→Bee Hub, running in parallel with Zoho)
// and re-presents Jobber webhook sync underneath. See lib/webhook-digest
// for the classification: only leads/events that DIDN'T LAND drive the
// headline; token-race self-heals are calm background noise.
//
// SUPPRESS WHEN QUIET: if nothing landed and nothing failed in the
// window (a truly quiet window, or one whose only activity was token
// self-heals), the digest is suppressed and NOTHING is posted — a digest
// arriving should mean there was activity. Returns 200 { posted:false,
// suppressed:true } so the cron doesn't page.
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
// dashboard's Cron tab and Redeploy if the new 3h cadence didn't take.

import { NextRequest, NextResponse } from 'next/server'
import { fetchWebhookLogEvents } from '@/lib/webhook-observability'
import { buildWebhookDigest } from '@/lib/webhook-digest'
import { fetchImportHealth } from '@/lib/import-health'
import { fetchRateHealth } from '@/lib/rate-health'
import { resolveInternalOrigin, probeInternalOriginGated } from '@/lib/internal-origin'
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
    const nowMs = Date.now()
    const { events } = await fetchWebhookLogEvents({ window: '3h' })
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

    digest = buildWebhookDigest({
      events,
      appUrl,
      windowLabel: 'last 3h',
      rateHealth,
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

  // ─── Suppress a quiet / self-heal-only window ──────────────────
  // A digest arriving should mean there was activity. Nothing to say →
  // post nothing (200, not a failure).
  if (digest.suppressed) {
    console.log(
      `[cron webhook-digest] window=3h suppressed (quiet window) self_heals=${digest.selfHeals}`,
    )
    return NextResponse.json({ ok: true, posted: false, suppressed: true })
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
    `[cron webhook-digest] window=3h posted=${post.ok} allClear=${digest.allClear} ` +
      `leadsIn=${digest.leadsLanded} leadsFailed=${digest.leadsFailed} ` +
      `jobberLanded=${digest.jobberLanded} jobberDidntLand=${digest.jobberDidntLand} ` +
      `importFailed=${digest.importFailed} importStalled=${digest.importStalled} importOriginGated=${digest.importOriginGated} ` +
      `rateMissing=${digest.rateMissing} ` +
      `selfHeals=${digest.selfHeals}${post.skipped ? ` skipped=${post.skipped}` : ''}`,
  )
  return NextResponse.json({
    ok: true,
    posted: post.ok,
    ...(post.skipped ? { skipped: post.skipped } : {}),
    suppressed: false,
    allClear: digest.allClear,
    leadsLanded: digest.leadsLanded,
    leadsFailed: digest.leadsFailed,
    jobberLanded: digest.jobberLanded,
    jobberDidntLand: digest.jobberDidntLand,
    importFailed: digest.importFailed,
    importStalled: digest.importStalled,
    importOriginGated: digest.importOriginGated,
    rateMissing: digest.rateMissing,
    selfHeals: digest.selfHeals,
  })
}
