// lib/import-phase.ts
// ─────────────────────────────────────────────────────────────
// Pure phase/park vocabulary for the sample-now / bulk-later import.
//
// Lives in its own module (NOT lib/jobber-import.ts) because BeeHub.jsx
// needs these client-side: jobber-import instantiates supabaseService at
// module load, which must never reach the browser bundle. Nothing here may
// import anything with side effects.
//
// The park contract, in one place:
//   • A parked job stays status='running' (the partial unique index keeps
//     blocking rival imports for the location) with a FUTURE
//     import_jobs.resume_after and a phase that starts with 'parked'.
//   • Everything that resumes an import — the cron sweeper, the browser
//     poller's auto-continue re-POST, a manual Start Import click — must
//     hold off while isJobParked() is true. The route enforces this for
//     every caller as the backstop (a stale-deployment sweeper can re-poke
//     but cannot resume a parked job).
//   • phaseAutoContinues() is the ONE phase→re-POST predicate both import
//     UIs use; the parked phase string must never match it.
// ─────────────────────────────────────────────────────────────

// The hour (UTC) a parked bulk run resumes: 09:00 UTC = 2am PDT / 3am MST
// (Scottsdale) / 4am CDT (KC, Omaha, NW Arkansas) / 5am EDT — off-hours for
// every US territory. The sweeper (every minute) picks the job up within
// ~60s of this passing.
export const PARK_RESUME_UTC_HOUR = 9

// Per-record delay for DEFERRED-BULK write segments only (resume_after
// non-null and passed). A KC-sized run stretches from ~30min toward ~an
// hour+ — irrelevant overnight — and roughly halves the instantaneous
// Supabase write pressure so the app stays usable if someone logs in
// mid-run (the 2026-07-22 504s). Never applied to normal imports or to the
// sample segment (resume_after is NULL on both).
export const DEFERRED_WRITE_PACE_MS = 250

// Parked phase strings start with this. Chosen so it can NEVER match the
// auto-continue predicate below ('fetching…'/'batched…'/'writing…').
export const PARKED_PHASE_PREFIX = 'parked'

/**
 * The phase written when a sample segment parks. Carries both numbers so a
 * human reading import_jobs (or the digest) sees the real state at a glance;
 * the UIs read processed_records/total_records/resume_after instead.
 */
export function parkedPhase(processed: number, total: number): string {
  const remaining = Math.max(0, total - processed)
  return `${PARKED_PHASE_PREFIX} — sample of ${processed} imported, ${remaining} resume overnight`
}

export function isParkedPhase(phase: string | null | undefined): boolean {
  return String(phase || '').startsWith(PARKED_PHASE_PREFIX)
}

/**
 * The ONE phase→auto-continue predicate. Both import UIs' pollers re-POST
 * to drive the next segment only when this is true. 'writing' matters (a
 * segment that dies while phase='writing' recovers via the open tab); the
 * parked phase — and 'incremental'/'done'/throttle-pause text — must not
 * match, or an open onboarding tab would launch the bulk run mid-day.
 */
export function phaseAutoContinues(phase: string | null | undefined): boolean {
  return /^fetching|^batched|^writing/.test(String(phase || ''))
}

/**
 * Is this job parked right now? NULL/absent resume_after = never parked
 * (all pre-existing jobs and every normal import). A past resume_after =
 * the window opened; not parked anymore.
 */
export function isJobParked(
  resumeAfter: string | null | undefined,
  nowMs: number,
): boolean {
  if (!resumeAfter) return false
  const t = Date.parse(resumeAfter)
  return Number.isFinite(t) && t > nowMs
}

/**
 * When a job parking NOW should resume: the next occurrence of
 * PARK_RESUME_UTC_HOUR strictly in the future. Onboarding calls happen
 * during US business hours (≈15:00–01:00 UTC), so this is always "tonight".
 */
export function computeResumeAfter(
  nowMs: number,
  hourUtc: number = PARK_RESUME_UTC_HOUR,
): string {
  const d = new Date(nowMs)
  const todayAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, 0, 0, 0)
  const at = todayAt > nowMs ? todayAt : todayAt + 24 * 60 * 60 * 1000
  return new Date(at).toISOString()
}
