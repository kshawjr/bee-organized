// components/hive/shared/jobDeleted.js
// ─────────────────────────────────────────────────────────────
// JOBS DELETED IN JOBBER (2026-09-27).
//
// Jobber tells us when a job is deleted (JOB_DESTROY). Since 2026-08-29 the
// handler was meant to mark the row 'deleted' and re-derive the deal — but
// it matched Jobber's ENCODED id against our plain numeric jobber_job_id, so
// it never matched once: 56 deletions arrived, none applied, and 55 jobs
// ($47,421 of it still "upcoming"/"today"/"late"/"needs action") kept
// reading as live work. The handler now decodes the id.
//
// The row is marked, never removed: it is the record that work was once
// agreed. Once marked:
//   · the stage derivation ignores it (lib/engagements.ts) — and a deal
//     whose EVERY job is deleted, with nothing invoiced, closes Lost
//     'job_deleted' on the automated path only (Kevin's 2026-08-29 rule);
//   · no screen shows it (panel, board, chips, client card, timeline,
//     person) — every fetch leaves it out;
//   · money is untouched: jobs carry no money of their own; an invoice on a
//     deleted job is still a real invoice and still counts.
//
// completed_at: 15 of the 55 carry one (mostly archived jobs). It does not
// matter once the row is 'deleted' — every reader drops deleted rows before
// it looks at completed_at.
//
// What still reads deleted jobs on purpose: "was this enquiry ever worked in
// Jobber" date facts (auto-close, the Inbox rule, overview New count,
// Mailchimp). A job that existed and was deleted still proves the enquiry
// reached Jobber.
//
// PURE: no React, no fetch. Imported by the webhook, the stage derivation,
// the repair script and the screens, so "deleted" means one thing.
// ─────────────────────────────────────────────────────────────

export const JOB_DELETED = 'deleted'

export function isDeletedJob(j) {
  return String(j?.status ?? '').toLowerCase() === JOB_DELETED
}

// Every job a screen may show or reason about.
export function liveJobs(list) {
  return (list || []).filter(j => !isDeletedJob(j))
}

// ── THE REPLACEMENT CHECK (Kevin, 2026-09-27: "just close them if they are
// not in jobber") ──────────────────────────────────────────────────────────
// When the deleted invoices were chased, a replacement had nearly always
// been raised a few days later. So before a deal is moved because its job
// was deleted, Jobber is asked for every job that CLIENT has. A job is a
// possible replacement when it is not one of the deleted ones and it is
// either still open in Jobber (anything but archived) or was created on or
// after the deleted job (a day of slack for time zones). Deliberately wide:
// a false "replacement" only holds
// a deal open for a human to look at; a missed one closes live work.
//
// Jobs Bee Hub already has ON THIS DEAL are not replacements: the stage
// derivation already counts them (an archived job on the deal is exactly why
// a deal moves to Final Processing). A replacement is work the derivation
// cannot see — on another deal, or missing from Bee Hub altogether.
//
// clientJobs: [{ id (numeric string), jobStatus, createdAt }]
/**
 * @param {{ clientJobs?: any[], deletedJobberIds?: string[], deletedCreatedAt?: string | null, onThisDeal?: string[] }} [args]
 * @returns {any[]}
 */
export function findReplacementJobs({ clientJobs = [], deletedJobberIds = [], deletedCreatedAt = null, onThisDeal = [] } = {}) {
  const gone = new Set([...(deletedJobberIds || []), ...(onThisDeal || [])].map(String))
  const since = deletedCreatedAt ? Date.parse(deletedCreatedAt) : NaN
  return (clientJobs || []).filter(j => {
    if (!j || gone.has(String(j.id))) return false
    const open = String(j.jobStatus ?? '').toLowerCase() !== 'archived'
    const later = Number.isFinite(since) && Date.parse(j.createdAt) >= since - 24 * 3600 * 1000
    return open || later
  })
}

// May a deal move because its jobs were deleted? Only when Jobber was read
// and has no replacement. Unreadable is not "gone": it holds.
/** @param {{ readable: boolean, replacements?: any[] }} args */
export function deletedJobMoveDecision({ readable, replacements = [] }) {
  if (!readable) return 'hold_unreadable'
  if ((replacements || []).length > 0) return 'hold_replacement'
  return 'move'
}
