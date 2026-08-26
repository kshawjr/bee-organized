// app/api/cron/failure-alerts/route.ts
//
// GET /api/cron/failure-alerts — Vercel cron entrypoint, fires every ~5
// minutes (vercel.json: "*/5 * * * *" UTC). The real-time counterpart to
// the once-daily webhook digest (issue 159).
//
// Posts an instant Slack alert for an ALLOWLIST of hard failures only —
// sync_log not_landed, import_jobs failed (excluding user cancels), a
// GENUINE Jobber token expiry (reauth with no self-heal),
// ASSESSMENT_TEAM_MISMATCH breadcrumbs, stranded checkouts (issue 312),
// failed per-location Slack lead alerts, and emails held ≥6h for a blank
// subject (issue 316). See lib/failure-alerts for the allowlist rationale
// and what is deliberately NOT alerted (raw status='error' transients,
// notification_log EMAIL failures, fresh subject holds, rate/booking holds).
//
// DEDUPE. Alerts fire EXACTLY ONCE via a stored watermark (lib/alert-runs,
// same pattern as recordDigestRun): each run considers only rows created
// after the last watermark and at-or-before a settle cutoff of
// now-ALERT_SETTLE_MS, then advances the watermark. The settle gives a
// reauth failure its full self-heal window before we call it a real expiry.
// This route NEVER touches writeSyncLog — that path must stay never-throw
// and fast; this reads sync_log, it does not write it.
//
// A quiet window posts NOTHING (and still advances the watermark). Missing
// SLACK_WEBHOOK_URL is a logged 200 no-op that DOES advance the watermark
// (the channel is off — don't hoard a backlog to flood later); a genuine
// Slack error does NOT advance, so the next run retries.
//
// Auth: same convention as the digest — Vercel cron sends
// `Authorization: Bearer <CRON_SECRET>`; manual testing also accepts
// `?secret=<value>`. Missing CRON_SECRET is fail-closed (500).
//
// CRON REGISTRATION CAVEAT: Vercel crons pin to the deployment that
// registered them — after vercel.json changes land, check the Cron tab and
// Redeploy if the new schedule didn't take.

import { NextRequest, NextResponse } from 'next/server'
import { postSlackMessage } from '@/lib/slack'
import {
  collectFailureAlerts,
  buildAlertMessage,
  ALERT_SETTLE_MS,
} from '@/lib/failure-alerts'
import { fetchLastAlertWatermark, recordAlertRun } from '@/lib/alert-runs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// force-no-store on every fetch — same reason as the webhook digest: the
// static locations read (fetchLocationNames) hits a stable URL that Next's
// Data Cache would otherwise freeze across runs.
export const fetchCache = 'force-no-store'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron failure-alerts] CRON_SECRET not set; refusing to run')
    return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 500 })
  }
  const header = req.headers.get('authorization')
  const queryToken = req.nextUrl.searchParams.get('secret')
  if (header !== `Bearer ${secret}` && queryToken !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // ─── Window ────────────────────────────────────────────────────
  const nowMs = Date.now()
  const cutoffMs = nowMs - ALERT_SETTLE_MS
  const { watermark } = await fetchLastAlertWatermark()
  // First run (no watermark / pre-migration) seeds at the cutoff → the
  // window is empty, so we post nothing and never replay history as alerts.
  const sinceMs = watermark ? Date.parse(watermark) : cutoffMs

  // ─── Collect ───────────────────────────────────────────────────
  let items
  try {
    ;({ items } = await collectFailureAlerts({ nowMs, sinceMs }))
  } catch (err: any) {
    console.error('[cron failure-alerts] collect failed', err?.message || err)
    return NextResponse.json({ error: 'alert_query_failed' }, { status: 500 })
  }

  const msg = buildAlertMessage(items)
  const advancedWatermark = new Date(Math.max(sinceMs, cutoffMs)).toISOString()

  // ─── Quiet window → post nothing, still advance ────────────────
  if (!msg) {
    await recordAlertRun({ watermark: advancedWatermark, alerted: 0, posted: false })
    console.log(`[cron failure-alerts] quiet window — 0 alerts, watermark=${advancedWatermark}`)
    return NextResponse.json({ ok: true, posted: false, alerted: 0 })
  }

  // ─── Post ──────────────────────────────────────────────────────
  const post = await postSlackMessage(msg.text)
  // Advance on success or an unconfigured channel (no_webhook_url); HOLD the
  // watermark on a genuine Slack error so the next run retries these alerts.
  const advance = post.ok || post.skipped === 'no_webhook_url'
  const watermarkToStore = advance ? advancedWatermark : new Date(sinceMs).toISOString()
  await recordAlertRun({
    watermark: watermarkToStore,
    alerted: msg.count,
    posted: post.ok,
    skipped: post.skipped,
  })

  if (!post.ok && post.error) {
    return NextResponse.json(
      { error: 'slack_post_failed', detail: post.error, alerted: msg.count },
      { status: 502 },
    )
  }

  console.log(
    `[cron failure-alerts] posted=${post.ok} alerted=${msg.count} ` +
      `watermark=${watermarkToStore}${post.skipped ? ` skipped=${post.skipped}` : ''}`,
  )
  return NextResponse.json({
    ok: true,
    posted: post.ok,
    alerted: msg.count,
    ...(post.skipped ? { skipped: post.skipped } : {}),
  })
}
