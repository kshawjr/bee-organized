// app/api/cron/sync-log-purge/route.ts
//
// GET /api/cron/sync-log-purge — Vercel cron entrypoint, fires daily
// (vercel.json: "0 8 * * *" UTC).
//
// sync_log has no retention: every webhook/import/intake/engagement
// breadcrumb persists forever (16k rows and climbing; #110 scout). #110a
// stopped NEW customer PII entering the table; this is the other half —
// a rolling 90-day window that ages out old rows (including the ~3,549
// pre-#110a rows that still carry a client name in `message`).
//
// WHY 90 DAYS: 3× the widest real read. Nothing reads sync_log beyond 30
// days — digest cron 3h, import-health 3h, system-health 24h, admin
// Webhooks tab 7d default; even window=all is hard-capped at the 1000
// most-recent rows (webhook-observability FETCH_CAP). A 90-day purge
// cannot starve any reader.
//
// ─── SAFETY: DRY-RUN BY DEFAULT ────────────────────────────────────
// THIS DELETES PRODUCTION DATA. It deletes NOTHING until live mode is
// explicitly turned on, so Kevin reviews a real would-delete count first:
//   • env  SYNC_LOG_PURGE_ENABLED=true   → the scheduled cron goes live
//   • query ?execute=true                → one-off manual live run
// Absent both, every run is a dry run: it reports what it WOULD delete
// (count + oldest/newest timestamp) and removes nothing. SHIPPED dry-run;
// do not set the env var until a dry-run count has been reviewed.
//
// Idempotent + safe to re-run: deletes rows older than a rolling cutoff,
// in bounded batches (never one unbounded statement — the first live run
// faces ~100 days of accumulation), never touches rows inside the window.
//
// Auth: same convention as send-drips — Vercel cron sends
// `Authorization: Bearer <CRON_SECRET>`; manual testing also accepts
// `?secret=<value>`. Missing CRON_SECRET is fail-closed (500).
//
// CRON REGISTRATION CAVEAT: Vercel crons pin to the deployment that
// registered them — after adding this schedule to vercel.json, check the
// Vercel dashboard's Cron tab and Redeploy if the daily job didn't take.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// force-no-store so the count/scan reads run live, never a frozen Data
// Cache (the #95/#96 class of bug). The cutoff moves every run so URLs
// already differ, but this makes the liveness explicit for a route that
// must never act on stale reads.
export const fetchCache = 'force-no-store'
export const maxDuration = 60

// Rolling retention window.
const RETENTION_DAYS = 90
// Rows deleted per round-trip. A DELETE is issued against an explicit id
// list (supabase-js/PostgREST has no DELETE ... LIMIT), so we page ids in
// oldest-first and delete each page.
const BATCH_SIZE = 500
// Hard ceiling on batches per run — a runaway backstop, not the steady
// state. 100 × 500 = 50,000 rows/run; if a first live run exceeds that,
// it stops cleanly (capped:true logged) and the next daily run continues.
const MAX_BATCHES = 100

export async function GET(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron sync-log-purge] CRON_SECRET not set; refusing to run')
    return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 500 })
  }
  const header = req.headers.get('authorization')
  const queryToken = req.nextUrl.searchParams.get('secret')
  if (header !== `Bearer ${secret}` && queryToken !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Live only when explicitly enabled — env var (scheduled) or query flag
  // (manual). Default is dry-run: report, delete nothing.
  const live =
    process.env.SYNC_LOG_PURGE_ENABLED === 'true' ||
    req.nextUrl.searchParams.get('execute') === 'true'

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // ─── DRY RUN: count + edges, no delete ─────────────────────────
  if (!live) {
    const { count, error: countErr } = await supabaseService
      .from('sync_log')
      .select('id', { count: 'exact', head: true })
      .lt('created_at', cutoff)
    if (countErr) {
      console.error('[cron sync-log-purge] dry-run count failed', countErr)
      return NextResponse.json({ error: 'count_failed', detail: countErr.message }, { status: 500 })
    }
    const [{ data: oldestRow }, { data: newestRow }] = await Promise.all([
      supabaseService.from('sync_log').select('created_at').lt('created_at', cutoff)
        .order('created_at', { ascending: true }).limit(1),
      supabaseService.from('sync_log').select('created_at').lt('created_at', cutoff)
        .order('created_at', { ascending: false }).limit(1),
    ])
    const wouldDelete = count ?? 0
    const oldest = oldestRow?.[0]?.created_at ?? null
    const newest = newestRow?.[0]?.created_at ?? null
    console.log(
      `[cron sync-log-purge] DRY RUN — would delete ${wouldDelete} row(s) older than ${cutoff} ` +
      `(oldest=${oldest ?? 'none'} newest=${newest ?? 'none'}). ` +
      `Set SYNC_LOG_PURGE_ENABLED=true (or call with ?execute=true) to delete.`,
    )
    return NextResponse.json({
      mode: 'dry_run', retention_days: RETENTION_DAYS, cutoff,
      would_delete: wouldDelete, oldest, newest, deleted: 0,
    })
  }

  // ─── LIVE: delete in bounded batches, oldest-first ─────────────
  let deleted = 0
  let batches = 0
  let capped = false
  let oldestTouched: string | null = null
  let newestTouched: string | null = null

  while (batches < MAX_BATCHES) {
    const { data: rows, error: selErr } = await supabaseService
      .from('sync_log')
      .select('id, created_at')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE)
    if (selErr) {
      console.error('[cron sync-log-purge] batch select failed', selErr)
      return NextResponse.json(
        { error: 'select_failed', detail: selErr.message, deleted, batches },
        { status: 500 },
      )
    }
    if (!rows || rows.length === 0) break

    const ids = rows.map(r => r.id)
    const { error: delErr } = await supabaseService.from('sync_log').delete().in('id', ids)
    if (delErr) {
      console.error('[cron sync-log-purge] batch delete failed', delErr)
      return NextResponse.json(
        { error: 'delete_failed', detail: delErr.message, deleted, batches },
        { status: 500 },
      )
    }

    // Rows come oldest-first: first batch's first row is the global oldest;
    // each batch's last row is the newest created_at touched so far.
    if (oldestTouched === null) oldestTouched = rows[0].created_at
    newestTouched = rows[rows.length - 1].created_at
    deleted += rows.length
    batches++

    // A short batch means the deletable set is drained.
    if (rows.length < BATCH_SIZE) break
  }

  if (batches >= MAX_BATCHES) {
    capped = true
    console.warn(
      `[cron sync-log-purge] hit MAX_BATCHES (${MAX_BATCHES}) — ${deleted} deleted this run, ` +
      `more remain older than ${cutoff}; the next daily run will continue.`,
    )
  }

  console.log(
    `[cron sync-log-purge] LIVE — deleted ${deleted} row(s) older than ${cutoff} ` +
    `in ${batches} batch(es) (oldest=${oldestTouched ?? 'none'} newest=${newestTouched ?? 'none'}` +
    `${capped ? ', capped' : ''}).`,
  )

  return NextResponse.json({
    mode: 'live', retention_days: RETENTION_DAYS, cutoff,
    deleted, batches, capped,
    oldest_touched: oldestTouched, newest_touched: newestTouched,
  })
}
