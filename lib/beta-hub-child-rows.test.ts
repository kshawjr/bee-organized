// @vitest-environment node
//
// createChildRowFetcher — the elevated Hub load's child-table read.
//
// The chunked path issued 200 lead ids per `.in()` SEQUENTIALLY: 7,028 leads =
// 36 chunks × 9 tables = 324 round trips, ~8.4s of an elevated page load, even
// though each individual query is ~100ms. The bulk path reads the table straight
// through in 1000-row pages instead (25 requests, 1.27s) — but only when the
// caller is unscoped, because only then is "every non-junk lead in the tenant"
// the same set as "the whole table".
//
// These tests are equivalence tests, not perf tests. The bar is that the two
// paths produce BYTE-IDENTICAL grouped output — same rows per lead, in the same
// order — because everything downstream (mapLeadToPerson's newest-touchpoint,
// latest-invoice, first-quote reads) is positional.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

// _hub-page.tsx imports supabase-service, which calls createClient() at module
// scope and THROWS on missing env; BeeHub drags the whole client tree in.
vi.mock('@/lib/supabase-service', () => ({ supabaseService: {} }))
vi.mock('@/components/BeeHub', () => ({ default: () => null }))

import { createChildRowFetcher } from '@/app/_hub-page'

// ── fake PostgREST ────────────────────────────────────────────────────────
// Real filter/sort/page semantics, including the hard 1000-row response cap
// that PostgREST enforces regardless of the requested range (verified against
// prod: range(0,4999) returns 1000 rows). A page size >1000 would read as a
// short page and terminate the loop early — that truncation is what this fake
// exists to catch.
const MAX_ROWS = 1000

function makeDb(tables: Record<string, any[]>, failures: Record<string, number[]> = {}) {
  const requests: { table: string; ops: [string, any[]][] }[] = []

  // Postgres default null placement: ASC → NULLS LAST, DESC → NULLS FIRST.
  const cmpBy = (keys: { col: string; asc: boolean }[]) => (a: any, b: any) => {
    for (const { col, asc } of keys) {
      const av = a[col], bv = b[col]
      const an = av === null || av === undefined
      const bn = bv === null || bv === undefined
      if (an && bn) continue
      if (an) return asc ? 1 : -1
      if (bn) return asc ? -1 : 1
      if (av < bv) return asc ? -1 : 1
      if (av > bv) return asc ? 1 : -1
    }
    return 0
  }

  const from = (table: string) => {
    const call: { table: string; ops: [string, any[]][] } = { table, ops: [] }
    requests.push(call)
    let rows = [...(tables[table] || [])]
    const keys: { col: string; asc: boolean }[] = []
    let range: [number, number] = [0, MAX_ROWS - 1]

    const b: any = {
      select(...a: any[]) { call.ops.push(['select', a]); return b },
      in(col: string, vals: any[]) {
        call.ops.push(['in', [col, vals]])
        const set = new Set(vals)
        rows = rows.filter(r => set.has(r[col]))
        return b
      },
      order(col: string, o: any = {}) {
        call.ops.push(['order', [col, o]])
        keys.push({ col, asc: o.ascending !== false })
        return b
      },
      range(a: number, z: number) { call.ops.push(['range', [a, z]]); range = [a, z]; return b },
      then(res: any, rej: any) {
        // An injected failure fires on the Nth request against that table.
        const nth = requests.filter(r => r.table === table).length
        if ((failures[table] || []).includes(nth)) {
          return Promise.resolve({ data: null, error: { message: `injected failure #${nth}` } }).then(res, rej)
        }
        // Postgres gives NO guarantee on the relative order of rows that tie on
        // the ORDER BY key, and that order can differ between two executions of
        // the same query — which is precisely how a paginated read over a
        // non-total sort key silently duplicates and drops rows. A stable
        // Array.sort over a fixture already in id order would hide that, so
        // permute the ties per request: only a genuinely total key
        // (orderCol + unique keyCols) survives this.
        rows = rows
          .map((r, i) => ({ r, k: (i * 2654435761 + requests.length * 40503) % 2147483647 }))
          .sort((x, y) => x.k - y.k)
          .map(x => x.r)
        if (keys.length) rows.sort(cmpBy(keys))
        const width = Math.min(range[1] - range[0] + 1, MAX_ROWS)
        return Promise.resolve({ data: rows.slice(range[0], range[0] + width), error: null }).then(res, rej)
      },
    }
    return b
  }

  return { db: { from }, requests }
}

const groupBy = (rows: any[]) => {
  const out: Record<string, any[]> = {}
  for (const r of rows) (out[r.lead_id] ||= []).push(r)
  return out
}

// ── fixture ───────────────────────────────────────────────────────────────
// 450 real leads (3 chunks of 200 at CHILD_CHUNK) + 40 junk leads whose child
// rows sit in the same table but are NOT in leadIds — the rows a bulk read sees
// and a chunked read never did.
const LEAD_IDS = Array.from({ length: 450 }, (_, i) => `lead-${String(i).padStart(4, '0')}`)
const JUNK_IDS = Array.from({ length: 40 }, (_, i) => `junk-${String(i).padStart(4, '0')}`)

// Deterministic pseudo-random so ties, nulls and interleaving are reproducible.
let seed = 42
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

function buildRows(orderCol: string | undefined, count: number, ids: string[], prefix: string) {
  const rows: any[] = []
  for (let i = 0; i < count; i++) {
    const lead_id = ids[Math.floor(rnd() * ids.length)]
    const row: any = { id: `${prefix}-${String(i).padStart(5, '0')}`, lead_id, payload: i }
    if (orderCol) {
      const r = rnd()
      // ~10% nulls, and a small date domain so ties on orderCol are common —
      // ties are exactly where a non-total sort would go non-deterministic
      // across pages and the two paths would drift.
      row[orderCol] = r < 0.1 ? null : `2026-0${1 + Math.floor(r * 9)}-01T00:00:00Z`
    }
    rows.push(row)
  }
  return rows
}

// The nine calls as _hub-page.tsx makes them. Row counts straddle the 1000-row
// page boundary on purpose: assessments/jobs/invoices force multi-page reads.
const CONFIGS: { table: string; orderCol?: string; ascending?: boolean; keyCols?: string[]; count: number }[] = [
  { table: 'lead_notes',       orderCol: 'created_at',      count: 7 },
  { table: 'touchpoints',      orderCol: 'occurred_at',     count: 343 },
  { table: 'lead_contacts',    orderCol: 'created_at', ascending: true, count: 0 },
  { table: 'lead_tags',        orderCol: undefined, ascending: false, keyCols: ['lead_id', 'tag_lookup_id'], count: 0 },
  { table: 'assessments',      orderCol: 'scheduled_at',    count: 2770 },
  { table: 'service_requests', orderCol: 'created_at',      count: 1000 },
  { table: 'quotes',           orderCol: 'sent_at',         count: 1001 },
  { table: 'jobs',             orderCol: 'scheduled_start', count: 2500 },
  { table: 'invoices',         orderCol: 'issued_at',       count: 4211 },
]

function fixtureFor(cfg: typeof CONFIGS[number]) {
  if (cfg.table === 'lead_tags') {
    // Composite PK, no id column — the one table whose uniqueness comes from
    // (lead_id, tag_lookup_id) rather than id.
    const rows: any[] = []
    for (const lead_id of [...LEAD_IDS.slice(0, 300), ...JUNK_IDS]) {
      for (const tag of ['tag-a', 'tag-b', 'tag-c']) {
        if (rnd() < 0.5) rows.push({ lead_id, tag_lookup_id: tag })
      }
    }
    return rows
  }
  return [
    ...buildRows(cfg.orderCol, cfg.count, LEAD_IDS, cfg.table),
    // Junk-lead rows: present in the table, absent from leadIds.
    ...buildRows(cfg.orderCol, Math.max(3, Math.round(cfg.count * 0.05)), JUNK_IDS, `${cfg.table}-junk`),
  ]
}

const call = (fetch: any, cfg: typeof CONFIGS[number], ids: string[]) =>
  fetch(cfg.table, ids, cfg.orderCol, cfg.ascending ?? false, cfg.keyCols ?? ['id'])

describe('createChildRowFetcher — chunked/bulk equivalence', () => {
  beforeEach(() => { seed = 42 })

  it.each(CONFIGS.map(c => [c.table, c] as const))(
    '%s: bulk output is identical to chunked, per lead and in order',
    async (_name, cfg) => {
      seed = 42
      const rows = fixtureFor(cfg)

      const a = makeDb({ [cfg.table]: rows })
      const chunkedRows = await call(createChildRowFetcher(a.db, { unscoped: false }), cfg, LEAD_IDS)

      const b = makeDb({ [cfg.table]: rows })
      const bulkRows = await call(createChildRowFetcher(b.db, { unscoped: true }), cfg, LEAD_IDS)

      const chunkedGrouped = groupBy(chunkedRows)
      const bulkGrouped = groupBy(bulkRows)

      // Same set of leads with rows at all.
      expect(Object.keys(bulkGrouped).sort()).toEqual(Object.keys(chunkedGrouped).sort())

      // Same rows, in the same order, for every lead. Deep-equal on the whole
      // array — not counts, not sets — because consumers read positionally.
      for (const leadId of Object.keys(chunkedGrouped)) {
        expect(bulkGrouped[leadId]).toEqual(chunkedGrouped[leadId])
      }

      // And the element every "newest X" / "latest Y" read actually takes.
      for (const leadId of Object.keys(chunkedGrouped)) {
        expect(bulkGrouped[leadId][0]).toEqual(chunkedGrouped[leadId][0])
      }
    }
  )

  // Equivalence alone can't catch a change applied to BOTH paths (they share
  // applyOrder), so pin the absolute contract too: newest-first everywhere
  // except lead_contacts, which is deliberately oldest-first.
  it.each(CONFIGS.filter(c => c.orderCol).map(c => [c.table, c] as const))(
    '%s: each lead reads %s in the declared direction, newest element first',
    async (_name, cfg) => {
      seed = 42
      const { db } = makeDb({ [cfg.table]: fixtureFor(cfg) })
      const grouped = groupBy(await call(createChildRowFetcher(db, { unscoped: true }), cfg, LEAD_IDS))
      const asc = cfg.ascending ?? false
      const col = cfg.orderCol!

      let sawMultiRowLead = false
      for (const rows of Object.values(grouped)) {
        if (rows.length > 1) sawMultiRowLead = true
        const vals = rows.map(r => r[col]).filter(v => v !== null && v !== undefined)
        for (let i = 1; i < vals.length; i++) {
          if (asc) expect(vals[i] >= vals[i - 1]).toBe(true)
          else expect(vals[i] <= vals[i - 1]).toBe(true)
        }
      }
      // Guard the guard — a fixture that gave every lead one row would make the
      // loop above vacuous.
      if (cfg.count > 50) expect(sawMultiRowLead).toBe(true)
    }
  )

  it('bulk drops the junk/bin-lead rows a chunked read never saw', async () => {
    const cfg = CONFIGS.find(c => c.table === 'jobs')!
    const rows = fixtureFor(cfg)
    expect(rows.some(r => r.lead_id.startsWith('junk-'))).toBe(true)

    const { db } = makeDb({ jobs: rows })
    const out = await call(createChildRowFetcher(db, { unscoped: true }), cfg, LEAD_IDS)

    expect(out.some(r => r.lead_id.startsWith('junk-'))).toBe(false)
    // Exactly the rows whose lead is in scope — no superset, no shortfall.
    expect(out.length).toBe(rows.filter(r => LEAD_IDS.includes(r.lead_id)).length)
  })

  it('paginates past the 1000-row cap without truncating', async () => {
    // 4,211 invoice rows + junk = five pages. A page size above PostgREST's
    // 1000-row ceiling would read page 1 as short and stop at 1000.
    const cfg = CONFIGS.find(c => c.table === 'invoices')!
    const rows = fixtureFor(cfg)
    const inScope = rows.filter(r => LEAD_IDS.includes(r.lead_id))
    expect(inScope.length).toBeGreaterThan(4000)

    const { db, requests } = makeDb({ invoices: rows })
    const out = await call(createChildRowFetcher(db, { unscoped: true }), cfg, LEAD_IDS)

    expect(out.length).toBe(inScope.length)
    expect(requests.length).toBe(Math.floor(rows.length / MAX_ROWS) + 1)
  })

  it('stops on the first short page rather than paging forever', async () => {
    const cfg = CONFIGS.find(c => c.table === 'lead_contacts')!
    const { db, requests } = makeDb({ lead_contacts: [] })
    const out = await call(createChildRowFetcher(db, { unscoped: true }), cfg, LEAD_IDS)
    // The measured worst case: 275 round trips to fetch zero rows. Now one.
    expect(out).toEqual([])
    expect(requests.length).toBe(1)
  })

  it('an exactly-full final page still terminates (1000 rows = 2 requests)', async () => {
    const rows = buildRows('created_at', MAX_ROWS, LEAD_IDS, 'sr')
    const cfg = { table: 'service_requests', orderCol: 'created_at', count: MAX_ROWS }
    const { db, requests } = makeDb({ service_requests: rows })
    const out = await call(createChildRowFetcher(db, { unscoped: true }), cfg as any, LEAD_IDS)
    expect(out.length).toBe(MAX_ROWS)
    expect(requests.length).toBe(2)
  })
})

describe('createChildRowFetcher — path selection', () => {
  beforeEach(() => { seed = 42 })

  it('the scoped caller still chunks by lead id, and is not regressed', async () => {
    const cfg = CONFIGS.find(c => c.table === 'jobs')!
    const rows = fixtureFor(cfg)
    // A location-scoped caller carries one location's leads, not the tenant's.
    const scopedIds = LEAD_IDS.slice(0, 180)

    const { db, requests } = makeDb({ jobs: rows })
    const out = await call(createChildRowFetcher(db, { unscoped: false }), cfg, scopedIds)

    // Every request is still id-filtered — the scoped caller never reads the
    // whole table, so another location's rows can't reach them.
    expect(requests.length).toBeGreaterThan(0)
    for (const r of requests) {
      const inOp = r.ops.find(([op]) => op === 'in')
      expect(inOp).toBeDefined()
      expect(inOp![1][1].every((id: string) => scopedIds.includes(id))).toBe(true)
    }
    expect(out.every(r => scopedIds.includes(r.lead_id))).toBe(true)
  })

  it('an unscoped caller under one chunk stays chunked — bulk would read the whole table', async () => {
    const cfg = CONFIGS.find(c => c.table === 'jobs')!
    const rows = fixtureFor(cfg)
    const fewIds = LEAD_IDS.slice(0, 200)

    const { db, requests } = makeDb({ jobs: rows })
    await call(createChildRowFetcher(db, { unscoped: true }), cfg, fewIds)

    expect(requests.length).toBeGreaterThan(0)
    for (const r of requests) expect(r.ops.some(([op]) => op === 'in')).toBe(true)
  })

  it('bulk cuts round trips hard versus chunked on the elevated set', async () => {
    const cfg = CONFIGS.find(c => c.table === 'assessments')!
    const rows = fixtureFor(cfg)

    const a = makeDb({ assessments: rows })
    await call(createChildRowFetcher(a.db, { unscoped: false }), cfg, LEAD_IDS)
    const b = makeDb({ assessments: rows })
    await call(createChildRowFetcher(b.db, { unscoped: true }), cfg, LEAD_IDS)

    // 450 ids = 3 chunks, each paged; bulk is ceil(total/1000)+... either way
    // strictly fewer. In prod this is 36 → 3 for the same table.
    expect(b.requests.length).toBeLessThan(a.requests.length)
    expect(a.requests.length).toBeGreaterThanOrEqual(3)
  })
})

describe('createChildRowFetcher — failure behaviour', () => {
  beforeEach(() => { seed = 42 })

  it('a failed bulk page falls back to the chunked path, with complete rows', async () => {
    const cfg = CONFIGS.find(c => c.table === 'jobs')!
    const rows = fixtureFor(cfg)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    const good = makeDb({ jobs: rows })
    const expected = await call(createChildRowFetcher(good.db, { unscoped: false }), cfg, LEAD_IDS)

    // Fail the 2nd bulk page — mid-stream, after rows have accumulated.
    const bad = makeDb({ jobs: rows }, { jobs: [2] })
    const out = await call(createChildRowFetcher(bad.db, { unscoped: true }), cfg, LEAD_IDS)

    // Falling back must not blank the table for every lead, and must not
    // double-count the pages already read before the failure.
    expect(groupBy(out)).toEqual(groupBy(expected))
    expect(err).toHaveBeenCalledWith(expect.stringContaining('retrying on the chunked path'))
    err.mockRestore()
  })

  it('a failed chunk logs loudly and leaves the other chunks intact', async () => {
    const cfg = CONFIGS.find(c => c.table === 'jobs')!
    const rows = fixtureFor(cfg)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { db } = makeDb({ jobs: rows }, { jobs: [1] })
    const out = await call(createChildRowFetcher(db, { unscoped: false }), cfg, LEAD_IDS)

    expect(err).toHaveBeenCalledWith(expect.stringContaining('child fetch FAILED'))
    // Chunks 2 and 3 still landed.
    expect(out.length).toBeGreaterThan(0)
    expect(out.every(r => !LEAD_IDS.slice(0, 200).includes(r.lead_id))).toBe(true)
    err.mockRestore()
  })
})

describe('_hub-page wiring', () => {
  const src = readFileSync('app/_hub-page.tsx', 'utf8')

  it('the nine child fetches still pass the order/key args these tests pin', () => {
    expect(src).toContain(`fetchChildRows('lead_notes', leadIds, 'created_at')`)
    expect(src).toContain(`fetchChildRows('touchpoints', leadIds, 'occurred_at')`)
    expect(src).toContain(`fetchChildRows('lead_contacts', leadIds, 'created_at', true)`)
    expect(src).toContain(`fetchChildRows('lead_tags', leadIds, undefined, false, ['lead_id', 'tag_lookup_id'])`)
    expect(src).toContain(`fetchChildRows('assessments', leadIds, 'scheduled_at')`)
    expect(src).toContain(`fetchChildRows('service_requests', leadIds, 'created_at')`)
    expect(src).toContain(`fetchChildRows('quotes', leadIds, 'sent_at')`)
    expect(src).toContain(`fetchChildRows('jobs', leadIds, 'scheduled_start')`)
    expect(src).toContain(`fetchChildRows('invoices', leadIds, 'issued_at')`)
  })

  it('unscoped mirrors the leads query filter exactly', () => {
    // If these two drift, bulk would read the whole table for a caller whose
    // leadIds are only one location's — silently handing them other locations'
    // child rows.
    //
    // Phase 1 (Fix 2) made this structurally impossible rather than merely
    // pinned: both the leads filter and this flag now read the SAME
    // `scopeLocationUuid` binding, so there is no second copy of the condition
    // left to drift. The pre-Phase-1 form duplicated `!isElevated &&
    // hubUser.location_id` in both places and relied on this test to keep them
    // in step. See lib/beta-hub-scope.test.ts for the full scope suite.
    expect(src).toContain(`const childRowsUnscoped = !scopeLocationUuid`)
    expect(src).toContain(`if (scopeLocationUuid) {\n        q = q.eq('location_uuid', scopeLocationUuid)`)
  })
})
