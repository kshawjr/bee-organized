// lib/beta-property-skip-near-duplicates.test.ts
//
// --skip-near-duplicates: the write filter, and the one row it must never
// touch.
//
// The labelled dry run returned 1,342 would-creates — 1,107 genuinely new, 19
// a different unit in a building we already hold, 216 near-duplicates. Kevin
// wants the 216 left out. The DANGER is the 19: they are real second
// properties, and a filter that took them too would drop them with no trace in
// the output and no error anywhere. So the tests below spend most of their
// effort on the boundary rather than on the happy path, and the mutation this
// file is written against is "skip different-unit as well".

import { describe, it, expect } from 'vitest'
import {
  isWithheldByFlag,
  runBackfill,
  totalCounts,
  formatReport,
  type SweepDeps,
  type Progress,
} from './property-backfill'

const NOW = '2026-09-09T12:00:00.000Z'
const LOC = { location_id: 'loc_kc', name: 'Kansas City', jobber_account_id: 'acct-1' }

function sweepHarness(over: Partial<SweepDeps> = {}) {
  const writes: Array<{ leadId: string; next: any[] }> = []
  const saved: Progress[] = []
  const deps: SweepDeps = {
    runQuery: async () => ({ data: { clients: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
    loadLeads: async () => [],
    appendAddress: async (leadId, next) => { writes.push({ leadId, next }) },
    saveProgress: async (p) => { saved.push(JSON.parse(JSON.stringify(p))) },
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
    ...over,
  }
  return { deps, writes, saved }
}

const property = (id: string, street: string, city: string, province: string, postalCode: string) => ({
  id,
  address: { street, city, province, postalCode },
})

const clientsPage = (props: any[]) => ({
  data: {
    clients: {
      nodes: [{
        id: '111',
        firstName: 'Dana',
        lastName: 'Reyes',
        companyName: null,
        clientProperties: { totalCount: props.length, nodes: props },
      }],
      pageInfo: { hasNextPage: false, endCursor: 'c1' },
    },
  },
})

// The primary carries no zip — the commonest defect in the run — so the first
// property below reads as a near-duplicate of it.
const KC_LEAD = [{
  id: 'lead-1',
  jobber_client_id: '111',
  address: '2709 Tomahawk Rd',
  city: 'Mission Hills',
  state: 'KS',
  zip: '',
  former_addresses: [],
}]

const NEAR_DUP = property('9001', '2709 Tomahawk Rd', 'Mission Hills', 'KS', '66208')
const DIFFERENT_UNIT = property('9002', '2709 Tomahawk Rd Apt 5', 'Mission Hills', 'KS', '66208')
const GENUINELY_NEW = property('9003', '8300 NE Underground Dr', 'Kansas City', 'MO', '64161')

const ALL_THREE = clientsPage([NEAR_DUP, DIFFERENT_UNIT, GENUINELY_NEW])

const run = async (opts: any) => {
  const h = sweepHarness({ loadLeads: async () => KC_LEAD as any, runQuery: async () => ALL_THREE })
  const progress = await runBackfill([LOC], h.deps, opts)
  return { progress, writes: h.writes, counts: totalCounts(progress) }
}

const addressesWritten = (writes: Array<{ next: any[] }>) =>
  writes.map((w) => w.next[w.next.length - 1].display)

// ── the flag itself ───────────────────────────────────────────────────────

describe('isWithheldByFlag', () => {
  it('withholds ONLY near-duplicates, and only when the flag is on', () => {
    expect(isWithheldByFlag('near-duplicate', true)).toBe(true)
    expect(isWithheldByFlag('different-unit', true)).toBe(false)
    expect(isWithheldByFlag('new', true)).toBe(false)
  })

  it('withholds nothing at all when the flag is off, absent or undefined', () => {
    for (const label of ['near-duplicate', 'different-unit', 'new'] as const) {
      expect(isWithheldByFlag(label, false)).toBe(false)
      expect(isWithheldByFlag(label, undefined)).toBe(false)
      expect(isWithheldByFlag(label, null)).toBe(false)
    }
  })
})

// ── flag OFF: nothing changed ─────────────────────────────────────────────

describe('with the flag OFF (the default)', () => {
  it('writes all three kinds — the existing behaviour, unchanged', async () => {
    const { writes, counts } = await run({ mode: 'commit' })
    expect(writes).toHaveLength(3)
    expect(counts.created).toBe(3)
    expect(counts.near_duplicates_skipped_by_flag).toBe(0)
  })

  it('behaves identically whether the option is absent or explicitly false', async () => {
    const absent = await run({ mode: 'commit' })
    const explicit = await run({ mode: 'commit', skipNearDuplicates: false })
    expect(addressesWritten(explicit.writes)).toEqual(addressesWritten(absent.writes))
    expect(explicit.counts.created).toBe(absent.counts.created)
  })
})

// ── flag ON ───────────────────────────────────────────────────────────────

describe('with the flag ON', () => {
  it('does not write the near-duplicate, and still writes the other two', async () => {
    const { writes, counts } = await run({ mode: 'commit', skipNearDuplicates: true })

    expect(writes).toHaveLength(2)
    expect(counts.created).toBe(2)

    const written = addressesWritten(writes)
    expect(written).toContain('2709 Tomahawk Rd Apt 5, Mission Hills, KS, 66208')
    expect(written).toContain('8300 NE Underground Dr, Kansas City, MO, 64161')
    expect(written).not.toContain('2709 Tomahawk Rd, Mission Hills, KS, 66208')
  })

  // ── THE MUTATION TARGET ────────────────────────────────────────────────
  // Nineteen real second properties ride on this. A filter that also took
  // different-unit rows would drop them with nothing in the output to say so,
  // which is exactly why it is asserted on its own rather than only as part of
  // the count above.
  it('STILL writes the different-unit row — it is a real second property', async () => {
    const { writes, counts } = await run({ mode: 'commit', skipNearDuplicates: true })
    expect(addressesWritten(writes)).toContain('2709 Tomahawk Rd Apt 5, Mission Hills, KS, 66208')
    expect(counts.would_create_different_unit).toBe(1)
    // Counted as a would-create AND actually written.
    expect(counts.created).toBe(2)
  })

  it('STILL writes the genuinely new row', async () => {
    const { writes } = await run({ mode: 'commit', skipNearDuplicates: true })
    expect(addressesWritten(writes)).toContain('8300 NE Underground Dr, Kansas City, MO, 64161')
  })

  it('reports what it left behind in its own counter', async () => {
    const { counts } = await run({ mode: 'commit', skipNearDuplicates: true })
    expect(counts.near_duplicates_skipped_by_flag).toBe(1)
    // Not folded into anything: the row is still a would-create and still
    // labelled a near-duplicate, it just was not written.
    expect(counts.would_create).toBe(3)
    expect(counts.would_create_near_duplicate).toBe(1)
    expect(counts.created).toBe(2)
  })

  it('does not treat a withheld address as if the card now holds it', async () => {
    // Two Jobber properties at the same near-duplicate address. Neither is
    // written, so BOTH must read as near-duplicates that were skipped — if the
    // first were added to the in-memory card, the second would be counted as
    // "already listed" and the number Kevin sees would be wrong.
    const h = sweepHarness({
      loadLeads: async () => KC_LEAD as any,
      runQuery: async () =>
        clientsPage([NEAR_DUP, property('9004', '2709 Tomahawk Rd', 'Mission Hills', 'KS', '66208')]),
    })
    const progress = await runBackfill([LOC], h.deps, { mode: 'commit', skipNearDuplicates: true })
    const c = totalCounts(progress)

    expect(c.would_create_near_duplicate).toBe(2)
    expect(c.near_duplicates_skipped_by_flag).toBe(2)
    expect(c.already_listed_active).toBe(0)
    expect(h.writes).toHaveLength(0)
  })
})

// ── flag ON in a dry run ──────────────────────────────────────────────────

describe('with the flag ON in a DRY RUN', () => {
  it('writes nothing at all — the dry-run guard still comes first', async () => {
    const { writes, counts } = await run({ mode: 'dry-run', skipNearDuplicates: true })
    expect(writes).toHaveLength(0)
    expect(counts.created).toBe(0)
  })

  it('still LISTS the near-duplicate, so nothing vanishes from the review', async () => {
    const { progress } = await run({ mode: 'dry-run', skipNearDuplicates: true })

    expect(progress.findings).toHaveLength(3)
    const near = progress.findings.find((f) => f.label === 'near-duplicate')!
    expect(near).toBeTruthy()
    expect(near.address).toBe('2709 Tomahawk Rd, Mission Hills, KS, 66208')
    expect(near.skipped_by_flag).toBe(true)
  })

  it('marks only the near-duplicate as would-be-skipped', async () => {
    const { progress } = await run({ mode: 'dry-run', skipNearDuplicates: true })
    const byLabel = Object.fromEntries(progress.findings.map((f) => [f.label, f.skipped_by_flag]))
    expect(byLabel['near-duplicate']).toBe(true)
    expect(byLabel['different-unit']).toBe(false)
    expect(byLabel['new']).toBe(false)
  })

  it('previews the number that would be left behind', async () => {
    const { counts } = await run({ mode: 'dry-run', skipNearDuplicates: true })
    expect(counts.near_duplicates_skipped_by_flag).toBe(1)
  })

  it('marks nothing when the flag is off', async () => {
    const { progress } = await run({ mode: 'dry-run' })
    expect(progress.findings.every((f) => f.skipped_by_flag === false)).toBe(true)
  })
})

// ── the report says so ────────────────────────────────────────────────────

describe('the report', () => {
  it('says on the row and in the heading which ones would be skipped', async () => {
    const { progress } = await run({ mode: 'dry-run', skipNearDuplicates: true })
    const report = formatReport(progress)

    expect(report).toContain('[WOULD BE SKIPPED]')
    expect(report).toContain('WOULD BE SKIPPED by --skip-near-duplicates')
    expect(report).toContain('withheld by --skip-near-duplicates   1')
    // The address itself is still printed for review.
    expect(report).toContain('2709 Tomahawk Rd, Mission Hills, KS, 66208')
  })

  it('never marks a different-unit or a new row', async () => {
    const { progress } = await run({ mode: 'dry-run', skipNearDuplicates: true })
    const report = formatReport(progress)
    const unitLine = report
      .split('\n')
      .find((l) => l.includes('DIFFERENT UNIT —'))!
    expect(unitLine).not.toContain('WOULD BE SKIPPED')
  })

  it('shows a zero and no markers when the flag is off', async () => {
    const { progress } = await run({ mode: 'dry-run' })
    const report = formatReport(progress)
    expect(report).toContain('withheld by --skip-near-duplicates   0')
    expect(report).not.toContain('[WOULD BE SKIPPED]')
  })
})
