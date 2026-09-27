// lib/paid-work-repair.ts
// ─────────────────────────────────────────────────────────────
// Planning half of scripts/repair-paid-work-closed-lost.mjs (2026-09-27).
//
// THE DEFECT. The import closed engagements as Lost ('stale_on_import') when
// their only jobs sat at Jobber's "action required" — visits ran out, nobody
// closed the job in Jobber — even though the invoices were paid: 320+ deals,
// ~$1.2M, mostly Seattle. deriveEngagementStage now reads such a job as done
// work when the engagement has money in (see invoiceMoneyIn), so the in-app
// stale-Lost recovery (maybeAdvanceEngagementStage / recoverEngagementStageDrift)
// flips them to Won — but only one at a time, as a webhook or a panel open
// happens to touch each. The script does the same flip for all of them at
// once, after Kevin has read a dry run.
//
// ONE AUTHORITY. The verdict below IS the in-app recovery's decision: the
// same guard (Closed Lost + closed_reason 'stale_on_import', machine stamps
// only — human closes are never touched) and the same derivation call
// (deriveEngagementStage with closeWonOnDone, exactly as the recovery calls
// it). The script imports this module through scripts/ts-alias-hook.mjs; it
// carries no copy of the rule, so it cannot drift from what the app does.
// ─────────────────────────────────────────────────────────────

import { deriveEngagementStage, invoiceMoneyIn, type EngagementChildren } from './engagements'

export type RepairEngagement = {
  id: string
  stage: string | null
  closed_reason: string | null
}

export type RepairVerdict =
  | { kind: 'flip'; closedAt: string }
  | { kind: 'hold'; derived: string; why: string }

/**
 * Would the in-app stale-Lost recovery flip this engagement to Closed Won?
 * 'flip' carries the Won closed_at the recovery would write (the last paid
 * date). Everything else is held, with the reason, for the report.
 */
export function planStaleLostRecovery(eng: RepairEngagement, children: EngagementChildren): RepairVerdict {
  if (eng.stage !== 'Closed Lost' || eng.closed_reason !== 'stale_on_import') {
    return { kind: 'hold', derived: eng.stage ?? 'unknown', why: 'not a machine stale-on-import close' }
  }
  const derived = deriveEngagementStage(children, { closeWonOnDone: true })
  if (derived.stage === 'Closed Won' && derived.closed_at) return { kind: 'flip', closedAt: derived.closed_at }
  const why =
    derived.stage === 'Final Processing' ? 'work done but an invoice is still unpaid'
    : derived.stage === 'Job in Progress' ? 'a booked job is still in flight'
    : 'no finished, paid work on the engagement'
  return { kind: 'hold', derived: derived.stage, why }
}

/** True when the engagement has a paid invoice with money in (report label). */
export function hasMoneyIn(children: EngagementChildren): boolean {
  return children.invoices.some(invoiceMoneyIn)
}
