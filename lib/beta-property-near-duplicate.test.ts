// lib/beta-property-near-duplicate.test.ts
//
// The near-duplicate classifier, pinned to the ACTUAL strings from the first
// dry run — 1,336 would-creates against an expected ~137.
//
// THE ASSERTION THAT MATTERS MOST is the last block: planDriftAddress behaves
// exactly as it did. Everything here is reporting. If the classifier ever
// starts changing what gets created — or what --commit writes — those tests go
// red, and they are the reason it is safe to add this at all while the webhook
// is live in production.

import { describe, it, expect } from 'vitest'
import {
  planDriftAddress,
  parseLooseAddress,
  looseAddressKey,
  compareLoose,
  describeLooseDifference,
  DRIFT_LABEL,
  DRIFT_LABEL_NOTE,
} from './property-drift'
import {
  classifyWouldCreate,
  runBackfill,
  totalCounts,
  formatReport,
  emptyProgress,
  type SweepDeps,
  type Progress,
} from './property-backfill'

// ── the pairs, straight out of the run ────────────────────────────────────

const compare = (a: string, b: string) => compareLoose(parseLooseAddress(a), parseLooseAddress(b))
const why = (a: string, b: string) =>
  describeLooseDifference(parseLooseAddress(a), parseLooseAddress(b))

describe('the near-duplicates the run is full of', () => {
  it('zip missing on the primary — repeats across dozens of Kansas City and Portland rows', () => {
    const jobber = '2709 Tomahawk Rd, Mission Hills, KS, 66208'
    const primary = '2709 Tomahawk Rd, Mission Hills, KS'
    expect(compare(jobber, primary)).toBe('match')
    expect(why(jobber, primary)).toBe('only a zip on one and not the other')
  })

  it('zip+4 against a plain zip', () => {
    const jobber = '3245 SW Holden St, Seattle, WA, 98116-4026'
    const primary = '3245 SW Holden St, Seattle, WA, 98116'
    expect(compare(jobber, primary)).toBe('match')
    expect(why(jobber, primary)).toBe('only zip+4 against a plain zip')
    expect(parseLooseAddress(jobber).zip5).toBe('98116')
  })

  it('the state spelled out against its abbreviation', () => {
    const jobber = '6821 Northwood Rd, Dallas, Texas, 75225'
    const primary = '6821 Northwood Rd, Dallas, TX, 75225'
    expect(compare(jobber, primary)).toBe('match')
    expect(why(jobber, primary)).toBe('only the state spelled out against its abbreviation')
  })

  it('street type — Ave against Avenue', () => {
    const jobber = '1500 Morningside Ave, Atlanta, GA, 30306'
    const primary = '1500 Morningside Avenue, Atlanta, GA, 30306'
    expect(compare(jobber, primary)).toBe('match')
    expect(why(jobber, primary)).toBe('only the street type or direction written differently')
  })

  it('a primary that repeats its own city/state/zip tail', () => {
    const jobber = '2561 South Saint Paul Street, Denver, CO, 80210'
    const primary = '2561 South Saint Paul Street, Denver, CO, 80210, Denver, CO, 80210'
    expect(compare(jobber, primary)).toBe('match')
    expect(why(jobber, primary)).toBe('only a repeated city/state/zip tail')
  })

  it('a Palm Beach primary that repeats it three times', () => {
    const jobber = '223 Seaview Ln, Palm Beach, FL, 33480'
    const primary =
      '223 Seaview Ln, Palm Beach, FL, 33480, Palm Beach, FL, 33480, Palm Beach, FL, 33480'
    expect(compare(jobber, primary)).toBe('match')
  })

  it('the "ST 12345" shape formatLeadAddress renders, against the comma shape', () => {
    expect(compare('2709 Tomahawk Rd, Mission Hills, KS 66208', '2709 Tomahawk Rd, Mission Hills, KS, 66208'))
      .toBe('match')
  })

  it('every one of the above is a real defect, not two of them cancelling out', () => {
    // Each pair really is the same place: the loose keys agree.
    expect(looseAddressKey('6821 Northwood Rd, Dallas, Texas, 75225'))
      .toBe(looseAddressKey('6821 Northwood Rd, Dallas, TX, 75225'))
    expect(looseAddressKey('1500 Morningside Ave, Atlanta, GA, 30306'))
      .toBe(looseAddressKey('1500 Morningside Avenue, Atlanta, GA, 30306'))
  })
})

// ── the trap that would have broken the street normaliser ─────────────────

describe('street normalisation does not eat street NAMES', () => {
  it('"Saint Paul Street" keeps its Saint — only the trailing type is normalised', () => {
    const p = parseLooseAddress('2561 South Saint Paul Street, Denver, CO, 80210')
    expect(p.street).toBe('2561 s saint paul st')
    expect(p.street).not.toContain('street paul')
  })

  it('a type in the middle of a name is left alone, so these stay different places', () => {
    expect(compare('100 Saint Paul St, Denver, CO, 80210', '100 Paul St, Denver, CO, 80210'))
      .toBe('no_match')
  })

  it('a trailing directional does not hide the street type', () => {
    expect(compare('400 Main Street N, Seattle, WA, 98109', '400 Main St N, Seattle, WA, 98109'))
      .toBe('match')
  })
})

// ── units are a different property, not a duplicate ───────────────────────

describe('two units in one building', () => {
  it('are DIFFERENT-UNIT, never near-duplicates — Kevin will want them', () => {
    const a = '100 Ocean Dr, Apt 3, Miami, FL, 33139'
    const b = '100 Ocean Dr, Apt 5, Miami, FL, 33139'
    expect(compare(a, b)).toBe('unit_differs')
    expect(compare(a, b)).not.toBe('match')
  })

  it('are recognised however the unit is written', () => {
    expect(compare('100 Ocean Dr #3, Miami, FL, 33139', '100 Ocean Dr, Suite 5, Miami, FL, 33139'))
      .toBe('unit_differs')
    expect(compare('100 Ocean Dr Apt 3, Miami, FL, 33139', '100 Ocean Dr, Unit 3, Miami, FL, 33139'))
      .toBe('match')
  })

  it('a unit on one side and none on the other is kept, not dismissed', () => {
    // The cautious direction: 'unit_differs' keeps the row in front of Kevin.
    expect(compare('100 Ocean Dr, Miami, FL, 33139', '100 Ocean Dr, Apt 5, Miami, FL, 33139'))
      .toBe('unit_differs')
  })

  it('the unit never rescues a street that does not match', () => {
    expect(compare('100 Ocean Dr, Apt 3, Miami, FL, 33139', '200 Ocean Dr, Apt 3, Miami, FL, 33139'))
      .toBe('no_match')
  })
})

// ── genuinely distinct addresses stay NEW ─────────────────────────────────

describe('real drift is not swallowed', () => {
  const KC_PRIMARY = '2709 Tomahawk Rd, Mission Hills, KS, 66208'

  // The Kansas City client with seven distinct properties — storage, office,
  // second home. None of these may be called a near-duplicate of the primary.
  const SEVEN = [
    '8300 NE Underground Dr, Kansas City, MO, 64161',
    '1200 Main St, Kansas City, MO, 64105',
    '4741 Central St, Kansas City, MO, 64112',
    '9200 Ward Pkwy, Kansas City, MO, 64114',
    '300 W 22nd St, Kansas City, MO, 64108',
    '11401 Roe Ave, Leawood, KS, 66211',
    '2711 Tomahawk Rd, Mission Hills, KS, 66208',
  ]

  it('seven distinct properties all stay NEW against the primary', () => {
    for (const addr of SEVEN) {
      expect(compare(addr, KC_PRIMARY), addr).toBe('no_match')
    }
  })

  it('and stay NEW against each other', () => {
    for (let i = 0; i < SEVEN.length; i++) {
      for (let j = i + 1; j < SEVEN.length; j++) {
        expect(compare(SEVEN[i], SEVEN[j]), `${SEVEN[i]} vs ${SEVEN[j]}`).toBe('no_match')
      }
    }
  })

  it('a different house number on the same street is a different property', () => {
    expect(compare('2709 Tomahawk Rd, Mission Hills, KS, 66208', '2711 Tomahawk Rd, Mission Hills, KS, 66208'))
      .toBe('no_match')
  })

  it('a different zip on the same street name is a different property', () => {
    expect(compare('100 Main St, Springfield, IL, 62701', '100 Main St, Springfield, IL, 62704'))
      .toBe('no_match')
  })

  it('a different city on the same street name is a different property', () => {
    expect(compare('100 Main St, Springfield, IL', '100 Main St, Chicago, IL'))
      .toBe('no_match')
  })

  it('two different street types are two different streets', () => {
    expect(compare('50 Elm Ct, Boulder, CO, 80302', '50 Elm Cir, Boulder, CO, 80302'))
      .toBe('no_match')
  })

  it('an unparseable address is never matched to anything', () => {
    expect(compare('', '100 Main St, Denver, CO')).toBe('no_match')
    expect(compare('   ', '100 Main St, Denver, CO')).toBe('no_match')
  })
})

// ── the row-level classifier ──────────────────────────────────────────────

const entryFor = (display: string) => ({ display }) as any

describe('classifyWouldCreate', () => {
  const lead = { address: '2709 Tomahawk Rd', city: 'Mission Hills', state: 'KS', zip: '' }

  it('names the primary and the basis', () => {
    const c = classifyWouldCreate({
      lead,
      formerAddresses: [],
      entry: entryFor('2709 Tomahawk Rd, Mission Hills, KS, 66208'),
    })
    expect(c.label).toBe('near-duplicate')
    expect(c.reason).toBe('near-duplicate of the primary — differs only a zip on one and not the other')
  })

  it('also checks every address already on the card, and says which one', () => {
    const c = classifyWouldCreate({
      lead: { address: '1 Somewhere Else', city: 'Denver', state: 'CO', zip: '80210' },
      formerAddresses: [
        entryFor('900 Other Rd, Denver, CO, 80210'),
        entryFor('1500 Morningside Avenue, Atlanta, GA, 30306'),
      ],
      entry: entryFor('1500 Morningside Ave, Atlanta, GA, 30306'),
    })
    expect(c.label).toBe('near-duplicate')
    expect(c.reason).toContain('other address #2')
  })

  it('labels a second unit in the same building as different-unit', () => {
    const c = classifyWouldCreate({
      lead: { address: '100 Ocean Dr Apt 3', city: 'Miami', state: 'FL', zip: '33139' },
      formerAddresses: [],
      entry: entryFor('100 Ocean Dr, Apt 5, Miami, FL, 33139'),
    })
    expect(c.label).toBe('different-unit')
    expect(c.reason).toBe('a different unit in the same building as the primary')
  })

  it('leaves a genuinely new address alone, with no reason to add', () => {
    const c = classifyWouldCreate({
      lead,
      formerAddresses: [],
      entry: entryFor('8300 NE Underground Dr, Kansas City, MO, 64161'),
    })
    expect(c.label).toBe('new')
    expect(c.reason).toBe('')
  })

  it('a near-duplicate anywhere on the card outranks a unit difference elsewhere', () => {
    const c = classifyWouldCreate({
      lead: { address: '100 Ocean Dr Apt 3', city: 'Miami', state: 'FL', zip: '33139' },
      formerAddresses: [entryFor('1500 Morningside Avenue, Atlanta, GA, 30306')],
      entry: entryFor('1500 Morningside Ave, Atlanta, GA, 30306'),
    })
    expect(c.label).toBe('near-duplicate')
  })
})

// ── the sweep counts the split ────────────────────────────────────────────

const NOW = '2026-09-09T12:00:00.000Z'

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

const LOC = { location_id: 'loc_kc', name: 'Kansas City', jobber_account_id: 'acct-1' }

// One client: a near-duplicate (zip missing on the primary), a second unit,
// and one genuinely new property.
const THREE_PROPERTIES = {
  data: {
    clients: {
      nodes: [
        {
          id: '111',
          firstName: 'Dana',
          lastName: 'Reyes',
          companyName: null,
          clientProperties: {
            totalCount: 3,
            nodes: [
              { id: '9001', address: { street: '2709 Tomahawk Rd', city: 'Mission Hills', province: 'KS', postalCode: '66208' } },
              { id: '9002', address: { street: '2709 Tomahawk Rd Apt 5', city: 'Mission Hills', province: 'KS', postalCode: '66208' } },
              { id: '9003', address: { street: '8300 NE Underground Dr', city: 'Kansas City', province: 'MO', postalCode: '64161' } },
            ],
          },
        },
      ],
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
  zip: '',           // the defect: no zip on the primary
  former_addresses: [],
}]

describe('the dry-run summary', () => {
  it('splits would-create into the three buckets, and they sum to the total', async () => {
    const h = sweepHarness({ loadLeads: async () => KC_LEAD as any, runQuery: async () => THREE_PROPERTIES })
    const progress = await runBackfill([LOC], h.deps, { mode: 'dry-run' })
    const c = totalCounts(progress)

    expect(c.would_create).toBe(3)
    expect(c.would_create_near_duplicate).toBe(1)
    expect(c.would_create_different_unit).toBe(1)
    expect(c.would_create_new).toBe(1)
    expect(
      c.would_create_near_duplicate + c.would_create_different_unit + c.would_create_new,
    ).toBe(c.would_create)
  })

  it('carries the split per location as well as in the total', async () => {
    const h = sweepHarness({ loadLeads: async () => KC_LEAD as any, runQuery: async () => THREE_PROPERTIES })
    const progress = await runBackfill([LOC], h.deps, { mode: 'dry-run' })
    expect(progress.counts['loc_kc'].would_create_new).toBe(1)
    expect(progress.counts['loc_kc'].would_create_near_duplicate).toBe(1)
  })

  it('puts the basis on the row, so a call can be checked by eye', async () => {
    const h = sweepHarness({ loadLeads: async () => KC_LEAD as any, runQuery: async () => THREE_PROPERTIES })
    const progress = await runBackfill([LOC], h.deps, { mode: 'dry-run' })

    const near = progress.findings.find((f) => f.label === 'near-duplicate')!
    expect(near.why).toContain('near-duplicate of the primary')
    expect(near.why).toContain('a zip on one and not the other')

    const unit = progress.findings.find((f) => f.label === 'different-unit')!
    expect(unit.why).toContain('different unit in the same building')

    const fresh = progress.findings.find((f) => f.label === 'new')!
    expect(fresh.why).not.toContain('BUT')
  })

  it('prints all three groups, genuinely-new first', async () => {
    const h = sweepHarness({ loadLeads: async () => KC_LEAD as any, runQuery: async () => THREE_PROPERTIES })
    const progress = await runBackfill([LOC], h.deps, { mode: 'dry-run' })
    const report = formatReport(progress)

    expect(report).toContain('GENUINELY NEW')
    expect(report).toContain('DIFFERENT UNIT')
    expect(report).toContain('NEAR-DUPLICATE')
    expect(report.indexOf('GENUINELY NEW — no address')).toBeLessThan(report.indexOf('NEAR-DUPLICATE — looks like'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE ASSERTION THAT MATTERS MOST
//
// planDriftAddress is what the LIVE WEBHOOK calls on every property event. If
// this commit changed it, every one of those events would start behaving
// differently in production. It did not, and these prove it: the classifier
// sees the same rows and reaches its own conclusion, while the decision
// underneath is untouched.
// ═══════════════════════════════════════════════════════════════════════════

describe('planDriftAddress is UNCHANGED by any of this', () => {
  const NEAR_DUPLICATE_CASES: Array<[string, any, any]> = [
    [
      'zip missing on the primary',
      { address: '2709 Tomahawk Rd', city: 'Mission Hills', state: 'KS', zip: '' },
      { street: '2709 Tomahawk Rd', city: 'Mission Hills', province: 'KS', postalCode: '66208' },
    ],
    [
      'zip+4 against a plain zip',
      { address: '3245 SW Holden St', city: 'Seattle', state: 'WA', zip: '98116' },
      { street: '3245 SW Holden St', city: 'Seattle', province: 'WA', postalCode: '98116-4026' },
    ],
    [
      'state spelled out',
      { address: '6821 Northwood Rd', city: 'Dallas', state: 'TX', zip: '75225' },
      { street: '6821 Northwood Rd', city: 'Dallas', province: 'Texas', postalCode: '75225' },
    ],
    [
      'Ave against Avenue',
      { address: '1500 Morningside Avenue', city: 'Atlanta', state: 'GA', zip: '30306' },
      { street: '1500 Morningside Ave', city: 'Atlanta', province: 'GA', postalCode: '30306' },
    ],
    [
      'a primary with a repeated tail',
      { address: '2561 South Saint Paul Street, Denver, CO, 80210, Denver, CO, 80210', city: 'Denver', state: 'CO', zip: '80210' },
      { street: '2561 South Saint Paul Street', city: 'Denver', province: 'CO', postalCode: '80210' },
    ],
  ]

  it.each(NEAR_DUPLICATE_CASES)(
    'still returns create for %s — the loose key has NOT been wired in',
    (_name, lead, address) => {
      const plan = planDriftAddress({
        lead,
        formerAddresses: [],
        address,
        jobberPropertyId: '9001',
        nowIso: NOW,
      })
      // The classifier calls this a near-duplicate...
      expect(
        classifyWouldCreate({ lead, formerAddresses: [], entry: (plan as any).entry }).label,
      ).toBe('near-duplicate')
      // ...and planDriftAddress still says create, exactly as before.
      expect(plan.action).toBe('create')
    },
  )

  it('still skips on its own strict key, unchanged', () => {
    const lead = { address: '2709 Tomahawk Rd', city: 'Mission Hills', state: 'KS', zip: '66208' }
    expect(
      planDriftAddress({
        lead,
        formerAddresses: [],
        address: { street: '2709 Tomahawk Rd', city: 'Mission Hills', province: 'KS', postalCode: '66208' },
        jobberPropertyId: '9001',
        nowIso: NOW,
      }),
    ).toEqual({ action: 'skip', reason: 'matches_primary' })
  })

  it('still writes the same label and note the webhook writes', () => {
    expect(DRIFT_LABEL).toBe('other')
    expect(DRIFT_LABEL_NOTE).toBe('Found in Jobber')
    const plan = planDriftAddress({
      lead: { address: '1 Main St', city: 'Denver', state: 'CO', zip: '80210' },
      formerAddresses: [],
      address: { street: '9 Oak Ave', city: 'Denver', province: 'CO', postalCode: '80210' },
      jobberPropertyId: '9001',
      nowIso: NOW,
    })
    expect(plan.action).toBe('create')
    expect((plan as any).entry.label).toBe('other')
    expect((plan as any).entry.label_note).toBe('Found in Jobber')
  })
})

describe('what --commit writes is UNCHANGED', () => {
  it('a near-duplicate is still written — classification reports, it does not gate', async () => {
    const h = sweepHarness({ loadLeads: async () => KC_LEAD as any, runQuery: async () => THREE_PROPERTIES })
    const progress = await runBackfill([LOC], h.deps, { mode: 'commit' })

    // All three, including the one labelled near-duplicate.
    expect(h.writes).toHaveLength(3)
    expect(totalCounts(progress).created).toBe(3)
    expect(totalCounts(progress).would_create_near_duplicate).toBe(1)
  })

  it('a dry run still writes nothing at all', async () => {
    const h = sweepHarness({ loadLeads: async () => KC_LEAD as any, runQuery: async () => THREE_PROPERTIES })
    await runBackfill([LOC], h.deps, { mode: 'dry-run' })
    expect(h.writes).toHaveLength(0)
  })
})
