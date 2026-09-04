// app/api/cron/auto-close/route.ts
// ─────────────────────────────────────────────────────────────
// GET /api/cron/auto-close — close enquiries that have had no exit for
// 35 days (lib/auto-close.ts carries the rule and the writes).
//
// Not yet scheduled. Kevin fires the first run by hand — dry-run to read the
// list, then live — and the vercel.json schedule lands in its own commit
// after he has seen a live result.
//
// Auth: exactly the send-drips cron. Vercel cron sends
// `Authorization: Bearer <CRON_SECRET>`; manual runs may pass `?secret=`.
// Without CRON_SECRET the route refuses (500), never runs open.
//
// Query:
//   dry_run=1   compute and return the list; write NOTHING.
//   limit=N     close at most N this invocation (default 200, max 500).
//               The scan is unaffected — the response says how many remain.
//
// Response: { dry_run, days, cutoff, closed|would_close: [...], spared: [...],
//             failed: [...], remaining } — names ride along so the dry run
//             reads as a list of people, not ids.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server'
import { AUTO_CLOSE_DAYS, closeStaleEnquiry, findStaleEnquiries } from '@/lib/auto-close'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[cron:auto-close] CRON_SECRET not set; refusing to run')
    return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 500 })
  }
  const header = req.headers.get('authorization')
  const queryToken = req.nextUrl.searchParams.get('secret')
  if (header !== `Bearer ${secret}` && queryToken !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const params = req.nextUrl.searchParams
  const dryRun = ['1', 'true', 'yes'].includes((params.get('dry_run') ?? '').toLowerCase())
  const limitRaw = Number(params.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_LIMIT) : DEFAULT_LIMIT

  const now = new Date()
  let scan
  try {
    scan = await findStaleEnquiries({ now })
  } catch (err: any) {
    console.error('[cron:auto-close] scan failed', err)
    return NextResponse.json({ error: 'scan_failed', message: err?.message ?? String(err) }, { status: 500 })
  }

  const batch = scan.toClose.slice(0, limit)
  const remaining = scan.toClose.length - batch.length

  if (dryRun) {
    return NextResponse.json({
      dry_run: true,
      days: AUTO_CLOSE_DAYS,
      cutoff: scan.cutoffIso,
      ran_at: now.toISOString(),
      would_close_count: batch.length,
      would_close: batch,
      remaining,
      spared_count: scan.spared.length,
      spared: scan.spared,
    })
  }

  const closed: { lead_id: string; name: string | null; location_id: string; engagement_ids: string[]; founded: boolean }[] = []
  const failed: { lead_id: string; name: string | null; location_id: string; error: string }[] = []
  for (const item of batch) {
    try {
      const r = await closeStaleEnquiry(item, { now })
      closed.push({ lead_id: item.leadId, name: item.name, location_id: item.locationId, engagement_ids: r.engagementIds, founded: r.founded })
    } catch (err: any) {
      console.error('[cron:auto-close] close failed', { leadId: item.leadId, err })
      failed.push({ lead_id: item.leadId, name: item.name, location_id: item.locationId, error: err?.message ?? String(err) })
    }
  }

  console.log(`[cron:auto-close] closed=${closed.length} failed=${failed.length} spared=${scan.spared.length} remaining=${remaining}`)

  return NextResponse.json({
    dry_run: false,
    days: AUTO_CLOSE_DAYS,
    cutoff: scan.cutoffIso,
    ran_at: now.toISOString(),
    closed_count: closed.length,
    closed,
    failed_count: failed.length,
    failed,
    remaining,
    spared_count: scan.spared.length,
    spared: scan.spared,
  })
}
