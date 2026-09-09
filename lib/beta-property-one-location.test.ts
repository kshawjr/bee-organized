// lib/beta-property-one-location.test.ts
//
// --location: sweeping and committing ONE franchise at a time.
//
// The dry run with --skip-near-duplicates says --commit would write 1,127
// addresses across 35 franchises in one go. Kevin wants to do one, look at the
// cards, then continue — so the flag has to be trustworthy in two ways that
// have nothing to do with sweeping:
//
//   1. A SLUG THAT NAMES NOTHING MUST FAIL LOUDLY. Before this, a typo left an
//      empty location list and the run reported "0 locations in scope" with no
//      errors and exit 0. That reads as success. He would go and look at cards
//      that were never touched and conclude the sweep is broken. This is the
//      mutation this file is written against.
//   2. THE CHECKPOINT MUST NOT SKIP A LOCATION HE ASKED FOR. Scope is recorded
//      in the checkpoint and a resume across a scope change is refused.

import { describe, it, expect } from 'vitest'
import {
  selectRequestedLocations,
  UnknownLocationError,
  normalizeScope,
  assertResumable,
  emptyProgress,
  runBackfill,
  totalCounts,
  PHILLY_SLUG,
  type SweepDeps,
  type Progress,
} from './property-backfill'

const NOW = '2026-09-09T12:00:00.000Z'

const loc = (location_id: string, extra: Record<string, any> = {}) => ({
  location_id,
  name: location_id.toUpperCase(),
  jobber_account_id: 'acct-1',
  ...extra,
})

const ROWS = [
  loc('loc_kc'),
  loc('loc_portland'),
  loc('loc_seattle'),
  loc(PHILLY_SLUG),
  loc('loc_notconnected', { jobber_account_id: null }),
]

// ── choosing the locations ────────────────────────────────────────────────

describe('selectRequestedLocations', () => {
  it('with no --location, sweeps everything in scope', () => {
    const got = selectRequestedLocations(ROWS, {}).map((r) => r.location_id)
    expect(got).toEqual(['loc_kc', 'loc_portland', 'loc_seattle'])
  })

  it('with one slug, sweeps only that one', () => {
    const got = selectRequestedLocations(ROWS, { only: ['loc_kc'] }).map((r) => r.location_id)
    expect(got).toEqual(['loc_kc'])
  })

  it('is repeatable, and always in scope order rather than typed order', () => {
    const got = selectRequestedLocations(ROWS, { only: ['loc_seattle', 'loc_kc'] }).map((r) => r.location_id)
    expect(got).toEqual(['loc_kc', 'loc_seattle'])
  })

  it('composes with --include-philly', () => {
    const got = selectRequestedLocations(ROWS, {
      includePhilly: true,
      only: [PHILLY_SLUG],
    }).map((r) => r.location_id)
    expect(got).toEqual([PHILLY_SLUG])
  })
})

// ── the loud failure ──────────────────────────────────────────────────────

describe('a slug that names nothing this run would sweep', () => {
  it('throws rather than quietly sweeping nothing', () => {
    expect(() => selectRequestedLocations(ROWS, { only: ['loc_kansascity'] }))
      .toThrow(UnknownLocationError)
  })

  it('says what was expected, so the typo is obvious', () => {
    let msg = ''
    try {
      selectRequestedLocations(ROWS, { only: ['loc_kansascity'] })
    } catch (e: any) {
      msg = e.message
    }
    expect(msg).toContain('loc_kansascity')
    expect(msg).toContain('no location with that slug has a Jobber account')
    expect(msg).toContain('in scope for this run')
    expect(msg).toContain('loc_kc')
    expect(msg).toContain('loc_portland')
  })

  it('a location with no Jobber account is unknown, not silently dropped', () => {
    expect(() => selectRequestedLocations(ROWS, { only: ['loc_notconnected'] }))
      .toThrow(UnknownLocationError)
  })

  it('one bad slug among good ones fails the whole run — no partial sweep', () => {
    expect(() => selectRequestedLocations(ROWS, { only: ['loc_kc', 'loc_typo'] }))
      .toThrow(UnknownLocationError)
  })
})

// ── Philly: naming it does NOT override --include-philly ──────────────────
//
// DECIDED, and stated here because it was a judgement call: --include-philly is
// the switch that says "yes, sweep the 18,889-client account". --location is
// scope selection, not permission. Letting the quieter flag sidestep the louder
// one would mean two flags control the same thing.

describe('naming Philadelphia Suburbs explicitly', () => {
  it('does NOT override --include-philly — it fails instead', () => {
    expect(() => selectRequestedLocations(ROWS, { only: [PHILLY_SLUG] }))
      .toThrow(UnknownLocationError)
  })

  it('fails with the flag that would allow it, not as an unknown slug', () => {
    let err: any
    try {
      selectRequestedLocations(ROWS, { only: [PHILLY_SLUG] })
    } catch (e) {
      err = e
    }
    expect(err.outOfScope).toEqual([PHILLY_SLUG])
    expect(err.unknown).toEqual([])
    expect(err.message).toContain('--include-philly')
    expect(err.message).toContain('that location exists')
  })

  it('is swept when both flags are given', () => {
    const got = selectRequestedLocations(ROWS, { includePhilly: true, only: [PHILLY_SLUG] })
    expect(got.map((r) => r.location_id)).toEqual([PHILLY_SLUG])
  })
})

// ── through the whole sweep ───────────────────────────────────────────────

function sweepHarness(over: Partial<SweepDeps> = {}) {
  const writes: Array<{ leadId: string; next: any[] }> = []
  const queried: string[] = []
  const loaded: string[] = []
  const deps: SweepDeps = {
    runQuery: async (locationId) => {
      queried.push(locationId)
      return { data: { clients: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }
    },
    loadLeads: async (locationId) => {
      loaded.push(locationId)
      return []
    },
    appendAddress: async (leadId, next) => { writes.push({ leadId, next }) },
    saveProgress: async () => {},
    now: () => NOW,
    sleep: async () => {},
    log: () => {},
    ...over,
  }
  return { deps, writes, queried, loaded }
}

const property = (id: string, street: string, city: string, province: string, postalCode: string) => ({
  id,
  address: { street, city, province, postalCode },
})

const KC_PAGE = {
  data: {
    clients: {
      nodes: [{
        id: '111',
        firstName: 'Dana',
        lastName: 'Reyes',
        companyName: null,
        clientProperties: {
          totalCount: 3,
          nodes: [
            property('9001', '2709 Tomahawk Rd', 'Mission Hills', 'KS', '66208'),
            property('9002', '2709 Tomahawk Rd Apt 5', 'Mission Hills', 'KS', '66208'),
            property('9003', '8300 NE Underground Dr', 'Kansas City', 'MO', '64161'),
          ],
        },
      }],
      pageInfo: { hasNextPage: false, endCursor: 'c1' },
    },
  },
}

const KC_LEAD = [{
  id: 'lead-1',
  jobber_client_id: '111',
  address: '2709 Tomahawk Rd',
  city: 'Mission Hills',
  state: 'KS',
  zip: '',
  former_addresses: [],
}]

describe('a valid slug through the whole sweep', () => {
  it('reads and queries ONLY that location', async () => {
    const h = sweepHarness()
    await runBackfill(ROWS, h.deps, { mode: 'dry-run', only: ['loc_kc'] })
    expect(h.queried).toEqual(['loc_kc'])
    expect(h.loaded).toEqual(['loc_kc'])
  })

  it('leaves the other franchises completely alone', async () => {
    const h = sweepHarness()
    const progress = await runBackfill(ROWS, h.deps, { mode: 'dry-run', only: ['loc_kc'] })
    expect(Object.keys(progress.counts)).toEqual(['loc_kc'])
    expect(h.queried).not.toContain('loc_portland')
    expect(h.queried).not.toContain('loc_seattle')
  })
})

describe('an invalid slug through the whole sweep', () => {
  it('does NO Jobber work and NO writes', async () => {
    const h = sweepHarness()
    await expect(
      runBackfill(ROWS, h.deps, { mode: 'commit', only: ['loc_typo'] }),
    ).rejects.toThrow(UnknownLocationError)

    // The whole point: nothing reached a franchise account.
    expect(h.queried).toEqual([])
    expect(h.loaded).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('does not report a clean run — it throws', async () => {
    const h = sweepHarness()
    const result = await runBackfill(ROWS, h.deps, { mode: 'commit', only: ['loc_typo'] })
      .then(() => 'resolved', () => 'threw')
    expect(result).toBe('threw')
  })
})

// ── composition ───────────────────────────────────────────────────────────

describe('--location composes with the other flags', () => {
  const kcHarness = () =>
    sweepHarness({
      loadLeads: async () => KC_LEAD as any,
      runQuery: async () => KC_PAGE,
    })

  it('with --skip-near-duplicates: near-dupes still withheld inside that location', async () => {
    const h = kcHarness()
    const progress = await runBackfill(ROWS, h.deps, {
      mode: 'commit',
      only: ['loc_kc'],
      skipNearDuplicates: true,
    })
    const c = totalCounts(progress)

    expect(c.would_create).toBe(3)
    expect(c.near_duplicates_skipped_by_flag).toBe(1)
    expect(c.created).toBe(2)
    expect(h.writes).toHaveLength(2)
    expect(Object.keys(progress.counts)).toEqual(['loc_kc'])
  })

  it('with --commit alone: that one location is written in full', async () => {
    const h = kcHarness()
    const progress = await runBackfill(ROWS, h.deps, { mode: 'commit', only: ['loc_kc'] })
    expect(h.writes).toHaveLength(3)
    expect(totalCounts(progress).created).toBe(3)
    expect(Object.keys(progress.counts)).toEqual(['loc_kc'])
  })

  it('with a dry run: still writes nothing', async () => {
    const h = kcHarness()
    await runBackfill(ROWS, h.deps, { mode: 'dry-run', only: ['loc_kc'], skipNearDuplicates: true })
    expect(h.writes).toEqual([])
  })

  it('with --include-philly and a named location, only that one is swept', async () => {
    const h = sweepHarness()
    await runBackfill(ROWS, h.deps, { mode: 'dry-run', includePhilly: true, only: [PHILLY_SLUG] })
    expect(h.queried).toEqual([PHILLY_SLUG])
  })
})

// ── the checkpoint ────────────────────────────────────────────────────────
//
// DECIDED: the checkpoint is SCOPED. The CLI's default filename carries the
// scope, so one franchise at a time gets its own resumable checkpoint and
// never collides with another; and the scope is recorded inside the file so a
// resume across a scope change is refused rather than silently skipping a
// location Kevin has just named.

describe('the checkpoint is scoped to what the run swept', () => {
  it('records the scope it was written for', () => {
    const p = emptyProgress('commit', false, NOW, ['loc_kc'])
    expect(p.scope).toEqual(['loc_kc'])
  })

  it('records an empty scope for a whole-estate run', () => {
    expect(emptyProgress('commit', false, NOW).scope).toEqual([])
    expect(emptyProgress('commit', false, NOW, []).scope).toEqual([])
  })

  it('sorts and de-duplicates, so flag order cannot make two different scopes', () => {
    expect(normalizeScope(['loc_b', 'loc_a', 'loc_b'])).toEqual(['loc_a', 'loc_b'])
    expect(emptyProgress('commit', false, NOW, ['loc_b', 'loc_a']).scope)
      .toEqual(emptyProgress('commit', false, NOW, ['loc_a', 'loc_b']).scope)
  })

  it('resumes happily within the same scope', () => {
    const p = emptyProgress('commit', false, NOW, ['loc_kc'])
    expect(() => assertResumable(p, 'commit', false, ['loc_kc'])).not.toThrow()
  })

  // THE STALE-CHECKPOINT FAILURE, refused. Without this, resuming loc_kc's
  // checkpoint while asking for loc_seattle would carry loc_kc's completed
  // list forward and skip nothing visibly — and re-naming loc_kc later would
  // find it "already done".
  it('refuses to resume one location under a different one', () => {
    const p = emptyProgress('commit', false, NOW, ['loc_kc'])
    expect(() => assertResumable(p, 'commit', false, ['loc_seattle']))
      .toThrow(/written for loc_kc; this run is for loc_seattle/)
  })

  it('refuses to resume a whole-estate checkpoint as a single location', () => {
    const p = emptyProgress('commit', false, NOW)
    expect(() => assertResumable(p, 'commit', false, ['loc_kc']))
      .toThrow(/every location in scope; this run is for loc_kc/)
  })

  it('refuses to resume a single-location checkpoint as a whole-estate run', () => {
    const p = emptyProgress('commit', false, NOW, ['loc_kc'])
    expect(() => assertResumable(p, 'commit', false))
      .toThrow(/written for loc_kc; this run is for every location in scope/)
  })

  it('still refuses a mode change, exactly as before', () => {
    const p = emptyProgress('dry-run', false, NOW, ['loc_kc'])
    expect(() => assertResumable(p, 'commit', false, ['loc_kc'])).toThrow(/dry-run run/)
  })

  it('treats a checkpoint written before scope existed as a whole-estate run', () => {
    // Forward compatibility for a file already on Kevin's disk: no scope field
    // meant no --location, which is what an empty scope says.
    const old = { ...emptyProgress('dry-run', false, NOW) } as Progress
    delete (old as any).scope
    expect(() => assertResumable(old, 'dry-run', false)).not.toThrow()
    expect(() => assertResumable(old, 'dry-run', false, ['loc_kc'])).toThrow(/every location in scope/)
  })

  it('a resumed single-location run does not re-sweep a completed location', async () => {
    const prior = emptyProgress('dry-run', false, NOW, ['loc_kc'])
    prior.completed.push('loc_kc')
    const h = sweepHarness()
    await runBackfill(ROWS, h.deps, { mode: 'dry-run', only: ['loc_kc'] }, prior)
    expect(h.queried).toEqual([])
  })
})
