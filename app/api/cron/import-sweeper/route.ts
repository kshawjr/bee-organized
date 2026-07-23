// app/api/cron/import-sweeper/route.ts
//
// GET /api/cron/import-sweeper — Vercel cron entrypoint, fires every minute.
//
// The safety net for the Jobber-import continuation handoff. Each segment of
// /api/import/jobber-clients hands off to the next by AWAITING a server-side
// POST back to itself (see selfContinue in that route). This sweeper is the
// backstop for when that handoff doesn't land — a dropped invocation, a 5xx,
// a gated origin. It finds jobs that are status='running' with a released
// (null) or stale location_claim_at and re-pokes the endpoint to resume them.
//
// TWO STATES ARE NORMAL AND MUST BE TREATED DIFFERENTLY:
//
//   • null location_claim_at  — the segment yielded GRACEFULLY: progress
//     persisted, both mutexes released, waiting to be picked up. This is the
//     ordinary state between the ~9 segments of a territory-sized import.
//     ALWAYS re-poke. NEVER fail out on age.
//   • stale non-null claim    — a segment claimed and then died without
//     releasing. Age it from the claim; past the ceiling, give up.
//
// Conflating those two is the bug this route shipped with: the fail-out aged a
// job as `now - (location_claim_at || started_at)`, so after a clean yield it
// fell back to the time the WHOLE JOB started. That turned the 15-minute
// "last resort" into a hard 15-minute ceiling on total import duration — every
// clean yield past that mark was marked failed WITHOUT EVER BEING RE-POKED.
// Prod: loc_kc (3,352 records, ~9 segments) died twice this way on 2026-07-22,
// at 636/3352 and 2067/3352, each needing a manual restart. See
// lib/import-continuation.ts for the full write-up.
//
// Every attempt and its OUTCOME is recorded to sync_log, so a bounce is
// readable after the fact instead of a console.warn nobody sees.
//
// Auth: Vercel cron sends `Authorization: Bearer <CRON_SECRET>`. Manual
// testing also accepts `?secret=<value>`. The internal continuation POSTs
// use `x-import-continue-secret: <CRON_SECRET>` — same secret, different
// header, matches the internal-secret gate at the top of the import route.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { resolveInternalOrigin } from '@/lib/internal-origin'
import {
  postContinuation,
  recordContinuationAttempt,
  consecutiveBounceStartMs,
  parseContinuationLogMessage,
  decideFailOut,
  failOutMessage,
  isFailedOutcome,
  CLAIM_VERIFY_ATTEMPTS,
  CLAIM_VERIFY_INTERVAL_MS,
  type ContinuationOutcome,
} from '@/lib/import-continuation'

export const dynamic = 'force-dynamic'

// Cap per run to avoid a flood of parallel POSTs if a lot of jobs happen
// to be stalled at once. 10 covers realistic worst-case fleet size.
const RESUME_LIMIT = 10

// A segment refreshes location_claim_at on every page write. If we haven't
// seen a refresh in this long, the segment is dead and we should re-poke.
// Two minutes is well past the typical page write cadence but well under
// how long a real segment can go without progress on Jobber throttle waits.
// (A null claim — a clean yield — is picked up immediately, no wait.)
const STALE_AFTER_MS = 2 * 60 * 1000

// Max-lifetime fail-out — the LAST RESORT, not the primary recovery. Only two
// things can trip it, both backed by a real signal (never by job age):
//   • a claim held and stale for this long → the segment died mid-flight
//   • every continuation attempt bouncing for this long → the handoff itself
//     is broken (gated origin, dead route), so re-poking forever is futile
// A healthy long import never approaches either: a live segment refreshes its
// claim every 50 records, and a cleanly-yielded one is re-poked within ~60s.
const FAIL_AFTER_MS = 15 * 60 * 1000

// How far back to read continuation history when sizing a bounce run. A little
// past the fail-out ceiling so the start of a run that is just crossing the
// line is still visible.
const HISTORY_WINDOW_MS = FAIL_AFTER_MS + 5 * 60 * 1000

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
  // login page before the import route runs. resolveInternalOrigin consults
  // the public custom domain (NEXT_PUBLIC_APP_URL). See lib/internal-origin.ts.
  const origin = resolveInternalOrigin(req.nextUrl.origin)

  console.log(
    '[sweeper] origin=', origin,
    'PROD_URL=', process.env.VERCEL_PROJECT_PRODUCTION_URL ?? 'unset',
    'INTERNAL_BASE=', process.env.INTERNAL_BASE_URL ?? 'unset',
  )

  // ─── Find candidate jobs ───────────────────────────────────────
  // Both states above: a released (null) claim and a stale one.
  // PARKED jobs are excluded: a sample-now/bulk-later import parks its job
  // (status stays 'running', resume_after in the future) and must NOT be
  // re-poked until the off-hours window opens — without this filter the
  // sweeper would resume the bulk run within ~60s of the park. NULL
  // resume_after = every pre-existing/normal job, matched exactly as before;
  // a PAST resume_after = the window opened, resume it. The two .or() calls
  // AND together (separate PostgREST or= groups). The import route also
  // refuses to resume a parked job, so even a stale-deployment sweeper
  // running pre-filter code can re-poke but never actually resume one.
  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const cutoffIso = new Date(now - STALE_AFTER_MS).toISOString()
  const { data: stalled, error: findErr } = await supabaseService
    .from('import_jobs')
    .select('id, location_id, location_claim_at, started_at, phase, processed_records, total_records, resume_after')
    .eq('status', 'running')
    .eq('type', 'jobber_clients')
    .or(`location_claim_at.is.null,location_claim_at.lt.${cutoffIso}`)
    .or(`resume_after.is.null,resume_after.lte.${nowIso}`)
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

  // ─── Load continuation history for the null-claim jobs ─────────
  // A job with a live-but-stale claim is aged from that claim and needs no
  // history. A null-claim job is aged from its consecutive-bounce run, which
  // lives in sync_log. One query for the whole batch, grouped in JS.
  const nullClaimJobs = jobs.filter((j: any) => !j.location_claim_at)
  const bounceRunStart = new Map<string, number | null>()
  if (nullClaimJobs.length > 0) {
    const slugs = Array.from(new Set(nullClaimJobs.map((j: any) => j.location_id).filter(Boolean)))
    const sinceIso = new Date(now - HISTORY_WINDOW_MS).toISOString()
    const { data: history, error: histErr } = await supabaseService
      .from('sync_log')
      .select('location_id, message, created_at')
      .in('location_id', slugs)
      .eq('entity_type', 'location')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(200)
    if (histErr) {
      // Non-fatal: without history we simply can't age a bounce run, so
      // decideFailOut returns 'awaiting_pickup' and we re-poke. Failing OPEN
      // (keep trying) is the safe direction — the old bug failed CLOSED.
      console.error('[import-sweeper] continuation history read failed:', histErr.message)
    }
    for (const j of nullClaimJobs) {
      const attempts = (history ?? [])
        .filter((r: any) => r.location_id === j.location_id && String(r.message ?? '').includes(`job=${j.id}`))
        .map((r: any) => ({ at: r.created_at, parsed: parseContinuationLogMessage(r.message) }))
        .filter((r: any) => r.parsed)
        .map((r: any) => ({ at: r.at, outcome: r.parsed.outcome as ContinuationOutcome }))
      bounceRunStart.set(j.id, consecutiveBounceStartMs(attempts))
    }
  }

  const decisionFor = (j: any) =>
    decideFailOut({
      claimAt: j.location_claim_at,
      nowMs: now,
      failAfterMs: FAIL_AFTER_MS,
      bounceRunStartMs: bounceRunStart.get(j.id) ?? null,
    })

  const hopeless = jobs.filter((j: any) => decisionFor(j).fail)
  const resumable = jobs.filter((j: any) => !decisionFor(j).fail)

  // ─── Give up on hopeless jobs (max-lifetime fail-out) ──────────
  // Guarded on status='running' so a natural transition isn't clobbered.
  // Both mutexes released. NOT re-poked.
  const failedOut: Array<{
    job_id: string; location_id: string; failed_out: true; stalled_ms: number; reason: string
  }> = []
  await Promise.all(
    hopeless.map(async (j: any) => {
      const d = decisionFor(j)
      await supabaseService
        .from('import_jobs')
        .update({
          status: 'failed',
          error_message: failOutMessage({
            reason: d.reason,
            stalledMs: d.stalledMs,
            failAfterMs: FAIL_AFTER_MS,
            phase: j.phase,
            processed: j.processed_records,
            total: j.total_records,
          }),
          completed_at: new Date().toISOString(),
          segment_started_at: null,
          location_claim_at: null,
        })
        .eq('id', j.id)
        .eq('status', 'running')
      console.warn(
        `[import-sweeper] FAILED OUT job ${j.id} (${j.location_id}) — ` +
        `${d.reason}, stalled ${Math.round(d.stalledMs / 60000)}m`,
      )
      failedOut.push({
        job_id: j.id,
        location_id: j.location_id,
        failed_out: true,
        stalled_ms: d.stalledMs,
        reason: d.reason,
      })
    }),
  )

  // ─── Re-poke each resumable job ────────────────────────────────
  // The POST is only half the story: a 2xx means the route accepted the call,
  // not that a segment actually took over. Verify against DB STATE — re-read
  // the row and check that the claim is now held (or that the job left
  // 'running' because it finished). A 2xx that leaves the claim null is the
  // silent-failure class ('no_claim') and is recorded as such.
  const results: Array<{
    job_id: string; location_id: string; ok: boolean; outcome: ContinuationOutcome
    status?: number; redirected_to?: string; error?: string
  }> = []
  await Promise.all(
    resumable.map(async (j: any) => {
      const post = await postContinuation({
        origin,
        locationSlug: j.location_id,
        secret,
      })

      let outcome: ContinuationOutcome = post.outcome
      let detail = post.detail

      if (outcome === 'landed') {
        // Verify against DB STATE, not the HTTP status: did a segment actually
        // take the job? POLL for it — do NOT read once. The receiving route is
        // a cold-startable 800s function and was measured taking >9s between
        // handler entry and its claim write, so a single immediate read
        // reports "nobody took it" about handoffs that land moments later
        // (two false no_claims on loc_kc, 2026-07-22). Poll until the verify
        // window closes, then believe it.
        let claimed = false
        for (let attempt = 0; attempt < CLAIM_VERIFY_ATTEMPTS; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, CLAIM_VERIFY_INTERVAL_MS))
          const { data: after } = await supabaseService
            .from('import_jobs')
            .select('status, location_claim_at')
            .eq('id', j.id)
            .maybeSingle()
          // Claim held → a segment is driving it. Left 'running' → it finished.
          claimed = !!after?.location_claim_at || (!!after && after.status !== 'running')
          if (claimed) break
        }
        if (!claimed) {
          // Recorded and surfaced, but deliberately NOT counted toward the
          // fail-out clock (agesBounceRun) — this signal is inherently racy
          // and must never be the reason a healthy import is killed.
          outcome = 'no_claim'
          detail =
            `POST returned 2xx but no segment claimed the job within ` +
            `${Math.round((CLAIM_VERIFY_ATTEMPTS * CLAIM_VERIFY_INTERVAL_MS) / 1000)}s — ` +
            `resume may not have taken`
        }
      }

      await recordContinuationAttempt({
        jobId: j.id,
        locationSlug: j.location_id,
        source: 'sweeper',
        outcome,
        status: post.status,
        detail,
      })

      if (isFailedOutcome(outcome)) {
        console.warn(
          `[import-sweeper] continuation ${outcome} for ${j.location_id} ` +
          `(job ${j.id}): status=${post.status ?? 'n/a'} ${detail ?? ''} (origin=${origin})`,
        )
      }

      results.push({
        job_id: j.id,
        location_id: j.location_id,
        ok: outcome === 'landed',
        outcome,
        status: post.status,
        redirected_to: post.redirectedTo,
        error: outcome === 'errored' ? detail : undefined,
      })
    }),
  )

  const resumed = results.filter(r => r.ok).length
  console.log(
    `[import-sweeper] resumed ${resumed}/${resumable.length} re-pokable, ` +
    `failed out ${failedOut.length}/${jobs.length} candidates`,
  )
  return NextResponse.json({
    resumed,
    checked: jobs.length,
    failed_out: failedOut.length,
    results: [...results, ...failedOut],
  })
}
