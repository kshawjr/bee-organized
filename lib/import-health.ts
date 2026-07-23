// lib/import-health.ts
// ─────────────────────────────────────────────────────────────
// Reads import_jobs for the webhook digest's import-health section
// (app/api/cron/webhook-digest). Kept separate from the pure digest
// formatter so the querying can be swapped/mocked in tests.
//
// Two buckets the digest cares about:
//   • FAILED   — jobs that ended in status='failed' within the digest window
//                (a user cancel, a token/throttle death, or the sweeper's
//                max-lifetime fail-out).
//   • STALLED  — jobs still status='running' whose claim hasn't refreshed in
//                longer than the alert threshold. A healthy segment refreshes
//                location_claim_at every 50 records / every page, so a claim
//                this stale means it isn't progressing.
//
// The stall threshold is deliberately HIGHER than the sweeper's 2-min re-poke
// cutoff: a brief between-segment handoff (claim released, next segment about
// to claim) must NOT read as a stall. We also require the job to have been
// running longer than the threshold, so a just-started import is never flagged.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { parseContinuationLogMessage, isFailedOutcome } from './import-continuation'

// Match the digest cadence (vercel.json: "0 */3 * * *") so a failed import is
// reported exactly once, in the window it failed.
export const IMPORT_DIGEST_WINDOW_MS = 3 * 60 * 60 * 1000
// Claim staleness at which a running import is called out as stalled. Above
// the sweeper's 2-min re-poke cutoff (normal handoffs) and below its 15-min
// fail-out — so this catches genuine stalls the sweeper is still fighting.
export const IMPORT_DIGEST_STALL_MS = 10 * 60 * 1000

export type ImportJobRow = {
  location_id: string | null
  phase: string | null
  error_message?: string | null
  processed_records: number | null
  total_records: number | null
  completed_at?: string | null
  started_at?: string | null
  location_claim_at?: string | null
}

// A continuation handoff that did NOT land, aggregated per location. The
// handoff is what picks a job back up after a segment yields gracefully; when
// it bounces, the import can only be recovered by the sweeper's next pass, and
// if it keeps bouncing the job eventually fails out. A console.warn is not a
// surface anyone reads, so the bounces come here. See lib/import-continuation.
export type ContinuationBounceRow = {
  location_id: string
  count: number
  outcomes: string      // e.g. "bounced×3, no_claim×1"
  sample: string        // the newest failing message, for the actual cause
}

export type ImportHealthData = {
  failed: ImportJobRow[]
  stalled: ImportJobRow[]
  bounced: ContinuationBounceRow[]
}

export async function fetchImportHealth(opts: {
  nowMs: number
  windowMs?: number
  stallMs?: number
  supabase?: typeof supabaseService
}): Promise<ImportHealthData> {
  const supabase = opts.supabase ?? supabaseService
  const windowMs = opts.windowMs ?? IMPORT_DIGEST_WINDOW_MS
  const stallMs = opts.stallMs ?? IMPORT_DIGEST_STALL_MS
  const windowCutoff = new Date(opts.nowMs - windowMs).toISOString()
  const stallCutoff = new Date(opts.nowMs - stallMs).toISOString()

  // Failed within the digest window.
  const { data: failed } = await supabase
    .from('import_jobs')
    .select('location_id, phase, error_message, processed_records, total_records, completed_at')
    .eq('type', 'jobber_clients')
    .eq('status', 'failed')
    .gte('completed_at', windowCutoff)
    .order('completed_at', { ascending: false })
    .limit(20)

  // Running + genuinely stalled: started longer ago than the threshold AND the
  // claim is null or staler than the threshold. PARKED jobs (sample-now/
  // bulk-later: resume_after in the future) are excluded — a job waiting for
  // its off-hours window is by design idle for hours and would otherwise be
  // called out as stalled in every digest until it resumes. NULL resume_after
  // (all normal imports) matches exactly as before; a past resume_after is a
  // deferred bulk run in progress and IS stall-monitored normally.
  const nowIso = new Date(opts.nowMs).toISOString()
  const { data: stalled } = await supabase
    .from('import_jobs')
    .select('location_id, phase, processed_records, total_records, started_at, location_claim_at')
    .eq('type', 'jobber_clients')
    .eq('status', 'running')
    .lt('started_at', stallCutoff)
    .or(`location_claim_at.is.null,location_claim_at.lt.${stallCutoff}`)
    .or(`resume_after.is.null,resume_after.lte.${nowIso}`)
    .order('started_at', { ascending: true })
    .limit(20)

  // Continuation attempts that failed to land, within the same window.
  // entity_type='location' is where recordContinuationAttempt writes; the
  // parser drops any other row that happens to share that scope.
  const { data: attempts } = await supabase
    .from('sync_log')
    .select('location_id, message, created_at')
    .eq('entity_type', 'location')
    .eq('status', 'error')
    .gte('created_at', windowCutoff)
    .order('created_at', { ascending: false })
    .limit(200)

  const byLocation = new Map<string, { count: number; outcomes: Map<string, number>; sample: string }>()
  for (const row of attempts ?? []) {
    const parsed = parseContinuationLogMessage((row as any).message)
    if (!parsed || !isFailedOutcome(parsed.outcome)) continue
    const loc = (row as any).location_id || 'unknown'
    const entry = byLocation.get(loc) ?? { count: 0, outcomes: new Map(), sample: (row as any).message }
    entry.count++
    entry.outcomes.set(parsed.outcome, (entry.outcomes.get(parsed.outcome) ?? 0) + 1)
    byLocation.set(loc, entry)
  }

  const bounced: ContinuationBounceRow[] = Array.from(byLocation.entries())
    .map(([location_id, e]) => ({
      location_id,
      count: e.count,
      outcomes: Array.from(e.outcomes.entries()).map(([o, n]) => `${o}×${n}`).join(', '),
      sample: e.sample,
    }))
    .sort((a, b) => b.count - a.count)

  return { failed: failed ?? [], stalled: stalled ?? [], bounced }
}
