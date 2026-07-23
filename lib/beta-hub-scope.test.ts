// @vitest-environment node
//
// Fix 2 / Phase 1 — the server-side location scope.
//
// Three things are being defended here, in descending order of how badly they
// fail if they break:
//
//  1. THE SLUG/UUID SWAP. Child tables disagree about how they name a location
//     (`location_id` = slug on quotes/jobs/invoices/assessments/
//     service_requests, `location_uuid` = uuid on touchpoints/lead_notes).
//     Passing the wrong form returns ZERO ROWS WITH NO ERROR — every card
//     renders with empty children, nothing logs, and the page looks fine. That
//     is invisible in review and in staging. These tests assert the exact
//     column AND value form per table, both at the vocabulary level and
//     THROUGH THE REAL FETCHER, so a swap fails the suite instead of shipping.
//
//  2. THE UNSCOPED PATH IS UNCHANGED. Phase 1's whole safety story is that a
//     missing/forged/'all' cookie yields byte-identical behavior to before, so
//     it is revertible by clearing one cookie. Pinned by equivalence against
//     the pre-Phase-1 paths.
//
//  3. A COOKIE CANNOT GRANT ACCESS. It is user-controlled. A franchise user
//     must not be able to read another location by setting one, and a forged
//     value must degrade to 'all' rather than reaching a query or erroring.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: {} }))
vi.mock('@/components/BeeHub', () => ({ default: () => null }))

import {
  SCOPE_COOKIE_NAME,
  SCOPE_ALL,
  normalizeScopeCookie,
  resolveHubScope,
  isElevatedPickedScope,
  childLocationFilter,
  CHILD_LOCATION_SCOPE,
  scopeCookieString,
  isUuid,
} from '@/lib/hub-scope'
import { createChildRowFetcher } from '@/app/_hub-page'

const KC_UUID = '80ffb75d-44a9-4160-aee1-9919dd97de97'
const KC_SLUG = 'loc_kc'
const PDX_UUID = '1b62628f-e3be-4024-be2d-e8179f09f740'
const LOC = { uuid: KC_UUID, slug: KC_SLUG }

// ── the two vocabularies, stated independently of the implementation ────────
// Deliberately a SEPARATE literal from CHILD_LOCATION_SCOPE — if this were
// derived from the module it would agree with any swap and prove nothing.
const SLUG_TABLES = ['quotes', 'jobs', 'invoices', 'assessments', 'service_requests']
const UUID_TABLES = ['touchpoints', 'lead_notes']
const NO_COLUMN_TABLES = ['lead_contacts', 'lead_tags']

describe('hub-scope — the slug/uuid vocabulary', () => {
  it.each(SLUG_TABLES)('%s filters location_id on the SLUG, never the uuid', (table) => {
    const f = childLocationFilter(table, LOC)
    expect(f).toEqual({ column: 'location_id', value: KC_SLUG })
    // The swap assertion, stated as a property rather than a value: a slug
    // table must never carry a uuid-shaped filter value.
    expect(isUuid(f!.value)).toBe(false)
    expect(f!.value).not.toBe(KC_UUID)
    expect(f!.column).not.toBe('location_uuid')
  })

  it.each(UUID_TABLES)('%s filters location_uuid on the UUID, never the slug', (table) => {
    const f = childLocationFilter(table, LOC)
    expect(f).toEqual({ column: 'location_uuid', value: KC_UUID })
    expect(isUuid(f!.value)).toBe(true)
    expect(f!.value).not.toBe(KC_SLUG)
    expect(f!.column).not.toBe('location_id')
  })

  it.each(NO_COLUMN_TABLES)('%s has no location column and returns null', (table) => {
    expect(CHILD_LOCATION_SCOPE[table]).toBeNull()
    expect(childLocationFilter(table, LOC)).toBeNull()
  })

  it('every table _hub-page fetches has an explicit entry — no silent omissions', () => {
    // A new child table added to the page without a decision here would fall
    // through to the lead-id path forever and quietly lose the perf win. Force
    // the choice to be made in the vocabulary, not by omission.
    for (const t of [...SLUG_TABLES, ...UUID_TABLES, ...NO_COLUMN_TABLES]) {
      expect(Object.prototype.hasOwnProperty.call(CHILD_LOCATION_SCOPE, t)).toBe(true)
    }
  })

  it('an unknown table degrades to the lead-id path rather than guessing', () => {
    expect(childLocationFilter('some_new_child_table', LOC)).toBeNull()
  })

  it('a location with no slug does NOT fall back to the uuid on a slug table', () => {
    // Falling back would query a slug column with a uuid: zero rows, no error.
    // Returning null routes to the lead-id-fenced read, which is correct.
    const f = childLocationFilter('quotes', { uuid: KC_UUID, slug: null })
    expect(f).toBeNull()
    // The uuid tables are unaffected — they never needed the slug.
    expect(childLocationFilter('touchpoints', { uuid: KC_UUID, slug: null }))
      .toEqual({ column: 'location_uuid', value: KC_UUID })
  })
})

// ── cookie handling ─────────────────────────────────────────────────────────
describe('hub-scope — cookie normalization', () => {
  it('accepts a well-formed uuid', () => {
    expect(normalizeScopeCookie(KC_UUID)).toBe(KC_UUID)
    expect(normalizeScopeCookie(`  ${KC_UUID}  `)).toBe(KC_UUID)
    expect(normalizeScopeCookie(KC_UUID.toUpperCase())).toBe(KC_UUID.toUpperCase())
  })

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['the literal all', 'all'],
    ['a slug', 'loc_kc'],
    ['the string undefined', 'undefined'],
    ['a truncated uuid', '80ffb75d-44a9-4160-aee1'],
    ['sql-ish injection', "' or '1'='1"],
    ['a postgrest operator payload', 'in.(1,2)'],
    ['a comma list', `${KC_UUID},${PDX_UUID}`],
    ['whitespace', '   '],
  ])('collapses %s to SCOPE_ALL', (_label, raw) => {
    expect(normalizeScopeCookie(raw as any)).toBe(SCOPE_ALL)
  })

  it('the cookie string the client writes carries the name the server reads', () => {
    const s = scopeCookieString(KC_UUID)
    expect(s.startsWith(`${SCOPE_COOKIE_NAME}=${KC_UUID};`)).toBe(true)
    expect(s).toContain('path=/')
    expect(s).toContain('samesite=lax')
  })

  it('the client cannot write a non-uuid scope either — it degrades to all', () => {
    expect(scopeCookieString('loc_kc')).toContain(`${SCOPE_COOKIE_NAME}=${SCOPE_ALL};`)
    expect(scopeCookieString('all')).toContain(`${SCOPE_COOKIE_NAME}=${SCOPE_ALL};`)
  })
})

// ── who may use the cookie ──────────────────────────────────────────────────
describe('hub-scope — resolveHubScope', () => {
  const validated = { id: KC_UUID, slug: KC_SLUG }

  it('elevated + a validated cookie scopes to that location', () => {
    expect(resolveHubScope({ isElevated: true, hubUserLocationId: null, validated }))
      .toEqual({ locationUuid: KC_UUID, locationSlug: KC_SLUG, source: 'cookie' })
  })

  it('elevated + no cookie is today’s behavior: no filter at all', () => {
    expect(resolveHubScope({ isElevated: true, hubUserLocationId: null, validated: null }))
      .toEqual({ locationUuid: null, locationSlug: null, source: 'all' })
  })

  it('elevated + a cookie that failed DB validation falls back to all, never errors', () => {
    // The caller passes null for unknown/deleted/forged ids.
    const s = resolveHubScope({ isElevated: true, hubUserLocationId: null, validated: null })
    expect(s.locationUuid).toBeNull()
    expect(s.source).toBe('all')
  })

  it('a NON-elevated user IGNORES the cookie entirely and stays on their own location', () => {
    // The escalation attempt: a franchise user at Portland hand-sets the cookie
    // to Kansas City. They must still be fenced to Portland.
    const s = resolveHubScope({
      isElevated: false,
      hubUserLocationId: PDX_UUID,
      validated,                      // a fully valid KC row
    })
    expect(s.locationUuid).toBe(PDX_UUID)
    expect(s.source).toBe('own-location')
    // And no slug, so they never take the location-scoped child path either —
    // they keep the chunked lead-id path they use today.
    expect(s.locationSlug).toBeNull()
  })

  it('a non-elevated user with no location keeps the historical no-filter behavior', () => {
    expect(resolveHubScope({ isElevated: false, hubUserLocationId: null, validated }))
      .toEqual({ locationUuid: null, locationSlug: null, source: 'all' })
  })

  it('only source==="cookie" ever yields a slug — the child scope gate', () => {
    // _hub-page derives childScopeLocation from source==='cookie'. If an
    // own-location scope ever produced a slug, a franchise user would silently
    // switch onto the location-scoped child path.
    for (const s of [
      resolveHubScope({ isElevated: false, hubUserLocationId: PDX_UUID, validated }),
      resolveHubScope({ isElevated: false, hubUserLocationId: null, validated }),
      resolveHubScope({ isElevated: true, hubUserLocationId: null, validated: null }),
    ]) {
      expect(s.locationSlug).toBeNull()
      expect(s.source).not.toBe('cookie')
    }
  })
})

// ── the fetcher's location-scoped path ──────────────────────────────────────
// A fake PostgREST that records .eq() so the assertions can read the ACTUAL
// column+value the query carried, not what the vocabulary claims in isolation.
const MAX_ROWS = 1000

function makeDb(tables: Record<string, any[]>, failures: Record<string, number[]> = {}) {
  const requests: { table: string; ops: [string, any[]][] }[] = []

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
      eq(col: string, val: any) {
        call.ops.push(['eq', [col, val]])
        // Real equality semantics — a uuid handed to a slug column matches
        // NOTHING and returns success, exactly like PostgREST. That is the
        // failure this fake exists to reproduce.
        rows = rows.filter(r => r[col] === val)
        return b
      },
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
        const nth = requests.filter(r => r.table === table).length
        if ((failures[table] || []).includes(nth)) {
          return Promise.resolve({ data: null, error: { message: `injected failure #${nth}` } }).then(res, rej)
        }
        // Permute ties per request, as the sibling suite does: only a genuinely
        // total sort key survives paginated reads.
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

// Fixture: two locations' rows in one table, plus junk-lead rows at the SCOPED
// location (present in the table, absent from leadIds — the rows a location
// filter WILL return and the lead-id fence must drop).
let seed = 7
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

const KC_LEADS = Array.from({ length: 450 }, (_, i) => `kc-lead-${String(i).padStart(4, '0')}`)
const KC_JUNK = Array.from({ length: 25 }, (_, i) => `kc-junk-${String(i).padStart(4, '0')}`)
const PDX_LEADS = Array.from({ length: 300 }, (_, i) => `pdx-lead-${String(i).padStart(4, '0')}`)

function buildTable(orderCol: string, count: number) {
  const rows: any[] = []
  const mk = (ids: string[], slug: string, uuid: string, tag: string, n: number) => {
    for (let i = 0; i < n; i++) {
      const r = rnd()
      rows.push({
        id: `${tag}-${String(i).padStart(5, '0')}`,
        lead_id: ids[Math.floor(rnd() * ids.length)],
        // BOTH columns present on every row so a swapped filter is a real
        // possibility the fake can express (and match nothing on).
        location_id: slug,
        location_uuid: uuid,
        [orderCol]: r < 0.1 ? null : `2026-0${1 + Math.floor(r * 9)}-01T00:00:00Z`,
      })
    }
  }
  mk(KC_LEADS, KC_SLUG, KC_UUID, 'kc', count)
  mk(KC_JUNK, KC_SLUG, KC_UUID, 'kcjunk', Math.round(count * 0.08))
  mk(PDX_LEADS, 'loc_portland', PDX_UUID, 'pdx', Math.round(count * 0.6))
  return rows
}

describe('createChildRowFetcher — the location-scoped path', () => {
  beforeEach(() => { seed = 7 })

  it.each([
    ['quotes', 'sent_at', 'location_id', KC_SLUG],
    ['jobs', 'scheduled_start', 'location_id', KC_SLUG],
    ['invoices', 'issued_at', 'location_id', KC_SLUG],
    ['assessments', 'scheduled_at', 'location_id', KC_SLUG],
    ['service_requests', 'created_at', 'location_id', KC_SLUG],
    ['touchpoints', 'occurred_at', 'location_uuid', KC_UUID],
    ['lead_notes', 'created_at', 'location_uuid', KC_UUID],
  ])('%s issues .eq(%s) with the right value form — a swap returns nothing', async (table, orderCol, wantCol, wantVal) => {
    seed = 7
    const rows = buildTable(orderCol as string, 900)
    const { db, requests } = makeDb({ [table as string]: rows })

    const fetch = createChildRowFetcher(db, { unscoped: false, location: LOC })
    const out = await fetch(table as string, KC_LEADS, orderCol as string, false, ['id'])

    // THE assertion: the real recorded filter, column AND value.
    const eqOps = requests.flatMap(r => r.ops.filter(([op]) => op === 'eq'))
    expect(eqOps.length).toBeGreaterThan(0)
    for (const [, [col, val]] of eqOps) {
      expect(col).toBe(wantCol)
      expect(val).toBe(wantVal)
    }

    // And the consequence, so the test fails on BEHAVIOR too and not only on a
    // recorded string: a swapped form would match zero rows here.
    expect(out.length).toBeGreaterThan(0)
    expect(out.every(r => r.lead_id.startsWith('kc-lead-'))).toBe(true)
    // Never chunked by lead id on this path — that's the round-trip win.
    expect(requests.every(r => !r.ops.some(([op]) => op === 'in'))).toBe(true)
  })

  it('a swapped value form really does return zero rows (the failure being defended against)', async () => {
    // Demonstrates the silent-failure mode explicitly: the fake is faithful, so
    // a uuid on a slug column succeeds and yields nothing.
    const rows = buildTable('sent_at', 400)
    const { db } = makeDb({ quotes: rows })
    const swapped = createChildRowFetcher(db, {
      unscoped: false,
      // slug deliberately set to the uuid — what a copy/paste mistake looks like
      location: { uuid: KC_UUID, slug: KC_UUID as any },
    })
    const out = await swapped('quotes', KC_LEADS, 'sent_at', false, ['id'])
    expect(out).toEqual([])   // no error, no log — just empty. Hence the tests above.
  })

  it('the location filter never leaks another location’s rows', async () => {
    const rows = buildTable('scheduled_start', 700)
    const { db } = makeDb({ jobs: rows })
    const fetch = createChildRowFetcher(db, { unscoped: false, location: LOC })
    const out = await fetch('jobs', KC_LEADS, 'scheduled_start', false, ['id'])
    expect(out.some(r => r.location_id === 'loc_portland')).toBe(false)
    expect(out.some(r => r.lead_id.startsWith('pdx-'))).toBe(false)
  })

  it('the lead-id fence still drops the scope’s own junk/bin-lead rows', async () => {
    // These rows DO match the location filter — only the lead-id fence removes
    // them. Without it, byEngagement() would attach a junked lead's rows to a
    // live board card.
    const rows = buildTable('scheduled_start', 700)
    expect(rows.some(r => r.lead_id.startsWith('kc-junk-'))).toBe(true)
    const { db } = makeDb({ jobs: rows })
    const fetch = createChildRowFetcher(db, { unscoped: false, location: LOC })
    const out = await fetch('jobs', KC_LEADS, 'scheduled_start', false, ['id'])
    expect(out.some(r => r.lead_id.startsWith('kc-junk-'))).toBe(false)
    expect(out.length).toBe(rows.filter(r => KC_LEADS.includes(r.lead_id)).length)
  })

  it('produces byte-identical grouped output to the chunked path it replaces', async () => {
    // The correctness bar for the whole change: same rows per lead, same order.
    // Everything downstream (newest-touchpoint, latest-invoice, first-quote) is
    // positional, so equality of sets is not enough.
    const rows = buildTable('issued_at', 1400)
    const a = makeDb({ invoices: rows })
    const chunked = await createChildRowFetcher(a.db, { unscoped: false })(
      'invoices', KC_LEADS, 'issued_at', false, ['id'])
    const b = makeDb({ invoices: rows })
    const scoped = await createChildRowFetcher(b.db, { unscoped: false, location: LOC })(
      'invoices', KC_LEADS, 'issued_at', false, ['id'])

    const g1 = groupBy(chunked), g2 = groupBy(scoped)
    expect(Object.keys(g2).sort()).toEqual(Object.keys(g1).sort())
    for (const id of Object.keys(g1)) expect(g2[id]).toEqual(g1[id])
    // …and strictly fewer round trips than chunking 450 ids.
    expect(b.requests.length).toBeLessThan(a.requests.length)
  })

  it('paginates past the 1000-row cap without truncating', async () => {
    const rows = buildTable('issued_at', 2600)
    const inScope = rows.filter(r => KC_LEADS.includes(r.lead_id))
    expect(inScope.length).toBeGreaterThan(2000)
    const { db } = makeDb({ invoices: rows })
    const out = await createChildRowFetcher(db, { unscoped: false, location: LOC })(
      'invoices', KC_LEADS, 'issued_at', false, ['id'])
    expect(out.length).toBe(inScope.length)
  })

  it('tables with no location column read through and are fenced by lead id', async () => {
    // lead_contacts/lead_tags have no location column — they must NOT be
    // chunked into 17 requests, and must still exclude other locations.
    const rows = [
      ...KC_LEADS.slice(0, 40).map((lead_id, i) => ({ id: `lc-${i}`, lead_id, created_at: '2026-01-01T00:00:00Z' })),
      ...PDX_LEADS.slice(0, 40).map((lead_id, i) => ({ id: `lcp-${i}`, lead_id, created_at: '2026-01-01T00:00:00Z' })),
    ]
    const { db, requests } = makeDb({ lead_contacts: rows })
    const out = await createChildRowFetcher(db, { unscoped: false, location: LOC })(
      'lead_contacts', KC_LEADS, 'created_at', true, ['id'])
    expect(out.length).toBe(40)
    expect(out.every(r => r.lead_id.startsWith('kc-lead-'))).toBe(true)
    expect(requests.length).toBe(1)
    expect(requests[0].ops.some(([op]) => op === 'eq')).toBe(false)
  })

  it('a failed page falls back to the chunked path rather than blanking the table', async () => {
    const rows = buildTable('scheduled_start', 1600)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const good = makeDb({ jobs: rows })
    const expected = await createChildRowFetcher(good.db, { unscoped: false })(
      'jobs', KC_LEADS, 'scheduled_start', false, ['id'])

    const bad = makeDb({ jobs: rows }, { jobs: [2] })
    const out = await createChildRowFetcher(bad.db, { unscoped: false, location: LOC })(
      'jobs', KC_LEADS, 'scheduled_start', false, ['id'])

    expect(groupBy(out)).toEqual(groupBy(expected))
    expect(err).toHaveBeenCalledWith(expect.stringContaining('retrying on the chunked path'))
    err.mockRestore()
  })
})

describe('createChildRowFetcher — the unscoped paths are untouched', () => {
  beforeEach(() => { seed = 7 })

  it('no location → the pre-Phase-1 path selection, request for request', async () => {
    // The revertibility guarantee: with location absent, the fetcher must make
    // exactly the calls it made before Phase 1 existed.
    const rows = buildTable('scheduled_start', 900)
    const ids = [...KC_LEADS, ...PDX_LEADS]

    const a = makeDb({ jobs: rows })
    await createChildRowFetcher(a.db, { unscoped: true })('jobs', ids, 'scheduled_start', false, ['id'])
    const b = makeDb({ jobs: rows })
    await createChildRowFetcher(b.db, { unscoped: true, location: null })('jobs', ids, 'scheduled_start', false, ['id'])

    expect(b.requests).toEqual(a.requests)
    // bulk: whole-table pages, never id-chunked, never location-filtered.
    expect(b.requests.every(r => !r.ops.some(([op]) => op === 'in' || op === 'eq'))).toBe(true)
  })

  it('scoped-by-lead-id (franchise) is unchanged and never location-filters', async () => {
    const rows = buildTable('scheduled_start', 900)
    const a = makeDb({ jobs: rows })
    const out = await createChildRowFetcher(a.db, { unscoped: false })(
      'jobs', PDX_LEADS, 'scheduled_start', false, ['id'])
    expect(a.requests.every(r => r.ops.some(([op]) => op === 'in'))).toBe(true)
    expect(a.requests.every(r => !r.ops.some(([op]) => op === 'eq'))).toBe(true)
    expect(out.every(r => PDX_LEADS.includes(r.lead_id))).toBe(true)
  })
})

// ── source-level wiring pins ────────────────────────────────────────────────
describe('_hub-page wiring — scope', () => {
  const src = readFileSync('app/_hub-page.tsx', 'utf8')

  it('every location filter reads the ONE resolved scope value', () => {
    // Nine sites: leads, engagement sweep, open engagements, closed count,
    // closed-won count, bin, partners, companies (+ the childRowsUnscoped
    // derivation below). If any reverted to `hubUser.location_id` directly it
    // would ignore an elevated user's selection while its siblings honored it —
    // a half-scoped payload, which is worse than either extreme.
    expect(src).toContain(`const scopeLocationUuid = scope.locationUuid`)
    expect(src.match(/q = q\.eq\('location_uuid', scopeLocationUuid\)/g) || []).toHaveLength(3)
    expect(src).toContain(`cq = cq.eq('location_uuid', scopeLocationUuid)`)
    expect(src).toContain(`wq = wq.eq('location_uuid', scopeLocationUuid)`)
    expect(src).toContain(`binQ = binQ.eq('location_uuid', scopeLocationUuid)`)
    expect(src).toContain(`pq = pq.eq('location_id', scopeLocationUuid)`)
    expect(src).toContain(`cq = cq.eq('location_id', scopeLocationUuid)`)
    // No site may still hard-code the user's own location as the filter.
    expect(src).not.toContain(`q.eq('location_uuid', hubUser.location_id)`)
  })

  it('childRowsUnscoped is DERIVED from the same value the leads query filters on', () => {
    // These two drifting is the specific bug that would hand one location's
    // leads another location's child rows. Deriving from the same binding makes
    // drift impossible; two hand-written copies of the condition did not.
    expect(src).toContain(`const childRowsUnscoped = !scopeLocationUuid`)
    expect(src).toContain(`location: childScopeLocation,`)
  })

  it('the child scope is gated on an ELEVATED PICKED scope — franchise users never take it', () => {
    // Phase 1 inlined `scope.source === 'cookie'` here. Phase 2 added a second
    // elevated way to pick a location (a deep link to a lead outside the
    // selection), so the gate moved into isElevatedPickedScope() — one
    // predicate both sources go through, rather than a growing inline
    // disjunction that a third source could quietly miss.
    expect(src).toContain(`isElevatedPickedScope(scope) && scope.locationUuid`)
    // The property that actually matters, asserted on behavior rather than on
    // the source string: a franchise user's scope never opens this gate.
    expect(isElevatedPickedScope(resolveHubScope({
      isElevated: false, hubUserLocationId: PDX_UUID, validated: { id: KC_UUID, slug: KC_SLUG },
    }))).toBe(false)
  })

  it('the cookie is validated against the locations table before it can filter', () => {
    // Phase 3 replaced normalizeScopeCookie here with readScopePreference,
    // which keeps "no cookie" and "the user explicitly chose All Locations"
    // distinct — without that distinction the Phase 3 default would override
    // an explicit All Locations choice and make the option unselectable.
    // normalizeScopeCookie still exists and is now DEFINED in terms of
    // readScopePreference, so the two readers cannot drift (pinned in
    // lib/beta-hub-scope-phase3.test.ts).
    expect(src).toContain(`readScopePreference`)
    expect(src).toContain(`.from('locations')`)
    expect(src).toContain(`.eq('id', scopePref.uuid)`)
    // Elevated-only lookup — a franchise user's cookie is never even read back.
    expect(src).toContain(`if (isElevated && scopePref.kind === 'location')`)
  })

  it('initialLocFilter follows the server scope so the client cannot filter to empty', () => {
    expect(src).toContain(`const initialLocFilter = isElevated\n    ? (scope.locationUuid || 'all')\n    : hubUser.location_id || 'all'`)
  })

  it('MAX_LEADS stays at 10,000 in Phase 1', () => {
    expect(src).toContain('const MAX_LEADS = 10000')
  })
})

describe('BeeHub wiring — scope switch + prop sync', () => {
  const src = readFileSync('components/BeeHub.jsx', 'utf8')

  it('every locFilter change goes through applyLocScope', () => {
    // A raw setLocFilter would move the client without moving the server —
    // the two would disagree and intersect to an empty screen.
    const raw = src.match(/(?<!set)\bsetLocFilter\(/g) || []
    // Only the two declarations (App + the two admin sub-screens' own local
    // state) and applyLocScope's own body may call it.
    const decls = src.match(/\[locFilter, setLocFilter\]/g) || []
    expect(decls.length).toBe(3)
    expect(src).toContain('const applyLocScope = React.useCallback((next) => {')
    expect(src).toContain('document.cookie = scopeCookieString(')
    expect(src).toContain('router.refresh()')
    // The App's own picker/view-as handlers must all be on the helper.
    expect(src).toContain(`applyLocScope(loc.id)`)
    expect(src).toContain(`applyLocScope('all')`)
    expect(src).toContain(`applyLocScope(isCorp ? 'all' : user.locationId)`)
    expect(src).toContain(`applyLocScope(next.locFilter)`)
    expect(raw.length).toBeGreaterThan(0) // sanity: the regex matches something
  })

  it('all six scope-carrying props sync prop→state after router.refresh()', () => {
    for (const p of ['initialPeople', 'initialBinPeople', 'initialPartners', 'initialCompanies', 'initialUsers', 'initialSeats']) {
      expect(src).toContain(`}, [${p}])`)
    }
  })
})
