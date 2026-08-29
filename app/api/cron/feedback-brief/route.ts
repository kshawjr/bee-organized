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
// issue 309 — Slack carries NEWS, not work. The full brief is no longer posted;
// buildFeedbackBrief still runs because its counts and its suppression decision
// drive the nudge, and issue 307 builds on the matcher underneath it.
import { buildNudge, buildAlert } from '@/lib/feedback-nudge'
// The one wired alert of the three built in feedback-nudge: answers nobody has
// read. The decision (thresholds, fire-once rules) lives in feedback-unopened;
// this route owns only the state reads, the post, and the record.
import { decideUnopenedAlert } from '@/lib/feedback-unopened'
import { recordFeedbackBriefRun, fetchFeedbackAlertState, recordFeedbackUnopenedRun } from '@/lib/digest-runs'
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
  // Hoisted alongside `brief`: the nudge below needs appUrl outside the try,
  // and the unopened-reply alert needs the raw items.
  let appUrl = ''
  let briefItems: Awaited<ReturnType<typeof fetchFeedbackForBrief>>['items'] = []
  try {
    const { items, ok, internalSupported } = await fetchFeedbackForBrief()
    briefItems = items
    if (!ok) {
      // Distinguish a failed read from a genuinely empty queue. Posting
      // "0 open" because the database hiccuped would be a lie in the one
      // direction that reads as good news.
      return NextResponse.json({ error: 'feedback_read_failed' }, { status: 500 })
    }
    if (!internalSupported) {
      console.warn('[cron feedback-brief] is_internal column absent — no row can be internal yet')
    }

    appUrl = (
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

  // ─── THE UNOPENED-REPLY ALERT ──────────────────────────────────
  // Runs on EVERY authorized run, BEFORE the quiet-day suppression below —
  // deliberately. The brief's suppression asks "did anything arrive or newly
  // go quiet?", and an unread three-week-old answer is precisely the thing
  // that happens on days when nothing else does. Its own fire-once rules live
  // in lib/feedback-unopened; a failure here never takes the brief down.
  try {
    const state = await fetchFeedbackAlertState()
    const decision = decideUnopenedAlert({
      items: briefItems,
      lastCheckedAt: state.lastBriefRunAt,
      alertedBefore: state.unopenedAlertedBefore,
    })
    if (decision.event) {
      const alertPost = buildAlert(decision.event, `${appUrl}/?feedback=1`)
      if (alertPost) {
        const sent = await postSlackMessage(alertPost.text, alertPost.attachments)
        await recordFeedbackUnopenedRun(
          { ok: sent.ok, skipped: sent.skipped },
          alertPost.attachments[0]?.text || alertPost.text,
        )
        console.log(
          `[cron feedback-brief] unopened-reply alert posted=${sent.ok} ` +
            `count=${decision.count} crossed=${decision.crossedCount} (${decision.reason})` +
            `${sent.skipped ? ` skipped=${sent.skipped}` : ''}`,
        )
      }
    } else {
      console.log(`[cron feedback-brief] unopened-reply alert: ${decision.reason} (count=${decision.count})`)
    }
  } catch (err: any) {
    console.error('[cron feedback-brief] unopened-reply alert failed (non-fatal)', err?.message || err)
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

  // ─── Post the NUDGE, not the brief (issue 309) ─────────────────
  // What used to go out here was the whole open list with per-item analysis.
  // The verdict on it was "feels busy", then "I don't want it in Slack, that
  // will just be a massive message" — and that is right: a wall of items is a
  // message you scroll past, and two weeks of scrolling past is a message you
  // have stopped reading, which is worse than none.
  //
  // NOTHING WAS DELETED. brief is still built above: its counts feed the nudge,
  // its suppression decision still governs whether anything posts at all, and
  // brief.text is still produced and still tested — it is simply no longer what
  // gets sent. The triage screen (issues 306-308) is where the work happens.
  const nudge = buildNudge({
    summary: brief.summary,
    oldestNewDays: brief.summary.oldestNewDays,
    triageUrl: `${appUrl}/?feedback=1`,
  })
  if (nudge.suppressed || !nudge.post) {
    console.log(`[cron feedback-brief] nudge suppressed (${nudge.reason || 'nothing to say'})`)
    await recordFeedbackBriefRun(brief, { ok: false })
    return NextResponse.json({ ok: true, posted: false, suppressed: true, open: brief.openCount })
  }
  const post = await postSlackMessage(nudge.post.text, nudge.post.attachments)
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
