// app/api/cron/failure-alerts/route.ts
//
// GET /api/cron/failure-alerts — Vercel cron entrypoint, fires every ~5
// minutes (vercel.json: "*/5 * * * *" UTC). The real-time counterpart to
// the once-daily webhook digest (issue 159).
//
// Posts one Slack message PER PROBLEM for an allowlist of things only Kevin
// can fix — a website lead that never arrived, an owner's bug report or
// question, a Jobber connection that needs reconnecting, a failed import, an
// assessment-team mismatch, a stranded checkout (issue 312), and an email
// held ≥6h for a blank subject (issue 316). See lib/failure-alerts for the
// allowlist and what is deliberately NEVER alerted (individual token
// failures, Slack lead-alert failures on an owner's channel, raw transients).
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
// (the channel is off — don't hoard a backlog to flood later). Messages post
// in order; a genuine Slack error stops the run and the watermark advances
// only past what was actually posted, so the next run retries the rest and
// never repeats what already went out.
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
  buildAlertMessages,
  watermarkAfterPosting,
  ALERT_SETTLE_MS,
  type AlertItem,
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
  const appUrl = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    ''
  ).replace(/\/$/, '')
  let items
  try {
    ;({ items } = await collectFailureAlerts({ nowMs, sinceMs, appUrl }))
  } catch (err: any) {
    console.error('[cron failure-alerts] collect failed', err?.message || err)
    return NextResponse.json({ error: 'alert_query_failed' }, { status: 500 })
  }

  const messages = buildAlertMessages(items)

  // ─── Quiet window → post nothing, still advance ────────────────
  if (messages.length === 0) {
    const advanced = new Date(Math.max(sinceMs, cutoffMs)).toISOString()
    await recordAlertRun({ watermark: advanced, alerted: 0, posted: false })
    console.log(`[cron failure-alerts] quiet window — 0 alerts, watermark=${advanced}`)
    return NextResponse.json({ ok: true, posted: false, alerted: 0 })
  }

  // ─── Post, one message per problem ─────────────────────────────
  const posted: AlertItem[] = []
  let skipped: string | undefined
  let error: string | undefined
  for (const m of messages) {
    const post = await postSlackMessage(m.text)
    if (post.ok) {
      posted.push(...m.items)
      continue
    }
    if (post.skipped === 'no_webhook_url') {
      // The channel is off: treat everything as delivered rather than hoard a
      // backlog that would flood the channel the day it is switched on.
      skipped = post.skipped
      posted.push(...messages.flatMap(x => x.items).filter(i => !posted.includes(i)))
      break
    }
    error = post.error || 'slack_post_failed'
    break
  }
  const unposted = items.filter(i => !posted.includes(i))
  const watermarkToStore = new Date(
    watermarkAfterPosting({ sinceMs, cutoffMs, posted, unposted }),
  ).toISOString()
  await recordAlertRun({
    watermark: watermarkToStore,
    alerted: posted.length,
    posted: !skipped && posted.length > 0,
    skipped,
  })

  if (error) {
    return NextResponse.json(
      { error: 'slack_post_failed', detail: error, alerted: posted.length, pending: unposted.length },
      { status: 502 },
    )
  }

  console.log(
    `[cron failure-alerts] messages=${messages.length} alerted=${posted.length} ` +
      `watermark=${watermarkToStore}${skipped ? ` skipped=${skipped}` : ''}`,
  )
  return NextResponse.json({
    ok: true,
    posted: !skipped,
    alerted: posted.length,
    messages: messages.length,
    ...(skipped ? { skipped } : {}),
  })
}
