// @vitest-environment node
//
// Network Phase 1 — the referral rollup computes REAL numbers from real
// joins. The fictions it replaces: partners.referrals[].revenue (jsonb
// seeded 0, summed on three Classic surfaces as if real — always $0) and
// referrals[].converted (a jsonb boolean nobody maintains).
//
// Pins:
//   A) revenue = SUM of engagements.total_paid across ALL a lead's
//      engagements — never zero-by-construction, never last-paid-wins
//   B) converted = ≥1 engagement at 'Closed Won' (terminal-stage contract;
//      closed_reason is never consulted)
//   C) status chip: client / active / lost / lead
//   D) totals agree with the per-row rollup by construction
//   E) engagements for OTHER leads in the same bulk fetch never bleed in
import { describe, it, expect } from 'vitest'
import { rollupReferredLeads, referralTotals } from '@/lib/referral-rollup'

const lead = (id: string, name = id) => ({ id, name, created_at: '2026-07-01T00:00:00Z' })

describe('A) revenue is a real sum, not the seeded zero', () => {
  it('sums total_paid across ALL of a lead’s engagements', () => {
    const rows = rollupReferredLeads(
      [lead('L1')],
      [
        { client_id: 'L1', stage: 'Closed Won', total_paid: 1250.5 },
        { client_id: 'L1', stage: 'Job In Progress', total_paid: 300 },
      ]
    )
    expect(rows[0].revenue).toBe(1550.5)
    expect(rows[0].engagement_count).toBe(2)
  })

  it('null / missing total_paid counts as 0, not NaN', () => {
    const rows = rollupReferredLeads(
      [lead('L1')],
      [{ client_id: 'L1', stage: 'Closed Won', total_paid: null }]
    )
    expect(rows[0].revenue).toBe(0)
  })
})

describe('B) converted derives from Closed Won', () => {
  it('any Closed Won engagement converts the referral', () => {
    const rows = rollupReferredLeads(
      [lead('L1')],
      [
        { client_id: 'L1', stage: 'Closed Lost', total_paid: 0 },
        { client_id: 'L1', stage: 'Closed Won', total_paid: 900 },
      ]
    )
    expect(rows[0].converted).toBe(true)
    expect(rows[0].status).toBe('client')
  })

  it('open engagements alone do not convert', () => {
    const rows = rollupReferredLeads(
      [lead('L1')],
      [{ client_id: 'L1', stage: 'Estimate', total_paid: 0 }]
    )
    expect(rows[0].converted).toBe(false)
  })
})

describe('C) status chip', () => {
  it('open engagement → active; all Closed Lost → lost; none → lead', () => {
    const rows = rollupReferredLeads(
      [lead('open'), lead('lost'), lead('bare')],
      [
        { client_id: 'open', stage: 'Request', total_paid: 0 },
        { client_id: 'lost', stage: 'Closed Lost', total_paid: 0 },
      ]
    )
    expect(rows.map(r => r.status)).toEqual(['active', 'lost', 'lead'])
  })
})

describe('D) totals', () => {
  it('count / converted / revenue roll up from the rows', () => {
    const rows = rollupReferredLeads(
      [lead('L1'), lead('L2'), lead('L3')],
      [
        { client_id: 'L1', stage: 'Closed Won', total_paid: 1200 },
        { client_id: 'L1', stage: 'Estimate', total_paid: 300 },
        { client_id: 'L2', stage: 'Request', total_paid: 0 },
      ]
    )
    expect(referralTotals(rows)).toEqual({ count: 3, converted: 1, revenue: 1500 })
  })
})

describe('E) bulk-fetch isolation', () => {
  it('another lead’s engagements never bleed into a neighbor’s rollup', () => {
    const rows = rollupReferredLeads(
      [lead('L1'), lead('L2')],
      [
        { client_id: 'L1', stage: 'Closed Won', total_paid: 5000 },
        { client_id: 'UNRELATED', stage: 'Closed Won', total_paid: 99999 },
      ]
    )
    expect(rows.find(r => r.id === 'L2')!.revenue).toBe(0)
    expect(referralTotals(rows).revenue).toBe(5000)
  })
})
