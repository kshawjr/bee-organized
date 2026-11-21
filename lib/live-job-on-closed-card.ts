// lib/live-job-on-closed-card.ts
// ─────────────────────────────────────────────────────────────
// A job Jobber still shows as not finished, sitting on a closed card
// (Kevin's rulings, 2026-11-21). Pure: no database, no browser.
//
// WHERE A JOB LANDS (lib/engagements.ts resolveEngagementForChild):
//   · made from a request  → that request's card, open or closed
//   · made from a quote    → that quote's card, open or closed
//   · made straight on the client (no request, no quote) → the client's
//     open card if there is one, else a brand-new card. Never a closed one.
// So a live job reaches a closed card only through its own request or quote,
// and that card is the one the work belongs to.
//
// THE THREE RULINGS:
//   1. A card a MACHINE closed — stale at import, or every quote archived in
//      Jobber — reopens on its own when a live job is on it, at the stage the
//      app's own rule gives (deriveEngagementStage, live mode).
//   2. A card a PERSON closed (No response, Project cancelled, duplicate, any
//      reason someone picked) is never reopened by the machine. If a live job
//      was made in Jobber AFTER they closed it, the client page says so and
//      offers the ordinary one-tap Reopen. A job that was already there when
//      they closed it is something they saw: no note.
//   3. A Won card is left exactly as it is (repeat business is a later call).
// Job deleted in Jobber has its own reopen (reopenIfClosedByJobDeletion), and
// a request deleted in Jobber only ever closes a card with no job on it.
// ─────────────────────────────────────────────────────────────

/** Not finished in Jobber: the five statuses Kevin named. */
export const LIVE_JOB_STATUSES: ReadonlySet<string> = new Set(['upcoming', 'late', 'unscheduled', 'today', 'in_progress'])

export function isLiveJob(j: { status?: string | null; completed_at?: string | null }): boolean {
  return !j.completed_at && LIVE_JOB_STATUSES.has((j.status || '').toLowerCase())
}

/** Ruling 1: the machine closes that a live job undoes. */
export const MACHINE_CLOSES_THAT_REOPEN: ReadonlySet<string> = new Set(['stale_on_import', 'quote_archived'])

/** Closes nobody picked by hand. None of them is a person's close (ruling 2). */
const MACHINE_CLOSES: ReadonlySet<string> = new Set([
  'stale_on_import', 'quote_archived', 'job_deleted', 'request_destroyed',
])

export function machineClosedForReopen(eng: { stage?: string | null; closed_reason?: string | null }): boolean {
  return eng.stage === 'Closed Lost' && MACHINE_CLOSES_THAT_REOPEN.has(eng.closed_reason || '')
}

export function personClosed(eng: { stage?: string | null; closed_reason?: string | null }): boolean {
  return eng.stage === 'Closed Lost' && !MACHINE_CLOSES.has(eng.closed_reason || '')
}

const ms = (v: unknown) => {
  const n = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * Ruling 2: a person closed this card, and Jobber has a live job on it that
 * was made after they closed it. A missing date on either side is "no".
 */
export function personClosedCardHasNewJob(
  eng: { stage?: string | null; closed_reason?: string | null; closed_at?: string | null },
  jobs: Array<{ status?: string | null; completed_at?: string | null; created_at?: string | null }>,
): boolean {
  if (!personClosed(eng)) return false
  const closedAt = ms(eng.closed_at)
  if (closedAt == null) return false
  return jobs.some(j => {
    const made = ms(j.created_at)
    return isLiveJob(j) && made != null && made > closedAt
  })
}

export const NEW_JOB_NOTE = 'This person has a new job in Jobber.'
