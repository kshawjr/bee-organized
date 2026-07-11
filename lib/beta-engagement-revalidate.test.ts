// @vitest-environment node
//
// Board focus-revalidation — the PURE merge half (engagementRevalidate.js).
// Working-stage advances (Request → Estimate → Job in Progress → Final
// Processing) land server-side with no client event; HiveShell refetches
// the open set on focus and folds the diff in through these helpers. Pins:
//   · boardSignature       — same board-relevant fields ⇒ equal; a stage
//                            (or chip/value input) change ⇒ different
//   · reconcileServerRows  — changed rows enter the map; unchanged returns
//                            the SAME ref (no re-render); unknown ids and a
//                            row absent from the fresh set are left alone
//                            (server disappearance / reopen stay untouched)
//   · mergeEngagements     — precedence base < serverRevalidated < rowPatches;
//                            a pending close (terminal rowPatch) is NOT
//                            clobbered by a concurrent fetch still listing
//                            the row open
import { describe, it, expect } from 'vitest'
import { boardSignature, reconcileServerRows, mergeEngagements } from '@/components/hive/shared/engagementRevalidate'

const ENG = (over: any = {}) => ({
  id: 'e1', client_id: 'c1', client_name: 'Acme', stage: 'Request',
  created_at: '2026-07-01T00:00:00Z', repeat_count: 1,
  quotes: [], jobs: [], invoices: [], assessments: [], service_requests: [],
  ...over,
})

const baseMap = (...rows: any[]) => new Map(rows.map(r => [r.id, r]))

describe('boardSignature', () => {
  it('is stable across cosmetically-different but board-equal rows', () => {
    // updated_at is deliberately NOT part of the signature (import bumps it).
    expect(boardSignature(ENG({ updated_at: '2026-07-01' })))
      .toBe(boardSignature(ENG({ updated_at: '2026-07-09' })))
  })

  it('changes when the stage moves', () => {
    expect(boardSignature(ENG({ stage: 'Request' })))
      .not.toBe(boardSignature(ENG({ stage: 'Estimate' })))
  })

  it('changes when a chip/value input changes (a quote appears)', () => {
    expect(boardSignature(ENG()))
      .not.toBe(boardSignature(ENG({ quotes: [{ status: 'sent', total: 500, sent_at: 'x', approved_at: null }] })))
  })
})

describe('reconcileServerRows', () => {
  it('folds a server-side stage move into the map', () => {
    const prev = {}
    const base = baseMap(ENG({ stage: 'Request' }))
    const next = reconcileServerRows(prev, [ENG({ stage: 'Estimate' })], base)
    expect(next).not.toBe(prev)
    expect(next.e1.stage).toBe('Estimate')
  })

  it('returns the SAME ref when nothing board-relevant changed (no re-render)', () => {
    const prev = {}
    const base = baseMap(ENG({ stage: 'Request' }))
    // fresh row differs only by updated_at → not board-relevant
    const next = reconcileServerRows(prev, [ENG({ stage: 'Request', updated_at: 'later' })], base)
    expect(next).toBe(prev)
  })

  it('ignores rows not already known (new engagements stay reload-only)', () => {
    const prev = {}
    const base = baseMap(ENG({ id: 'e1' }))
    const next = reconcileServerRows(prev, [ENG({ id: 'e999', stage: 'Estimate' })], base)
    expect(next).toBe(prev)
    expect(next.e999).toBeUndefined()
  })

  it('leaves a known row alone when it is absent from the fresh set (a just-reopened row is not clobbered)', () => {
    // e1 was reopened this session (lives in base); a STALE fetch that
    // predates the reopen omits it → reconcile must not touch it.
    const prev = {}
    const base = baseMap(ENG({ id: 'e1', stage: 'Estimate' }), ENG({ id: 'e2', stage: 'Request' }))
    const next = reconcileServerRows(prev, [ENG({ id: 'e2', stage: 'Job in Progress' })], base)
    expect(next.e1).toBeUndefined()   // reopened row untouched
    expect(next.e2.stage).toBe('Job in Progress')
  })
})

describe('mergeEngagements (base < serverRevalidated < rowPatches)', () => {
  it('applies server-revalidated truth over the page-load base', () => {
    const base = [ENG({ stage: 'Request' })]
    const merged = mergeEngagements(base, { e1: ENG({ stage: 'Estimate' }) }, {})
    expect(merged[0].stage).toBe('Estimate')
  })

  it('lets a local rowPatch win over server truth (no clobber of a hand-up)', () => {
    const base = [ENG({ stage: 'Request', title: 'old' })]
    const merged = mergeEngagements(base, { e1: ENG({ stage: 'Estimate', title: 'old' }) }, { e1: { title: 'edited' } })
    expect(merged[0].stage).toBe('Estimate')   // server move still lands
    expect(merged[0].title).toBe('edited')     // local edit not reverted
  })

  it('a pending close (terminal rowPatch) survives a concurrent fetch that still lists the row open', () => {
    const base = [ENG({ stage: 'Request' })]
    // refetch fired BEFORE the close committed → still shows Request
    const server = { e1: ENG({ stage: 'Request' }) }
    const merged = mergeEngagements(base, server, { e1: { stage: 'Closed Lost' } })
    expect(merged[0].stage).toBe('Closed Lost')
  })

  it('returns the base ref untouched when there is nothing to merge', () => {
    const base = [ENG()]
    expect(mergeEngagements(base, {}, {})).toBe(base)
  })
})
