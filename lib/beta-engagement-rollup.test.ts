// issue 187 follow-up — the realtime single-lead refetch (/api/leads/[id])
// must ship the SAME engagement roll-ups as the _hub-page.tsx full-hydration
// sweep, or a Realtime leads event would strip person.engagementCount /
// person.wonEngagements (upsertRealtimePerson replaces last-wins) and a
// settled-lost or won client would revert to a funnel status until reload.
//
// rollUpEngagements is that shared math. Its output keys are the people-mapper
// `joined` shape, and mapping it through must reproduce person.engagementCount
// and person.wonEngagements exactly.
import { describe, it, expect } from 'vitest'
import { rollUpEngagements } from '@/lib/engagement-rollup'
import { mapLeadToPerson } from '@/lib/people-mapper'

describe('rollUpEngagements — engagement_count', () => {
  it('counts every engagement, open or closed', () => {
    expect(rollUpEngagements([
      { stage: 'New' },
      { stage: 'Closed Lost' },
      { stage: 'Closed Won' },
    ]).engagement_count).toBe(3)
  })

  it('is 0 for no rows (raw lead — the settled rule must not apply)', () => {
    expect(rollUpEngagements([]).engagement_count).toBe(0)
    expect(rollUpEngagements(null).engagement_count).toBe(0)
    expect(rollUpEngagements(undefined).engagement_count).toBe(0)
  })
})

describe('rollUpEngagements — won_summary (mirrors the hub-page sweep)', () => {
  it('is null when the client has never won (all Closed Lost / open)', () => {
    expect(rollUpEngagements([{ stage: 'Closed Lost' }, { stage: 'Estimate' }]).won_summary).toBeNull()
  })

  it('aggregates count, value (paid else invoiced), and latest closed_at', () => {
    const { won_summary } = rollUpEngagements([
      { stage: 'Closed Won', total_paid: 1200, total_invoiced: 1500, closed_at: '2026-01-10T00:00:00Z' },
      { stage: 'Closed Won', total_paid: 0, total_invoiced: 800, closed_at: '2026-03-02T00:00:00Z' },
      { stage: 'Closed Lost', total_invoiced: 999, closed_at: '2026-05-01T00:00:00Z' }, // ignored
    ])
    expect(won_summary).toEqual({
      count: 2,
      value: 1200 + 800, // 2nd falls back to total_invoiced when paid is 0
      lastClosedAt: '2026-03-02T00:00:00Z', // latest among WON only, not the Lost row
    })
  })
})

describe('rollUpEngagements — spreads into mapLeadToPerson at parity', () => {
  const row: any = { id: 'l-1', location_id: 'loc-1', name: 'Nancy Elder', created_at: '2026-08-01T00:00:00Z' }

  it('reproduces person.engagementCount and person.wonEngagements', () => {
    const rollup = rollUpEngagements([
      { stage: 'Closed Won', total_paid: 500, closed_at: '2026-02-01T00:00:00Z' },
      { stage: 'Closed Lost' },
    ])
    const person = mapLeadToPerson(row, { ...rollup })
    expect(person.engagementCount).toBe(2)
    expect(person.wonEngagements).toEqual({ count: 1, value: 500, lastClosedAt: '2026-02-01T00:00:00Z' })
  })

  it('a settled-lost client maps to engagementCount>0, wonEngagements null', () => {
    const person = mapLeadToPerson(row, { ...rollUpEngagements([{ stage: 'Closed Lost' }]) })
    expect(person.engagementCount).toBe(1)
    expect(person.wonEngagements).toBeNull()
  })
})
