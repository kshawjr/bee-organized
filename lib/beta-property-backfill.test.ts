// lib/beta-property-backfill.test.ts
//
// The SWEEP's own concerns, and only those.
//
// The drift DECISION — what counts as an address we already know — is
// lib/beta-property-drift.test.ts's job and is not re-tested here. Restating
// those assertions against a second caller would not add a check; it would add
// a second place to update when the rule changes, and the whole reason
// planDriftAddress is a shared function is that there is one rule.
//
// What is tested here is everything the sweep adds around that call: the scope
// Kevin set, the guard that keeps a dry run dry, resumability, and rate
// limiting. The dry-run guard is the one that protects production, so it is
// mutation-tested — flip shouldWrite to return true and the "writes NOTHING"
// test goes red.

import { describe, it, expect, vi } from 'vitest'
import {
  PHILLY_SLUG,
  selectLocations,
  shouldWrite,
  isRateLimited,
  retryAfterMs,
  backoffMs,
  MAX_BACKOFF_MS,
  jobberNumericId,
  describeWhyNew,
  emptyProgress,
  emptyCounts,
  addCounts,
  assertResumable,
  totalCounts,
  formatReport,
  runBackfill,
  sweepLocation,
  RateLimitExhaustedError,
  type Progress,
  type SweepDeps,
  type BackfillLead,
} from './property-backfill'

const NOW = '2026-09-09T12:00:00.000Z'

// ── fixtures ──────────────────────────────────────────────────────────────

const loc = (location_id: string, extra: Record<string, any> = {}) => ({
  location_id,
  name: location_id.toUpperCase(),
  jobber_account_id: 'acct-1',
  ...extra,
})

const prop = (id: string, street: string, city = 'Ardmore', province = 'PA', postalCode = '19003') => ({
  id,
  address: { street, city, province, postalCode },
})

const client = (id: string, props: any[], extra: Record<string, any> = {}) => ({
  id,
  firstName: 'Dana',
  lastName: 'Reyes',
  companyName: null,
  clientProperties: { totalCount: props.length, nodes: props },
  ...extra,
})

const page = (nodes: any[], hasNextPage = false, endCursor: string | null = 'cur-1') => ({
  data: { clients: { nodes, pageInfo: { hasNextPage, endCursor } } },
})

const lead = (id: string, jobber_client_id: string, extra: Partial<BackfillLead> = {}): BackfillLead => ({
  id,
  jobber_client_id,
  address: '1 Main St',
  city: 'Philadelphia',
  state: 'PA',
  zip: '19100',
  former_addresses: [],
  ...extra,
})

type Harness = {
  deps: SweepDeps
  writes: Array<{ leadId: string; next: any[] }>
  saved: Progress[]
  logs: string[]
  queries: Array<{ locationId: string; variables: Record<string, any> }>
  sleeps: number[]
}

function harness(over: Partial<SweepDeps> = {}): Harness {
  const writes: Harness['writes'] = []
  const saved: Progress[] = []
  const logs: string[] = []
  const queries: Harness['queries'] = []
  const sleeps: number[] = []

  const deps: SweepDeps = {
    runQuery: async (locationId, _q, variables) => {
      queries.push({ locationId, variables })
      return page([])
    },
    loadLeads: async () => [],
    appendAddress: async (leadId, next) => {
      writes.push({ leadId, next })
    },
    saveProgress: async (p) => {
      saved.push(JSON.parse(JSON.stringify(p)))
    },
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    log: (l) => logs.push(l),
    ...over,
  }
  return { deps, writes, saved, logs, queries, sleeps }
}

// ── scope: the Philly skip ────────────────────────────────────────────────

describe('scope — Philadelphia Suburbs', () => {
  const rows = [loc('loc_alpha'), loc(PHILLY_SLUG), loc('loc_zulu')]

  it('is skipped by default — it re-imported today, so its properties are current', () => {
    const picked = selectLocations(rows).map((r) => r.location_id)
    expect(picked).toEqual(['loc_alpha', 'loc_zulu'])
    expect(picked).not.toContain(PHILLY_SLUG)
  })

  it('is included only when explicitly asked for', () => {
    const picked = selectLocations(rows, { includePhilly: true }).map((r) => r.location_id)
    expect(picked).toEqual(['loc_alpha', PHILLY_SLUG, 'loc_zulu'])
  })

  it('the skip survives the full run — Philly is never even read', async () => {
    const h = harness({ loadLeads: vi.fn(async () => []) })
    await runBackfill(rows, h.deps, { mode: 'dry-run' })
    const swept = h.queries.map((q) => q.locationId)
    expect(swept).not.toContain(PHILLY_SLUG)
    expect(h.deps.loadLeads).not.toHaveBeenCalledWith(PHILLY_SLUG)
  })
})

describe('scope — which locations at all', () => {
  it('a location with no jobber_account_id has nothing to read and is dropped', () => {
    const picked = selectLocations([
      loc('loc_a'),
      loc('loc_b', { jobber_account_id: null }),
      loc('loc_c', { jobber_account_id: '   ' }),
    ]).map((r) => r.location_id)
    expect(picked).toEqual(['loc_a'])
  })

  it('order is stable — resumability depends on two runs visiting the same order', () => {
    const a = selectLocations([loc('loc_z'), loc('loc_a'), loc('loc_m')]).map((r) => r.location_id)
    const b = selectLocations([loc('loc_m'), loc('loc_z'), loc('loc_a')]).map((r) => r.location_id)
    expect(a).toEqual(['loc_a', 'loc_m', 'loc_z'])
    expect(a).toEqual(b)
  })

  it('tolerates a null/undefined location list rather than throwing mid-sweep', () => {
    expect(selectLocations(null)).toEqual([])
    expect(selectLocations(undefined)).toEqual([])
  })
})

// ── Kevin's standing ruling: never invent a lead ──────────────────────────

describe('a property whose client has no lead in Bee Hub', () => {
  const setup = (mode: 'dry-run' | 'commit') =>
    harness({
      loadLeads: async () => [lead('lead-1', '111')],
      runQuery: async () =>
        page([
          client('111', [prop('9001', '9 Oak Ave')]),
          client('999', [prop('9002', '12 Elm Ct'), prop('9003', '14 Elm Ct')]),
        ]),
    })

  it('is counted, and left completely alone', async () => {
    const h = setup('dry-run')
    const progress = await runBackfill([loc('loc_a')], h.deps, { mode: 'dry-run' })
    const c = totalCounts(progress)

    expect(c.clients_scanned).toBe(2)
    expect(c.clients_without_lead).toBe(1)
    expect(c.properties_without_lead).toBe(2)
    // Only the client we DO have a lead for produced a finding.
    expect(c.would_create).toBe(1)
    expect(progress.findings).toHaveLength(1)
    expect(progress.findings[0].lead_id).toBe('lead-1')
  })

  it('is not written even in commit mode — there is no lead to write it to', async () => {
    const h = setup('commit')
    await runBackfill([loc('loc_a')], h.deps, { mode: 'commit' })
    expect(h.writes.map((w) => w.leadId)).toEqual(['lead-1'])
  })
})

// ── THE GUARD ─────────────────────────────────────────────────────────────

describe('the dry-run guard', () => {
  const withWork = () =>
    harness({
      loadLeads: async () => [lead('lead-1', '111'), lead('lead-2', '222')],
      runQuery: async () =>
        page([
          client('111', [prop('9001', '9 Oak Ave')]),
          client('222', [prop('9002', '12 Elm Ct')]),
        ]),
    })

  // ── THE MUTATION TARGET ────────────────────────────────────────────────
  // If shouldWrite is ever made to return true for a dry run — inverted,
  // loosened to a truthy check, or deleted so the write runs unconditionally —
  // this is the assertion that goes red. It is the one protecting production.
  it('a dry run writes NOTHING, even with addresses to add', async () => {
    const h = withWork()
    const progress = await runBackfill([loc('loc_a')], h.deps, { mode: 'dry-run' })

    expect(h.writes).toHaveLength(0)
    expect(totalCounts(progress).would_create).toBe(2)
    expect(totalCounts(progress).created).toBe(0)
    expect(progress.findings).toHaveLength(2)
  })

  it('--commit is what makes it write, and it writes only the address list', async () => {
    const h = withWork()
    const progress = await runBackfill([loc('loc_a')], h.deps, { mode: 'commit' })

    expect(h.writes).toHaveLength(2)
    expect(totalCounts(progress).created).toBe(2)

    const [first] = h.writes
    expect(first.leadId).toBe('lead-1')
    expect(first.next).toHaveLength(1)
    // Same row the webhook writes — one label, one note, both callers.
    expect(first.next[0].label).toBe('other')
    expect(first.next[0].label_note).toBe('Found in Jobber')
    expect(first.next[0].jobber_property_id).toBe('9001')
  })

  it('defaults to deny — anything that is not exactly "commit" is a dry run', () => {
    expect(shouldWrite('commit')).toBe(true)
    expect(shouldWrite('dry-run')).toBe(false)
    expect(shouldWrite(undefined)).toBe(false)
    expect(shouldWrite(null)).toBe(false)
    expect(shouldWrite('')).toBe(false)
    expect(shouldWrite('Commit')).toBe(false)
    expect(shouldWrite('commit ')).toBe(false)
    expect(shouldWrite('--commit')).toBe(false)
    expect(shouldWrite('true')).toBe(false)
  })

  it('a failed write is counted as failed, never as created', async () => {
    const h = harness({
      loadLeads: async () => [lead('lead-1', '111')],
      runQuery: async () => page([client('111', [prop('9001', '9 Oak Ave')])]),
      appendAddress: async () => {
        throw new Error('supabase said no')
      },
    })
    const progress = await runBackfill([loc('loc_a')], h.deps, { mode: 'commit' })
    const c = totalCounts(progress)
    expect(c.created).toBe(0)
    expect(c.write_failed).toBe(1)
    expect(progress.errors[0].message).toContain('supabase said no')
  })
})

// ── the projection is honest ──────────────────────────────────────────────

describe('the dry run projects what a commit run would do', () => {
  it('two Jobber properties at the same address count once, not twice', async () => {
    const runWith = async (mode: 'dry-run' | 'commit') => {
      const h = harness({
        loadLeads: async () => [lead('lead-1', '111')],
        runQuery: async () =>
          page([client('111', [prop('9001', '9 Oak Ave'), prop('9002', '9 Oak Ave')])]),
      })
      const progress = await runBackfill([loc('loc_a')], h.deps, { mode })
      return { counts: totalCounts(progress), writes: h.writes }
    }

    const dry = await runWith('dry-run')
    const commit = await runWith('commit')

    expect(dry.counts.would_create).toBe(1)
    expect(dry.counts.already_listed_active).toBe(1)
    expect(dry.writes).toHaveLength(0)

    // The projection matches reality: same would_create, and the commit run
    // really did write exactly once.
    expect(commit.counts.would_create).toBe(dry.counts.would_create)
    expect(commit.writes).toHaveLength(1)
  })

  it('counts a client whose properties did not fit in one page, rather than hiding it', async () => {
    const h = harness({
      loadLeads: async () => [lead('lead-1', '111')],
      runQuery: async () =>
        page([
          {
            ...client('111', [prop('9001', '9 Oak Ave')]),
            clientProperties: { totalCount: 12, nodes: [prop('9001', '9 Oak Ave')] },
          },
        ]),
    })
    const progress = await runBackfill([loc('loc_a')], h.deps, { mode: 'dry-run' })
    expect(totalCounts(progress).clients_with_more_properties_than_fetched).toBe(1)
  })
})

// ── resumability ──────────────────────────────────────────────────────────

describe('resumability', () => {
  it('a completed location is skipped outright on resume', async () => {
    const prior = emptyProgress('dry-run', false, NOW)
    prior.completed.push('loc_a')
    prior.counts['loc_a'] = { ...emptyCounts(), clients_scanned: 40 }

    const h = harness({ runQuery: async (locationId, _q, v) => (h.queries.push({ locationId, variables: v }), page([])) })
    const progress = await runBackfill([loc('loc_a'), loc('loc_b')], h.deps, { mode: 'dry-run' }, prior)

    expect(h.queries.map((q) => q.locationId)).toEqual(['loc_b'])
    // and loc_a's numbers are still there
    expect(progress.counts['loc_a'].clients_scanned).toBe(40)
  })

  it('an interrupted location resumes at its cursor, not at the first page', async () => {
    const prior = emptyProgress('dry-run', false, NOW)
    prior.cursors['loc_a'] = 'cur-500'

    const h = harness()
    await runBackfill([loc('loc_a')], h.deps, { mode: 'dry-run' }, prior)

    expect(h.queries[0].variables.after).toBe('cur-500')
  })

  it('checkpoints after every page, so a death costs one page at most', async () => {
    let call = 0
    const h = harness({
      loadLeads: async () => [lead('lead-1', '111')],
      runQuery: async () => {
        call++
        if (call === 1) return page([client('111', [prop('9001', '9 Oak Ave')])], true, 'cur-1')
        return page([client('222', [prop('9002', '12 Elm Ct')])], false, 'cur-2')
      },
    })
    await runBackfill([loc('loc_a')], h.deps, { mode: 'dry-run' })

    // A save carrying cur-1 exists — i.e. progress was persisted between the
    // two pages, not only at the end.
    expect(h.saved.some((p) => p.cursors['loc_a'] === 'cur-1')).toBe(true)
    expect(h.saved[h.saved.length - 1].completed).toContain('loc_a')
  })

  it('refuses to resume a dry run as a commit run', () => {
    const prior = emptyProgress('dry-run', false, NOW)
    expect(() => assertResumable(prior, 'commit', false)).toThrow(/dry-run run.*you asked for commit/s)
  })

  it('refuses to resume across a changed Philly scope', () => {
    const prior = emptyProgress('dry-run', false, NOW)
    expect(() => assertResumable(prior, 'dry-run', true)).toThrow(new RegExp(PHILLY_SLUG))
  })

  it('refuses a checkpoint from a different build', () => {
    const prior = { ...emptyProgress('dry-run', false, NOW), version: 99 }
    expect(() => assertResumable(prior as Progress, 'dry-run', false)).toThrow(/version 99/)
  })
})

// ── rate limiting ─────────────────────────────────────────────────────────

describe('rate limiting', () => {
  it('recognises both shapes it actually arrives in', () => {
    expect(isRateLimited({ status: 429 })).toBe(true)
    expect(isRateLimited({ statusCode: 429 })).toBe(true)
    expect(isRateLimited({ errors: [{ extensions: { code: 'THROTTLED' } }] })).toBe(true)
    expect(isRateLimited({ errors: [{ message: 'Too Many Requests' }] })).toBe(true)
    expect(isRateLimited({ status: 500 })).toBe(false)
    expect(isRateLimited({ errors: [{ message: 'field not found' }] })).toBe(false)
    expect(isRateLimited(null)).toBe(false)
  })

  it('honours Retry-After, and never sleeps longer than the ceiling', () => {
    expect(retryAfterMs({ retryAfter: '30' })).toBe(30_000)
    expect(retryAfterMs({ retryAfter: null })).toBe(null)
    expect(backoffMs(0)).toBe(1_000)
    expect(backoffMs(3)).toBe(8_000)
    expect(backoffMs(99)).toBe(MAX_BACKOFF_MS)
    expect(backoffMs(0, 5_000)).toBe(5_000)
    expect(backoffMs(0, 999_999)).toBe(MAX_BACKOFF_MS)
  })

  it('backs off and carries on when the limit clears', async () => {
    let call = 0
    const h = harness({
      loadLeads: async () => [lead('lead-1', '111')],
      runQuery: async () => {
        call++
        if (call === 1) return { errors: [{ extensions: { code: 'THROTTLED' } }] }
        if (call === 2) throw Object.assign(new Error('429'), { status: 429, retryAfter: '2' })
        return page([client('111', [prop('9001', '9 Oak Ave')])])
      },
    })
    const progress = await runBackfill([loc('loc_a')], h.deps, { mode: 'dry-run' })

    expect(h.sleeps).toEqual([1_000, 2_000])
    expect(totalCounts(progress).would_create).toBe(1)
    expect(progress.completed).toContain('loc_a')
  })

  // The requirement in Kevin's own words: a 429 must not lose progress.
  it('a 429 that never clears keeps everything already swept', async () => {
    const h = harness({
      loadLeads: async (locationId) => (locationId === 'loc_a' ? [lead('lead-1', '111')] : [lead('lead-2', '222')]),
      runQuery: async (locationId) => {
        if (locationId === 'loc_a') return page([client('111', [prop('9001', '9 Oak Ave')])])
        throw Object.assign(new Error('Too Many Requests'), { status: 429 })
      },
    })

    await expect(
      runBackfill([loc('loc_a'), loc('loc_b')], h.deps, { mode: 'dry-run', maxRateLimitRetries: 2 }),
    ).rejects.toBeInstanceOf(RateLimitExhaustedError)

    // The checkpoint on disk still holds loc_a in full.
    const last = h.saved[h.saved.length - 1]
    expect(last.completed).toContain('loc_a')
    expect(last.counts['loc_a'].would_create).toBe(1)
    expect(last.findings).toHaveLength(1)
    expect(last.findings[0].lead_id).toBe('lead-1')
    // And it retried before giving up, rather than bailing on the first 429.
    expect(h.sleeps).toHaveLength(2)
  })

  it('a commit run that hits a wall keeps the record of what it already wrote', async () => {
    const h = harness({
      loadLeads: async (locationId) => (locationId === 'loc_a' ? [lead('lead-1', '111')] : []),
      runQuery: async (locationId) => {
        if (locationId === 'loc_a') return page([client('111', [prop('9001', '9 Oak Ave')])])
        throw Object.assign(new Error('429'), { status: 429 })
      },
    })

    await expect(
      runBackfill([loc('loc_a'), loc('loc_b')], h.deps, { mode: 'commit', maxRateLimitRetries: 1 }),
    ).rejects.toBeInstanceOf(RateLimitExhaustedError)

    expect(h.writes).toHaveLength(1)
    expect(h.saved[h.saved.length - 1].counts['loc_a'].created).toBe(1)
  })
})

// ── one bad location must not cost the other 35 ───────────────────────────

describe('a location that fails on its own terms', () => {
  it('is recorded and stepped over', async () => {
    const h = harness({
      loadLeads: async (locationId) => {
        if (locationId === 'loc_a') throw new Error('token rejected')
        return [lead('lead-2', '222')]
      },
      runQuery: async () => page([client('222', [prop('9002', '12 Elm Ct')])]),
    })
    const progress = await runBackfill([loc('loc_a'), loc('loc_b')], h.deps, { mode: 'dry-run' })

    expect(progress.errors.map((e) => e.location_id)).toContain('loc_a')
    expect(progress.completed).toContain('loc_b')
    expect(totalCounts(progress).would_create).toBe(1)
  })
})

// ── the reviewable output ─────────────────────────────────────────────────

describe('the report Kevin reads before committing', () => {
  it('names the location, the client, the address and why for every would-create', async () => {
    const h = harness({
      loadLeads: async () => [lead('lead-1', '111')],
      runQuery: async () => page([client('111', [prop('9001', '9 Oak Ave')])]),
    })
    const progress = await runBackfill([loc('loc_a')], h.deps, { mode: 'dry-run' })
    const report = formatReport(progress)

    expect(report).toContain('DRY RUN — NOTHING WAS WRITTEN')
    expect(report).toContain('LOC_A')
    expect(report).toContain('Dana Reyes')
    expect(report).toContain('9 Oak Ave')
    expect(report).toContain('lead-1')
    expect(report).toContain('not the lead')
  })

  it('says COMMIT loudly when it was one', async () => {
    const h = harness()
    const progress = await runBackfill([loc('loc_a')], h.deps, { mode: 'commit' })
    expect(formatReport(progress)).toContain('COMMIT MODE')
    expect(formatReport(progress)).not.toContain('NOTHING WAS WRITTEN')
  })

  it('explains newness from what the card held, without second-guessing the decision', () => {
    const why = describeWhyNew({
      lead: { address: '1 Main St', city: 'Philadelphia', state: 'PA', zip: '19100' },
      formerAddresses: [{ display: '2 Other Rd' } as any],
      jobberPropertyId: '555',
    })
    expect(why).toContain('1 Main St')
    expect(why).toContain('555')
    expect(why).toContain('1 other address')
  })
})

// ── small pieces ──────────────────────────────────────────────────────────

describe('Jobber ids', () => {
  it('decodes a global id and passes a bare number through', () => {
    const gid = Buffer.from('gid://Jobber/Client/136289662').toString('base64')
    expect(jobberNumericId(gid)).toBe('136289662')
    expect(jobberNumericId('136289662')).toBe('136289662')
    expect(jobberNumericId(null)).toBe(null)
    expect(jobberNumericId('')).toBe(null)
    expect(jobberNumericId('not-an-id')).toBe(null)
  })
})

describe('counts', () => {
  it('add up across locations', () => {
    const a = { ...emptyCounts(), would_create: 2, properties_seen: 10 }
    const b = { ...emptyCounts(), would_create: 3, properties_seen: 7 }
    const sum = addCounts(a, b)
    expect(sum.would_create).toBe(5)
    expect(sum.properties_seen).toBe(17)
  })
})

// ── the sweep never mutates Jobber ────────────────────────────────────────

describe('read-only against Jobber', () => {
  it('every query it sends is a query', async () => {
    const sent: string[] = []
    const h = harness({
      runQuery: async (_l, query) => {
        sent.push(query)
        return page([])
      },
    })
    await runBackfill([loc('loc_a'), loc('loc_b')], h.deps, { mode: 'commit' })

    expect(sent.length).toBeGreaterThan(0)
    for (const q of sent) {
      expect(q).toMatch(/^\s*query\b/)
      expect(q).not.toMatch(/\bmutation\b/)
    }
  })
})

// ── sweepLocation directly, for the counters ──────────────────────────────

describe('per-location counters', () => {
  it('break "already known" down by the reason it was known', async () => {
    const existing = [
      { display: '5 Known St, Ardmore, PA, 19003', jobber_property_id: '9101', status: 'active' },
      { display: '7 Retired Rd, Ardmore, PA, 19003', jobber_property_id: '9102', status: 'retired' },
    ] as any[]

    const h = harness({
      loadLeads: async () => [lead('lead-1', '111', { former_addresses: existing })],
      runQuery: async () =>
        page([
          client('111', [
            prop('9101', '5 Known St'),
            prop('9102', '7 Retired Rd'),
            prop('9103', '1 Main St', 'Philadelphia', 'PA', '19100'),
            prop('9104', ''),
            prop('9105', '9 Oak Ave'),
          ]),
        ]),
    })

    const progress = emptyProgress('dry-run', false, NOW)
    const counts = await sweepLocation(loc('loc_a'), h.deps, progress, { mode: 'dry-run' })

    expect(counts.properties_seen).toBe(5)
    expect(counts.already_listed_active).toBe(1)
    expect(counts.already_listed_retired).toBe(1)
    expect(counts.already_primary).toBe(1)
    expect(counts.no_usable_address).toBe(1)
    expect(counts.would_create).toBe(1)
  })
})
