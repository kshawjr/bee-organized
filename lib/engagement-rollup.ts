// lib/engagement-rollup.ts
// ─────────────────────────────────────────────────────────────
// PURE roll-up of a single client's engagement rows into the Person fields
// the status derivation reads: engagement_count (all engagements, open +
// closed), won_summary (the Closed Won aggregate) and last_closed_at (the
// newest Closed Won / Closed Lost close — exit 3 of the Inbox rule, read by
// lib/enquiry-exit.ts against the enquiry date). It is the same math the
// _hub-page.tsx full-hydration sweep does inline, factored out so the
// /api/leads/[id] Realtime single-lead refetch can ship the IDENTICAL
// roll-ups.
//
// WHY it matters: leadsRealtime.upsertRealtimePerson REPLACES the person in
// place (last-wins — the refetch is the server's whole truth for that row). If
// the refetch omitted these roll-ups, a Realtime leads event on a closed or
// won client would strip person.wonEngagements / person.enquiryFacts.closedAts
// and the row would revert to an open enquiry (New/Attempting) until the next
// full page load. This keeps the refetch at parity with hydration.
//
// Output keys are the people-mapper `joined` shape (snake_case) so the result
// spreads straight into mapLeadToPerson's second argument.
//
// (The "Back again" open_enquiry roll-up that lived here for one day —
// 3 Sept 2026 — is gone: the Inbox rule has no exception for it. The chip
// keys on the resubmission touchpoint itself; see clientStatus.isBackAgain.)
// ─────────────────────────────────────────────────────────────

export interface EngagementRollupRow {
  id?: string | null
  stage?: string | null
  total_paid?: number | string | null
  total_invoiced?: number | string | null
  closed_at?: string | null
  created_at?: string | null
}

export interface EngagementRollup {
  engagement_count: number
  won_summary: { count: number; value: number; lastClosedAt: string | null } | null
  last_closed_at: string | null
}

export const isTerminalStage = (stage: string | null | undefined) =>
  stage === 'Closed Won' || stage === 'Closed Lost'

export function rollUpEngagements(rows: EngagementRollupRow[] | null | undefined): EngagementRollup {
  const list = rows || []
  let won_summary: EngagementRollup['won_summary'] = null
  let last_closed_at: string | null = null
  for (const r of list) {
    if (isTerminalStage(r.stage) && r.closed_at && (!last_closed_at || r.closed_at > last_closed_at)) {
      last_closed_at = r.closed_at
    }
    if (r.stage !== 'Closed Won') continue
    // Same value basis as the hub-page sweep: total_paid, else total_invoiced.
    if (!won_summary) won_summary = { count: 0, value: 0, lastClosedAt: null }
    won_summary.count += 1
    won_summary.value += Number(r.total_paid) || Number(r.total_invoiced) || 0
    if (r.closed_at && (!won_summary.lastClosedAt || r.closed_at > won_summary.lastClosedAt)) {
      won_summary.lastClosedAt = r.closed_at
    }
  }
  return { engagement_count: list.length, won_summary, last_closed_at }
}
