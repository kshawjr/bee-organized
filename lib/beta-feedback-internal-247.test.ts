// @vitest-environment node
//
// issue 247 step 1 — INTERNAL BUGS STAY INTERNAL.
//
// feedback_items becomes the single tracker: owner reports AND internally-found
// bugs, in one table, so overlap is visible — when Kevin logs "Palm Beach
// import is stuck" and Ankur reports the same thing a week later, both rows sit
// against one location instead of one being in ClickUp where nobody
// cross-references it.
//
// THE RULE: an owner sees items THEIR LOCATION SUBMITTED. Nothing else.
//
// WHY THE OLD PREDICATE IS NOT THAT RULE. location_id is copied from the
// SUBMITTER on insert, so `.eq('location_id', <theirs>)` means "submitted from
// here" — which today IS "what my location submitted", because owners are the
// only filers. Tagging an internal item with a location is exactly what makes
// the overlap visible AND exactly what splits those two readings apart. From
// that moment the old predicate publishes internal work to the owner it is
// about.
//
// These tests are written against OUTCOMES — the fake applies the filters to a
// real row set — so they pin what an owner actually receives, not merely that
// some function was called.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, any[]>,
    // false simulates the LIVE database before Kevin runs the migration.
    internalColumn: true,
    queries: [] as { table: string; filters: [string, any][] }[],
    updates: [] as { table: string; arg: any }[],
  }
  const reset = () => {
    state.tables = {}
    state.internalColumn = true
    state.queries = []
    state.updates = []
  }

  const makeBuilder = (table: string) => {
    const filters: [string, any][] = []
    let selectNamesInternal = false
    const b: any = {}
    b.select = (cols?: string) => {
      if (typeof cols === 'string' && cols.includes('is_internal')) selectNamesInternal = true
      return b
    }
    b.eq = (col: string, val: any) => { filters.push([col, val]); return b }
    for (const m of ['order', 'limit', 'in', 'is', 'not']) b[m] = () => b
    b.update = (arg: any) => { state.updates.push({ table, arg }); b.__update = arg; return b }
    b.insert = () => b

    const namesInternal = () => selectNamesInternal || filters.some(([c]) => c === 'is_internal')
    // What Postgres/PostgREST actually say when the column isn't there yet.
    const missingColumn = {
      code: '42703',
      message: 'column feedback_items.is_internal does not exist',
    }

    const resolve = () => {
      state.queries.push({ table, filters: filters.slice() })
      if (!state.internalColumn && namesInternal()) return { data: null, error: missingColumn }
      let rows = (state.tables[table] || []).slice()
      for (const [col, val] of filters) rows = rows.filter(r => r[col] === val)
      if (b.__update) rows = rows.map(r => ({ ...r, ...b.__update }))
      return { data: rows, error: null }
    }
    b.single = () => {
      const r = resolve()
      if (r.error) return Promise.resolve(r)
      const rows = r.data as any[]
      if (!rows.length) return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows returned' } })
      return Promise.resolve({ data: rows[0], error: null })
    }
    b.maybeSingle = b.single
    b.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej)
    return b
  }
  return { state, reset, makeBuilder }
})

const authUser = vi.hoisted(() => ({ current: { id: 'owner-1' } as any }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
// The reply rail is issue 233's business, not this one — stub it so a PATCH
// that legitimately succeeds doesn't try to send mail.
vi.mock('@/lib/resend', () => ({ sendEmailDirect: vi.fn(async () => ({ success: true, id: 'm1' })) }))

import { GET as ADMIN_GET } from '@/app/api/admin/feedback/route'
import { PATCH } from '@/app/api/admin/feedback/[id]/route'
import { GET as MINE_GET } from '@/app/api/feedback/route'
import {
  isInternalItem,
  isMissingInternalColumn,
  withInternalFallback,
} from '@/lib/feedback-internal'

const LOC = 'loc-palm-beach'
const OTHER_LOC = 'loc-portland'

// An owner report from this location — the shape all 63 production rows have.
const ownerReport = (over: Partial<any> = {}) => ({
  id: 'fb-owner-1',
  user_id: 'owner-1',
  location_id: LOC,
  type: 'bug',
  title: 'Client not moving in system correctly',
  status: 'submitted',
  admin_response: null,
  is_internal: false,
  ...over,
})

// An internally-found bug, TAGGED with that same location. The tag is the
// point: it is how the overlap becomes visible.
const internalItem = (over: Partial<any> = {}) => ({
  id: 'fb-internal-1',
  user_id: 'kevin-superadmin',
  location_id: LOC,
  type: 'bug',
  title: 'Jobber token rotation race — 70 reauth failures',
  status: 'submitted',
  admin_response: null,
  is_internal: true,
  ...over,
})

const req = (url = 'http://x/api/admin/feedback') => ({ nextUrl: new URL(url) }) as any
const listAdmin = async (url?: string) => {
  const res = await ADMIN_GET(req(url))
  return { status: res.status, body: await res.json() }
}
const listMine = async (url = 'http://x/api/feedback') => {
  const res = await MINE_GET(req(url))
  return { status: res.status, body: await res.json() }
}
const patch = async (id: string, body: any) => {
  const res = await PATCH({ json: async () => body } as any, { params: { id } })
  return { status: res.status, body: await res.json() }
}

const asOwner = () => {
  authUser.current = { id: 'owner-1' }
  h.state.tables.hub_users = [
    { id: 'owner-1', role: 'owner', location_id: LOC, email: 'angie@pb.com', full_name: 'Angie' },
  ]
}
const asSuperAdmin = () => {
  authUser.current = { id: 'kevin-superadmin' }
  h.state.tables.hub_users = [
    { id: 'kevin-superadmin', role: 'super_admin', location_id: null, email: 'kevin@bmave.com', full_name: 'Kevin' },
  ]
}

beforeEach(() => {
  h.reset()
  asOwner()
})

const titles = (body: any) => (body.items || []).map((i: any) => i.title)
// Every filter the feedback_items read actually carried — the proof that the
// exclusion is a WHERE clause and not something the browser was trusted to do.
const feedbackFilters = () =>
  h.state.queries.filter(q => q.table === 'feedback_items').flatMap(q => q.filters)

// ═══════════════════════════════════════════════════════════════════
describe('the guard itself (lib/feedback-internal)', () => {
  it('only an explicit true is internal — absent and null are not', () => {
    expect(isInternalItem({ is_internal: true })).toBe(true)
    expect(isInternalItem({ is_internal: false })).toBe(false)
    expect(isInternalItem({ is_internal: null })).toBe(false)
    expect(isInternalItem({})).toBe(false)          // pre-migration row
    expect(isInternalItem(null)).toBe(false)
  })

  it('a missing-column error is recognised ONLY when it names is_internal', () => {
    expect(isMissingInternalColumn({ code: '42703', message: 'column feedback_items.is_internal does not exist' })).toBe(true)
    expect(isMissingInternalColumn({ code: 'PGRST204', message: "Could not find the 'is_internal' column of 'feedback_items' in the schema cache" })).toBe(true)
    // A missing OTHER column must NOT be read as "no is_internal yet" — that
    // would drop a visibility filter on an unrelated fault.
    expect(isMissingInternalColumn({ code: '42703', message: 'column feedback_items.context does not exist' })).toBe(false)
    expect(isMissingInternalColumn({ code: 'PGRST116', message: 'no rows returned' })).toBe(false)
    expect(isMissingInternalColumn(null)).toBe(false)
  })

  it('retries WITHOUT the filter when the column is missing, and reports it', async () => {
    const seen: boolean[] = []
    const r = await withInternalFallback<string[]>(async (filterInternal) => {
      seen.push(filterInternal)
      if (filterInternal) return { data: null, error: { code: '42703', message: 'column feedback_items.is_internal does not exist' } }
      return { data: ['row'], error: null }
    })
    expect(seen).toEqual([true, false])
    expect(r.data).toEqual(['row'])
    expect(r.internalSupported).toBe(false)
  })

  it('a REAL error is surfaced, never retried into an unfiltered read', async () => {
    const attempts: boolean[] = []
    const r = await withInternalFallback<string[]>(async (filterInternal) => {
      attempts.push(filterInternal)
      return { data: null, error: { code: '08006', message: 'connection failure' } }
    })
    expect(attempts).toEqual([true])          // no second, unfiltered pass
    expect(r.error).toMatchObject({ code: '08006' })
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('GET /api/admin/feedback — the owner list', () => {
  it('an owner still sees what their location submitted (unchanged from today)', async () => {
    h.state.tables.feedback_items = [
      ownerReport(),
      ownerReport({ id: 'fb-owner-2', title: 'Missing clients' }),
      ownerReport({ id: 'fb-other', location_id: OTHER_LOC, title: 'Someone elses report' }),
    ]
    const { status, body } = await listAdmin()
    expect(status).toBe(200)
    expect(titles(body).sort()).toEqual(['Client not moving in system correctly', 'Missing clients'])
  })

  it('an owner does NOT see an internal item tagged with their OWN location', async () => {
    h.state.tables.feedback_items = [ownerReport(), internalItem()]
    const { body } = await listAdmin()
    expect(titles(body)).toEqual(['Client not moving in system correctly'])
    expect(JSON.stringify(body)).not.toContain('Jobber token rotation race')
  })

  it('the exclusion is a SERVER-SIDE predicate, not a client filter', async () => {
    h.state.tables.feedback_items = [ownerReport(), internalItem()]
    await listAdmin()
    expect(feedbackFilters()).toContainEqual(['is_internal', false])
    // …and it is applied ALONGSIDE the location scope, not instead of it.
    expect(feedbackFilters()).toContainEqual(['location_id', LOC])
  })

  it('an owner cannot lift the scope with ?location_id= — internal stays hidden', async () => {
    h.state.tables.feedback_items = [ownerReport(), internalItem()]
    const { body } = await listAdmin(`http://x/api/admin/feedback?location_id=${OTHER_LOC}`)
    expect(titles(body)).toEqual(['Client not moving in system correctly'])
  })

  it('elevated roles see EVERYTHING, internal included — unchanged', async () => {
    asSuperAdmin()
    h.state.tables.feedback_items = [ownerReport(), internalItem()]
    const { body } = await listAdmin()
    expect(titles(body).sort()).toEqual([
      'Client not moving in system correctly',
      'Jobber token rotation race — 70 reauth failures',
    ])
    expect(feedbackFilters()).not.toContainEqual(['is_internal', false])
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('the 63 existing rows stay visible', () => {
  it('AFTER the migration: default false means every existing report still lands', async () => {
    // What the ALTER produces for the 63 live rows — is_internal present, false.
    h.state.tables.feedback_items = Array.from({ length: 63 }, (_, i) =>
      ownerReport({ id: `fb-${i}`, title: `report ${i}` }))
    const { body } = await listAdmin()
    expect(body.items).toHaveLength(63)
  })

  it('BEFORE the migration: rows have no is_internal at all and are still returned', async () => {
    h.state.internalColumn = false
    // Pre-migration rows genuinely lack the key.
    h.state.tables.feedback_items = [
      { id: 'fb-1', user_id: 'owner-1', location_id: LOC, type: 'bug', title: 'Email cut off', status: 'submitted', admin_response: null },
    ]
    const { status, body } = await listAdmin()
    expect(status).toBe(200)
    expect(titles(body)).toEqual(['Email cut off'])
  })

  it('the pre-migration retry is safe: with no column, no row can be internal', async () => {
    h.state.internalColumn = false
    h.state.tables.feedback_items = [
      { id: 'fb-1', user_id: 'owner-1', location_id: LOC, type: 'bug', title: 'Guide', status: 'submitted', admin_response: null },
    ]
    await listAdmin()
    // It TRIED to filter first, then fell back — the filter is not simply absent.
    expect(feedbackFilters()).toContainEqual(['is_internal', false])
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('PATCH /api/admin/feedback/[id] — the mutate path', () => {
  it('an owner can still patch a normal item at their own location', async () => {
    h.state.tables.feedback_items = [ownerReport()]
    const { status } = await patch('fb-owner-1', { status: 'under_review' })
    expect(status).toBe(200)
    expect(h.state.updates.find(u => u.table === 'feedback_items')?.arg).toMatchObject({ status: 'under_review' })
  })

  it('an owner PATCHing a known internal id is REFUSED — and nothing is written', async () => {
    h.state.tables.feedback_items = [internalItem()]
    const { status } = await patch('fb-internal-1', { status: 'shipped' })
    expect(status).toBe(404)
    expect(h.state.updates.filter(u => u.table === 'feedback_items')).toHaveLength(0)
  })

  it('404, not 403 — a guessed id cannot even confirm the row exists', async () => {
    h.state.tables.feedback_items = [internalItem()]
    const internal = await patch('fb-internal-1', { status: 'shipped' })
    h.reset(); asOwner()
    h.state.tables.feedback_items = []
    const unknown = await patch('fb-internal-1', { status: 'shipped' })
    // Identical answer for "internal item about your location" and "no such id".
    expect(internal.status).toBe(unknown.status)
    expect(internal.body).toEqual(unknown.body)
  })

  it('the internal test runs BEFORE the location test, so an own-location tag cannot slip through', async () => {
    // This is the ordering bug the guard exists to prevent: location_id matches
    // the caller, so a location-first check would let it past.
    h.state.tables.feedback_items = [internalItem({ location_id: LOC })]
    const { status } = await patch('fb-internal-1', { admin_response: 'I fixed it myself' })
    expect(status).toBe(404)
  })

  it('elevated roles can still patch an internal item', async () => {
    asSuperAdmin()
    h.state.tables.feedback_items = [internalItem()]
    const { status } = await patch('fb-internal-1', { status: 'in_progress' })
    expect(status).toBe(200)
  })

  it('pre-migration, an owner patching their own item still works', async () => {
    h.state.internalColumn = false
    h.state.tables.feedback_items = [
      { id: 'fb-1', user_id: 'owner-1', location_id: LOC, type: 'bug', title: 'Guide', status: 'submitted', admin_response: null },
    ]
    const { status } = await patch('fb-1', { status: 'under_review' })
    expect(status).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('GET /api/feedback — the "mine" tab', () => {
  it('a non-elevated caller never receives an internal row', async () => {
    h.state.tables.feedback_items = [
      ownerReport(),
      internalItem({ user_id: 'owner-1', title: 'reclassified internal' }),
    ]
    const { body } = await listMine()
    expect(titles(body)).toEqual(['Client not moving in system correctly'])
    expect(feedbackFilters()).toContainEqual(['is_internal', false])
  })

  it('an elevated caller reading their own items DOES see internal ones', async () => {
    asSuperAdmin()
    h.state.tables.feedback_items = [internalItem({ user_id: 'kevin-superadmin' })]
    const { body } = await listMine()
    expect(titles(body)).toEqual(['Jobber token rotation race — 70 reauth failures'])
    expect(feedbackFilters()).not.toContainEqual(['is_internal', false])
  })

  it('a non-elevated caller still cannot use ?user_id= to read someone else', async () => {
    h.state.tables.feedback_items = [ownerReport({ user_id: 'someone-else', title: 'not yours' })]
    const { body } = await listMine('http://x/api/feedback?user_id=someone-else')
    expect(body.items).toEqual([])
    expect(feedbackFilters()).toContainEqual(['user_id', 'owner-1'])
  })
})

// ═══════════════════════════════════════════════════════════════════
// A leak in a COUNT is still a leak. The owner screen derives its header count,
// its four tab counts and its subtitle from the GET response asserted above, so
// those are covered by construction. These pin the claim that there is no OTHER
// owner-facing consumer of feedback rows — every remaining one is corp-gated.
describe('no other owner-facing count reads feedback rows', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
  const beehub = read('components/BeeHub.jsx')

  it('the owner screen computes every count from the scoped GET, not a second read', () => {
    const owner = read('components/feedback/OwnerFeedbackScreen.jsx')
    // Its only fetches are the scoped list and two writes — the read-receipt
    // and the submitter's reply into the thread. Neither write reads rows, so
    // the counts still have exactly one source.
    const fetches = owner.match(/fetch\(\s*[`'"][^`'"]+/g) || []
    for (const f of fetches) expect(f).toMatch(/\/api\/admin\/feedback|\/api\/feedback\/seen|\/api\/feedback\/\$\{item\.id\}\/replies/)
    // Counts are derived from `items` — the response — not fetched separately.
    expect(owner).toMatch(/const counts = useMemo\(\(\) => \{/)
    expect(owner).not.toContain('summarizeFeedbackQueues')
  })

  it('the nav badge and its count fetch are corp-only', () => {
    expect(beehub).toContain("const showFeedback = role === 'super_admin' || role === 'corporate' || role === 'admin'")
    // The badge fetch is guarded by that same flag.
    expect(beehub).toMatch(/if \(!showFeedback\) return\s*\n\s*let cancelled = false\s*\n\s*fetchFeedbackOpenCount\(\)/)
    // …and the legacy admin shell gates its Feedback tab the same way.
    expect(beehub).toContain("const showFeedbackTab = role === 'super_admin' || role === 'corporate' || role === 'admin'")
  })

  it('the System Health feedback card is elevated-only on BOTH the client and the route', () => {
    // Client: HomeSystemHealth only mounts on the elevated all-locations branch.
    expect(beehub).toMatch(/if \(isElevated && locFilter==='all'\) return \(/)
    // Server: the route it reads is gated to the corp tier, and it is the gate.
    const health = read('app/api/admin/system-health/route.ts')
    expect(health).toContain("const ELEVATED_ROLES = ['super_admin', 'admin']")
    expect(health).toMatch(/ELEVATED_ROLES\.includes\(/)
  })
})
