// app/api/cron/feedback-brief/route.ts
//
// GET /api/cron/feedback-brief — Vercel cron, once daily at 11:00 UTC
// (vercel.json: "0 11 * * *" — an hour behind the webhook digest, so the two
// daily Slack posts don't land in the same minute and read as one wall of text).
//
// WHAT IT POSTS. The open feedback queue, grouped by type (bugs first) and
// sorted oldest-first inside each group, with — for bugs, and for features that
// name an existing surface — where in the code the report probably lives,
// matched out of docs/screen-map.json. See lib/feedback-brief for the shape and
// lib/feedback-placement for the matching and its confidence rules.
//
// WHAT IT DOES NOT DO. It does not suggest a fix. Naming a probable file is
// cheap and reversible; proposing a change means reading the code per item,
// which is a different build with a real per-run cost. This route stops at
// "here is what is open, and here is where to look".
//
// ─── MODELLED ON /api/cron/webhook-digest ─────────────────────────────
// That route already solved every infrastructure problem this one hits, and the
// posture is copied deliberately rather than reinvented:
//
//   · CRON_SECRET fails CLOSED (500 when unset). A brief that would post the
//     whole internal backlog to anyone who guesses the URL must not run
//     unauthenticated by default.
//   · runtime='nodejs' — supabaseService needs the service key off the edge.
//   · dynamic='force-dynamic' + fetchCache='force-no-store'. The second is NOT
//     redundant: supabase-js reads go through Next's patched global fetch as
//     un-annotated GETs, so the Data Cache caches them, and force-dynamic did
//     not propagate no-store to those nested library GETs in 14.2.x. The
//     webhook digest was served frozen location data for days across
//     redeploys because of exactly this (#95). This route's read is one
//     unfiltered select on a stable URL — precisely the cacheable shape that
//     bug bites — so it needs the same guard.
//   · Suppress when quiet, and record liveness either way.
//
// ─── CRON REGISTRATION CAVEAT ─────────────────────────────────────────
// Vercel crons pin to the deployment that registered them. A NEW path in
// vercel.json is picked up when the deployment carrying it becomes Production —
// so a normal production deploy of this commit is enough. If the Cron tab does
// not list /api/cron/feedback-brief shortly after the deploy is promoted, hit
// Redeploy there; that is the known remedy for a cron pinned to an older build.

import { NextRequest, NextResponse } from 'next/server'
import { fetchFeedbackForBrief } from '@/lib/feedback-brief-data'
import { buildFeedbackBrief } from '@/lib/feedback-brief'
import { buildPlacementIndex, type ScreenMapEntry } from '@/lib/feedback-placement'
import { postSlackMessage } from '@/lib/slack'
import { recordFeedbackBriefRun } from '@/lib/digest-runs'
import screenMap from '@/docs/screen-map.json'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron feedback-brief] CRON_SECRET not set; refusing to run')
    return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 500 })
  }
  const header = req.headers.get('authorization')
  const queryToken = req.nextUrl.searchParams.get('secret')
  if (header !== `Bearer ${secret}` && queryToken !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // ─── Read + build ──────────────────────────────────────────────
  let brief
  try {
    const { items, ok, internalSupported } = await fetchFeedbackForBrief()
    if (!ok) {
      // Distinguish a failed read from a genuinely empty queue. Posting
      // "0 open" because the database hiccuped would be a lie in the one
      // direction that reads as good news.
      return NextResponse.json({ error: 'feedback_read_failed' }, { status: 500 })
    }
    if (!internalSupported) {
      console.warn('[cron feedback-brief] is_internal column absent — no row can be internal yet')
    }

    const appUrl = (
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXT_PUBLIC_SITE_URL ||
      ''
    ).replace(/\/$/, '')

    const index = buildPlacementIndex((screenMap as { entries: ScreenMapEntry[] }).entries)
    brief = buildFeedbackBrief({ items, index, appUrl })
  } catch (err: any) {
    console.error('[cron feedback-brief] build failed', err?.message || err)
    return NextResponse.json({ error: 'feedback_brief_failed' }, { status: 500 })
  }

  // ─── Suppress a quiet day ──────────────────────────────────────
  // Nothing arrived and nothing newly went quiet → post nothing. A daily
  // message that says "no change" every day trains the reader to ignore it,
  // and then it fails on the day it matters.
  if (brief.suppressed) {
    console.log(
      `[cron feedback-brief] suppressed (quiet day) open=${brief.openCount} ` +
        `new=${brief.newCount} newlyStale=${brief.newlyStaleCount}`,
    )
    await recordFeedbackBriefRun(brief, { ok: false })
    return NextResponse.json({
      ok: true,
      posted: false,
      suppressed: true,
      open: brief.openCount,
    })
  }

  // ─── Post ──────────────────────────────────────────────────────
  const post = await postSlackMessage(brief.text)
  // Record regardless of the Slack outcome — the row is the liveness proof,
  // and a post failure is itself worth capturing (posted:false).
  await recordFeedbackBriefRun(brief, { ok: post.ok, skipped: post.skipped })

  if (!post.ok && post.error) {
    return NextResponse.json(
      { error: 'slack_post_failed', detail: post.error, open: brief.openCount },
      { status: 502 },
    )
  }

  console.log(
    `[cron feedback-brief] posted=${post.ok} open=${brief.openCount} ` +
      `new=${brief.newCount} newlyStale=${brief.newlyStaleCount} internal=${brief.internalCount} ` +
      `placed=${brief.placed.confident} shortlisted=${brief.placed.possible} ` +
      `unplaced=${brief.placed.none}${post.skipped ? ` skipped=${post.skipped}` : ''}`,
  )
  return NextResponse.json({
    ok: true,
    posted: post.ok,
    ...(post.skipped ? { skipped: post.skipped } : {}),
    suppressed: false,
    open: brief.openCount,
    new: brief.newCount,
    newlyStale: brief.newlyStaleCount,
    internal: brief.internalCount,
    placed: brief.placed,
  })
}
