// lib/engagement-rollup.ts
// ─────────────────────────────────────────────────────────────
// PURE roll-up of a single client's engagement rows into the two Person
// fields deriveClientStatus reads: engagement_count (all engagements, open +
// closed) and won_summary (the Closed Won aggregate). It is the same math the
// _hub-page.tsx full-hydration sweep does inline (repeatCounts + wonByClient),
// factored out so the /api/leads/[id] Realtime single-lead refetch can ship
// the IDENTICAL roll-ups.
//
// WHY it matters: leadsRealtime.upsertRealtimePerson REPLACES the person in
// place (last-wins — the refetch is the server's whole truth for that row). If
// the refetch omitted these roll-ups, a Realtime leads event on a settled-lost
// or won client would strip person.engagementCount / person.wonEngagements and
// the row would revert to a funnel status (New/Attempting) until the next full
// page load. This keeps the refetch at parity with hydration.
//
// Output keys are the people-mapper `joined` shape (snake_case) so the result
// spreads straight into mapLeadToPerson's second argument.
// ─────────────────────────────────────────────────────────────

export interface EngagementRollupRow {
  stage?: string | null
  total_paid?: number | string | null
  total_invoiced?: number | string | null
  closed_at?: string | null
}

export interface EngagementRollup {
  engagement_count: number
  won_summary: { count: number; value: number; lastClosedAt: string | null } | null
}

export function rollUpEngagements(rows: EngagementRollupRow[] | null | undefined): EngagementRollup {
  const list = rows || []
  let won_summary: EngagementRollup['won_summary'] = null
  for (const r of list) {
    if (r.stage !== 'Closed Won') continue
    // Same value basis as the hub-page sweep: total_paid, else total_invoiced.
    if (!won_summary) won_summary = { count: 0, value: 0, lastClosedAt: null }
    won_summary.count += 1
    won_summary.value += Number(r.total_paid) || Number(r.total_invoiced) || 0
    if (r.closed_at && (!won_summary.lastClosedAt || r.closed_at > won_summary.lastClosedAt)) {
      won_summary.lastClosedAt = r.closed_at
    }
  }
  return { engagement_count: list.length, won_summary }
}
