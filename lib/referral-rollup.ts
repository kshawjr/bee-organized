// lib/referral-rollup.ts
// ─────────────────────────────────────────────────────────────
// THE referral rollup — pure. Given the leads a partner/company referred and
// those leads' engagements, compute what each referral actually PRODUCED.
//
// This replaces two fictions:
//   · partners.referrals[].revenue — jsonb seeded 0, never computed, summed
//     in three Classic surfaces as if it were real. Always $0.
//   · partners.referrals[].converted — a jsonb boolean nobody maintains.
// Both now derive from the real join: referred lead → engagements →
// total_paid / stage. The jsonb array stays untouched (Classic still renders
// it); these numbers are what the API returns and what Phase 2 renders.
//
// Vocabulary (matches the terminal-stage contract):
//   converted — the lead has ≥1 engagement at 'Closed Won'. Won IS conversion;
//               closed_reason is asymmetric and never consulted here.
//   revenue   — SUM of engagements.total_paid across ALL the lead's
//               engagements (money actually collected, not invoiced).
//               NOT leads.paid_amount — that rollup is last-paid-wins, not a
//               sum, and would under-report multi-engagement clients.
//   status    — a coarse chip for the referral row:
//               'client' (converted) · 'active' (an open engagement) ·
//               'lost' (engagements, all Closed Lost) · 'lead' (none yet).
// ─────────────────────────────────────────────────────────────

const CLOSED_WON = 'Closed Won'
const CLOSED_LOST = 'Closed Lost'

export type ReferralLeadRow = {
  id: string
  name: string | null
  created_at: string | null
}

export type ReferralEngagementRow = {
  client_id: string
  stage: string | null
  total_paid: number | null
}

export type ReferredLeadRollup = ReferralLeadRow & {
  converted: boolean
  revenue: number
  engagement_count: number
  status: 'client' | 'active' | 'lost' | 'lead'
}

export type ReferralTotals = {
  count: number
  converted: number
  revenue: number
}

const isOpen = (stage: string | null) =>
  stage !== CLOSED_WON && stage !== CLOSED_LOST

// Per-lead rollup. Engagements not belonging to any given lead are ignored,
// so callers can pass one bulk-fetched engagement array for the whole page.
export function rollupReferredLeads(
  leads: ReferralLeadRow[],
  engagements: ReferralEngagementRow[]
): ReferredLeadRollup[] {
  const byLead = new Map<string, ReferralEngagementRow[]>()
  for (const e of engagements) {
    if (!e?.client_id) continue
    const list = byLead.get(e.client_id)
    if (list) list.push(e)
    else byLead.set(e.client_id, [e])
  }

  return leads.map((lead) => {
    const engs = byLead.get(lead.id) ?? []
    const converted = engs.some((e) => e.stage === CLOSED_WON)
    const revenue = engs.reduce((sum, e) => sum + (Number(e.total_paid) || 0), 0)
    const status: ReferredLeadRollup['status'] = converted
      ? 'client'
      : engs.some((e) => isOpen(e.stage))
        ? 'active'
        : engs.length > 0
          ? 'lost'
          : 'lead'
    return { ...lead, converted, revenue, engagement_count: engs.length, status }
  })
}

// The header numbers: how many they sent, how many became clients, what it
// was all worth. Computed from the rollup so the two can never disagree.
export function referralTotals(rows: ReferredLeadRollup[]): ReferralTotals {
  return {
    count: rows.length,
    converted: rows.filter((r) => r.converted).length,
    revenue: rows.reduce((sum, r) => sum + r.revenue, 0),
  }
}
