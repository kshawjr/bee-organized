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
import { resolveInternalOrigin } from '@/lib/internal-origin'

export const dynamic = 'force-dynamic'

// Cap per run to avoid a flood of parallel POSTs if a lot of jobs happen
// to be stalled at once. 10 covers realistic worst-case fleet size.
const RESUME_LIMIT = 10

// A segment refreshes location_claim_at on every page write. If we haven't
// seen a refresh in this long, the segment is dead and we should re-poke.
// Two minutes is well past the typical page write cadence but well under
// how long a real segment can go without progress on Jobber throttle waits.
const STALE_AFTER_MS = 2 * 60 * 1000

// Max-lifetime fail-out. If a job's claim has been stale for THIS long, the
// sweeper has been re-poking it (once a minute) for many minutes and NOTHING
// has caught — every resume is dying instantly or bouncing (e.g. the SSO-gated
// origin). It's hopeless: mark it failed so the UI shows an actionable error
// instead of an eternal spinner, rather than re-poking forever.
//
// Safe against healthy imports: a live segment refreshes location_claim_at
// every 50 records (write phase) or every page (fetch phase), so its claim is
// never more than seconds stale while it's making progress. The write phase's
// own wall-clock guard yields at 600s (10 min) but keeps refreshing the claim
// throughout — so a healthy job's claim never approaches 15 min of staleness.
// 15 min is comfortably past the 10-min write budget AND the ~150s max Jobber
// throttle sleep, so this can only fire on a genuinely dead/bouncing job.
const FAIL_AFTER_MS = 15 * 60 * 1000

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

  // ─── Resolve origin ───────────────────────────────────────────
  // MUST be a non-SSO-gated origin or the re-poke is redirected to the Vercel
  // login page before the import route runs (root cause of the stalled
  // Scottsdale import: INTERNAL_BASE_URL + VERCEL_PROJECT_PRODUCTION_URL were
  // both unset, so this fell through to the gated deployment origin and every
  // re-poke bounced). resolveInternalOrigin now consults the public custom
  // domain (NEXT_PUBLIC_APP_URL) too. See lib/internal-origin.ts.
  const origin = resolveInternalOrigin(req.nextUrl.origin)

  console.log(
    '[sweeper] origin=', origin,
    'PROD_URL=', process.env.VERCEL_PROJECT_PRODUCTION_URL ?? 'unset',
    'INTERNAL_BASE=', process.env.INTERNAL_BASE_URL ?? 'unset',
  )

  // ─── Find stalled jobs ─────────────────────────────────────────
  const now = Date.now()
  const cutoffIso = new Date(now - STALE_AFTER_MS).toISOString()
  const { data: stalled, error: findErr } = await supabaseService
    .from('import_jobs')
    .select('id, location_id, location_claim_at, started_at, phase, processed_records, total_records')
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

  // ─── Give up on hopeless jobs (max-lifetime fail-out) ──────────
  // A job whose claim has been stale past FAIL_AFTER_MS has been re-poked for
  // many minutes with nothing catching — mark it failed (guarded on
  // status='running' so a natural transition isn't clobbered) + release both
  // mutexes, and DON'T re-poke it. The rest fall through to the resume path.
  // Age of the stall, measured from the last claim refresh (or, if the claim
  // was released between segments, the job's start). Returns 0 when neither
  // timestamp parses — a job we can't age is re-poked, never failed out, so a
  // malformed row is never wrongly killed. started_at is always set at job
  // creation, so this only defaults for genuinely broken rows.
  const stallAgeMs = (j: any): number => {
    const ref = j.location_claim_at || j.started_at
    const refMs = ref ? Date.parse(ref) : NaN
    return Number.isFinite(refMs) ? now - refMs : 0
  }
  const failOut = stallAgeMs
  const hopeless = jobs.filter((j: any) => failOut(j) > FAIL_AFTER_MS)
  const resumable = jobs.filter((j: any) => failOut(j) <= FAIL_AFTER_MS)

  const failedOut: Array<{ job_id: string; location_id: string; failed_out: true; stalled_ms: number }> = []
  await Promise.all(
    hopeless.map(async (j: any) => {
      const stalledMs = failOut(j)
      const mins = Math.round(stalledMs / 60000)
      await supabaseService
        .from('import_jobs')
        .update({
          status: 'failed',
          error_message:
            `Import stalled — no progress for ${mins}m (max-lifetime fail-out at ${Math.round(FAIL_AFTER_MS / 60000)}m). ` +
            `Last phase: ${j.phase || 'unknown'}${j.total_records ? ` (${j.processed_records || 0}/${j.total_records})` : ''}. ` +
            `Re-sync to resume from where it stopped.`,
          completed_at: new Date().toISOString(),
          segment_started_at: null,
          location_claim_at: null,
        })
        .eq('id', j.id)
        .eq('status', 'running')
      console.warn(`[import-sweeper] FAILED OUT hopeless job ${j.id} (${j.location_id}) — stalled ${mins}m`)
      failedOut.push({ job_id: j.id, location_id: j.location_id, failed_out: true, stalled_ms: stalledMs })
    }),
  )

  // ─── Re-poke each with the internal-secret header ──────────────
  // redirect: 'manual' so a 302 to the SSO login page is caught as a
  // failure (status=302) rather than silently followed to a 200 HTML page.
  const results: Array<{ job_id: string; location_id: string; ok: boolean; status?: number; redirected_to?: string; error?: string }> = []
  await Promise.all(
    resumable.map(async (j: any) => {
      const url = `${origin}/api/import/jobber-clients?location_id=${encodeURIComponent(j.location_id)}&_continue=1`
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'x-import-continue-secret': secret },
          redirect: 'manual',
        })
        const ok = r.status >= 200 && r.status < 300
        // `redirect: 'manual'` makes undici surface a redirect as an
        // opaqueredirect (type='opaqueredirect', status=0) rather than the
        // real 3xx — so treat status 0 / opaqueredirect as a blocked SSO
        // redirect too, not a silent "ok:false, status:0". This is the exact
        // signature the SSO gate produces, and it must read as a failure.
        const isRedirect =
          (r as any).type === 'opaqueredirect' || r.status === 0 || (r.status >= 300 && r.status < 400)
        if (!ok && isRedirect) {
          const loc = r.headers.get('location')
          console.warn(`[import-sweeper] redirect blocked for ${j.location_id}: status=${r.status} type=${(r as any).type} → ${loc} (origin=${origin} may be SSO-gated)`)
          results.push({ job_id: j.id, location_id: j.location_id, ok: false, status: r.status, redirected_to: loc ?? undefined })
        } else {
          results.push({ job_id: j.id, location_id: j.location_id, ok, status: r.status })
        }
      } catch (err: any) {
        results.push({ job_id: j.id, location_id: j.location_id, ok: false, error: String(err?.message || err) })
      }
    }),
  )

  const resumed = results.filter(r => r.ok).length
  console.log(`[import-sweeper] resumed ${resumed}/${resumable.length} re-pokable, failed out ${failedOut.length}/${jobs.length} stalled jobs`)
  return NextResponse.json({
    resumed,
    checked: jobs.length,
    failed_out: failedOut.length,
    results: [...results, ...failedOut],
  })
}
