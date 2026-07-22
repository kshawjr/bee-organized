// Pins the ONE shared Jobber quoteStatus → local status mapper. upsertQuote
// (import + webhook) and scripts/backfill-quote-status.mjs both call this, so
// this table is the contract that keeps them from drifting.
import { describe, it, expect } from 'vitest'
import { mapQuoteStatus, quoteStatusStampsApproval } from './quote-status-map'

describe('mapQuoteStatus', () => {
  const CASES: Array<[string | null | undefined, string]> = [
    ['DRAFT', 'draft'],
    ['AWAITING_RESPONSE', 'sent'],
    ['CHANGES_REQUESTED', 'changes_requested'],
    ['APPROVED', 'approved'],
    ['CONVERTED', 'approved'],
    ['ARCHIVED', 'archived'],
    [undefined, 'sent'],
    [null, 'sent'],
    ['', 'sent'],
    ['anything-unknown', 'sent'],
    // case-insensitive
    ['draft', 'draft'],
    ['approved', 'approved'],
  ]
  for (const [input, expected] of CASES) {
    it(`${JSON.stringify(input)} → '${expected}'`, () => {
      expect(mapQuoteStatus(input)).toBe(expected)
    })
  }
})

describe('quoteStatusStampsApproval', () => {
  it('stamps only for a literal APPROVED — never CONVERTED or others', () => {
    expect(quoteStatusStampsApproval('APPROVED')).toBe(true)
    expect(quoteStatusStampsApproval('approved')).toBe(true)
    expect(quoteStatusStampsApproval('CONVERTED')).toBe(false)
    expect(quoteStatusStampsApproval('DRAFT')).toBe(false)
    expect(quoteStatusStampsApproval(undefined)).toBe(false)
  })
})
