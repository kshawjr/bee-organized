// app/api/cron/import-sweeper/route.ts
//
// GET /api/cron/import-sweeper — Vercel cron entrypoint, fires every minute.
//
// Self-healing backstop for the Jobber-import waitUntil self-chain. Each
// segment of /api/import/jobber-clients fires the next segment via a
// server-side POST (see selfContinue in that route). If the chain ever
// breaks — Vercel dropped the waitUntil, the internal POST 5xx'd, whatever
// — this sweeper finds jobs that are status='running' with a stale (or
// null) location_claim_at and re-pokes the endpoint to resume them.
//
// "Stale" = older than 2 minutes. A healthy segment refreshes its claim
// on every page write, so 2 minutes without a refresh means the segment
// died. Portland-style paused imports (browser closed mid-flight) also
// fall into this bucket and get automatically resumed.
//
// Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. Manual
// testing also accepts `?secret=<value>`. The internal continuation POSTs
// use `x-import-continue-secret: <CRON_SECRET>` — same secret, different
// header, matches the internal-secret gate at the top of the import route.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'

export const dynamic = 'force-dynamic'

// Cap per run to avoid a flood of parallel POSTs if a lot of jobs happen
// to be stalled at once. 10 covers realistic worst-case fleet size.
const RESUME_LIMIT = 10

// A segment refreshes location_claim_at on every page write. If we haven't
// seen a refresh in this long, the segment is dead and we should re-poke.
// Two minutes is well past the typical page write cadence but well under
// how long a real segment can go without progress on Jobber throttle waits.
const STALE_AFTER_MS = 2 * 60 * 1000

export async function GET(req: NextRequest) {
  // ─── Auth ──────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET
  if (!secret) {
    console.error('[import-sweeper] CRON_SECRET not set; refusing to run')
    return NextResponse.json({ error: 'cron_secret_not_configured' }, { status: 500 })
  }
  const header = req.headers.get('authorization')
  const expected = `Bearer ${secret}`
  const queryToken = req.nextUrl.searchParams.get('secret')
  if (header !== expected && queryToken !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // ─── Find stalled jobs ─────────────────────────────────────────
  const cutoffIso = new Date(Date.now() - STALE_AFTER_MS).toISOString()
  const { data: stalled, error: findErr } = await supabaseService
    .from('import_jobs')
    .select('id, location_id, location_claim_at')
    .eq('status', 'running')
    .eq('type', 'jobber_clients')
    .or(`location_claim_at.is.null,location_claim_at.lt.${cutoffIso}`)
    .order('started_at', { ascending: true })
    .limit(RESUME_LIMIT)
  if (findErr) {
    console.error('[import-sweeper] find stalled jobs failed:', findErr.message)
    return NextResponse.json({ error: 'find_failed', detail: findErr.message }, { status: 500 })
  }

  const jobs = stalled || []
  if (jobs.length === 0) {
    return NextResponse.json({ resumed: 0, checked: 0 })
  }

  // ─── Re-poke each with the internal-secret header ──────────────
  // The import route's atomic claim will decide whether to actually spawn a
  // new segment (fresh claim → no-op, stale/null → drive next segment). We
  // just kick the door; the route decides.
  //
  // MUST use the public production alias — the deployment-specific URL
  // (req.nextUrl.origin) is Vercel-SSO-gated and returns a 302 to the SSO
  // login page. Node fetch follows the redirect and lands on the SSO 200
  // page, which would silently look like `r.ok=true` while never reaching
  // the import route. VERCEL_PROJECT_PRODUCTION_URL is injected by Vercel
  // and points at the public alias (e.g. bee-hub-kappa.vercel.app).
  const origin = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : req.nextUrl.origin
  const results: Array<{ job_id: string; location_id: string; ok: boolean; status?: number; error?: string }> = []
  await Promise.all(
    jobs.map(async (j: any) => {
      try {
        console.log('[import-sweeper] continuation URL:', `${origin}/api/import/jobber-clients?location_id=${encodeURIComponent(j.location_id)}&_continue=1`, '| VERCEL_PROJECT_PRODUCTION_URL:', process.env.VERCEL_PROJECT_PRODUCTION_URL ?? '(unset)')
        const r = await fetch(
          `${origin}/api/import/jobber-clients?location_id=${encodeURIComponent(j.location_id)}&_continue=1`,
          {
            method: 'POST',
            headers: { 'x-import-continue-secret': secret },
          },
        )
        results.push({ job_id: j.id, location_id: j.location_id, ok: r.ok, status: r.status })
      } catch (err: any) {
        results.push({ job_id: j.id, location_id: j.location_id, ok: false, error: String(err?.message || err) })
      }
    }),
  )

  const resumed = results.filter(r => r.ok).length
  console.log(`[import-sweeper] resumed ${resumed}/${jobs.length} stalled jobs`)
  return NextResponse.json({ resumed, checked: jobs.length, results })
}
