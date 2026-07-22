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

export type ImportHealthData = {
  failed: ImportJobRow[]
  stalled: ImportJobRow[]
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
  // claim is null or staler than the threshold.
  const { data: stalled } = await supabase
    .from('import_jobs')
    .select('location_id, phase, processed_records, total_records, started_at, location_claim_at')
    .eq('type', 'jobber_clients')
    .eq('status', 'running')
    .lt('started_at', stallCutoff)
    .or(`location_claim_at.is.null,location_claim_at.lt.${stallCutoff}`)
    .order('started_at', { ascending: true })
    .limit(20)

  return { failed: failed ?? [], stalled: stalled ?? [] }
}
