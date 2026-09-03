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
//
// open_enquiry (the "Back again" roll-up, 3 Sept 2026): a returning client's
// website-form resubmission founds an engagement at Request and writes a
// 'Webform resubmission' touchpoint POINTING AT it (engagement_id — see
// app/api/leads/intake/route.ts). That touchpoint is the one row that says
// "this open engagement exists because the client filled in the form again",
// so deriveClientStatus can put the person in the Inbox as new work instead of
// reading them as Active. rollUpOpenEnquiry is the shared math; the hub-page
// sweep and the single-lead refetch both call it so the two can't drift.
// ─────────────────────────────────────────────────────────────

export interface EngagementRollupRow {
  id?: string | null
  stage?: string | null
  total_paid?: number | string | null
  total_invoiced?: number | string | null
  closed_at?: string | null
  created_at?: string | null
}

export interface OpenEnquiryTouchRow {
  label?: string | null
  engagement_id?: string | null
}

export interface OpenEnquiry {
  // engagements.created_at of the resubmission-founded Request engagement —
  // the enquiry date the funnel is anchored on.
  foundedAt: string
  // true when the client has ANY other open engagement (being worked → Active).
  otherOpen: boolean
}

export interface EngagementRollup {
  engagement_count: number
  won_summary: { count: number; value: number; lastClosedAt: string | null } | null
  open_enquiry: OpenEnquiry | null
}

export const WEBFORM_RESUBMISSION_LABEL = 'Webform resubmission'

const isOpenStage = (stage: string | null | undefined) =>
  !!stage && stage !== 'Closed Won' && stage !== 'Closed Lost'

/**
 * The "Back again" roll-up for ONE client. Null unless an OPEN engagement at
 * Request has a 'Webform resubmission' touchpoint pointing at it. When several
 * qualify (two resubmissions founding two engagements is not possible today —
 * the intake surfaces a second form onto the existing open engagement — but
 * be tolerant) the newest wins. otherOpen counts every other open engagement,
 * whatever its stage.
 */
export function rollUpOpenEnquiry(
  engagements: EngagementRollupRow[] | null | undefined,
  touchpoints: OpenEnquiryTouchRow[] | null | undefined,
): OpenEnquiry | null {
  const open = (engagements || []).filter(r => isOpenStage(r.stage))
  if (open.length === 0) return null
  const pointedAt = new Set<string>()
  for (const t of touchpoints || []) {
    if (t.label === WEBFORM_RESUBMISSION_LABEL && t.engagement_id) pointedAt.add(String(t.engagement_id))
  }
  if (pointedAt.size === 0) return null
  const enquiry = open
    .filter(r => r.stage === 'Request' && r.id && pointedAt.has(String(r.id)) && r.created_at)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
  if (!enquiry) return null
  return { foundedAt: String(enquiry.created_at), otherOpen: open.length > 1 }
}

export function rollUpEngagements(
  rows: EngagementRollupRow[] | null | undefined,
  touchpoints: OpenEnquiryTouchRow[] | null | undefined = [],
): EngagementRollup {
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
  return { engagement_count: list.length, won_summary, open_enquiry: rollUpOpenEnquiry(list, touchpoints) }
}
