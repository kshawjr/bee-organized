// @vitest-environment node
//
// issue 247 step 2 — THE WRITER.
//
// Steps 1 and 2 part 1 built the is_internal column, the owner-side exclusion
// and the widened type domain. Nothing could write an internal row: filing one
// meant hand-run SQL. This is that path, plus the read sites that degraded
// silently once the new values could actually exist.
//
// What these pin:
//   1. POST /api/admin/feedback files an internal item, of any of the four
//      types, and is_internal is a property of the ROUTE — never of the body
//   2. the owner filing path is untouched and still refuses the new types
//   3. ?type= and ?status= REJECT an unknown value instead of silently
//      returning the unfiltered list (the worst of the ten read sites: a wrong
//      result set dressed as a 200)
//   4. no owner-facing read ever yields a decision or a hazard
//   5. an internal item notifies nobody — including the issue 236 "it's fixed"
//      announcement, which rule 4 does not cover
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, any[]>,
    inserts: [] as { table: string; row: any }[],
    updates: [] as { table: string; arg: any }[],
    queries: [] as { table: string; filters: [string, any][] }[],
    insertError: null as any,
  }
  const reset = () => {
    state.tables = {}; state.inserts = []; state.updates = []
    state.queries = []; state.insertError = null
  }

  const makeBuilder = (table: string) => {
    const filters: [string, any][] = []
    const b: any = {}
    b.select = () => b
    b.eq = (col: string, val: any) => { filters.push([col, val]); return b }
    for (const m of ['order', 'limit', 'in', 'is', 'not']) b[m] = () => b
    b.insert = (row: any) => { state.inserts.push({ table, row }); b.__insert = row; return b }
    b.update = (arg: any) => { state.updates.push({ table, arg }); b.__update = arg; return b }

    const resolve = () => {
      state.queries.push({ table, filters: filters.slice() })
      if (b.__insert) {
        if (state.insertError) return { data: null, error: state.insertError }
        return { data: [{ id: 'new-1', ...b.__insert }], error: null }
      }
      let rows = (state.tables[table] || []).slice()
      for (const [col, val] of filters) rows = rows.filter(r => r[col] === val)
      if (b.__update) rows = rows.map(r => ({ ...r, ...b.__update }))
      return { data: rows, error: null }
    }
    b.single = () => {
      const r = resolve()
      if (r.error) return Promise.resolve(r)
      const rows = r.data as any[]
      if (!rows.length) return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
      return Promise.resolve({ data: rows[0], error: null })
    }
    b.maybeSingle = b.single
    b.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej)
    return b
  }
  return { state, reset, makeBuilder }
})

const authUser = vi.hoisted(() => ({ current: { id: 'kevin' } as any }))
const direct = vi.hoisted(() => ({ fn: vi.fn(async () => ({ success: true, id: 'm1' })) }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/resend', () => ({ sendEmailDirect: direct.fn }))

import { GET as ADMIN_GET, POST as ADMIN_POST } from '@/app/api/admin/feedback/route'
import { PATCH } from '@/app/api/admin/feedback/[id]/route'
import { POST as OWNER_POST } from '@/app/api/feedback/route'

const LOC = 'loc-palm-beach'

const req = (url: string, body?: any) => ({
  nextUrl: new URL(url),
  json: async () => body,
}) as any

const adminPost = async (body: any) => {
  const res = await ADMIN_POST(req('http://x/api/admin/feedback', body))
  return { status: res.status, body: await res.json() }
}
const adminGet = async (url = 'http://x/api/admin/feedback') => {
  const res = await ADMIN_GET(req(url))
  return { status: res.status, body: await res.json() }
}
const ownerPost = async (body: any) => {
  const res = await OWNER_POST(req('http://x/api/feedback', body))
  return { status: res.status, body: await res.json() }
}
const patch = async (id: string, body: any) => {
  const res = await PATCH(req('http://x', body), { params: { id } })
  return { status: res.status, body: await res.json() }
}

const asSuperAdmin = () => {
  authUser.current = { id: 'kevin' }
  h.state.tables.hub_users = [{ id: 'kevin', role: 'super_admin', location_id: null, email: 'kevin@bmave.com' }]
}
const asOwner = () => {
  authUser.current = { id: 'angie' }
  h.state.tables.hub_users = [{ id: 'angie', role: 'owner', location_id: LOC, email: 'angie@pb.com' }]
}

const filedRow = () => h.state.inserts.find(i => i.table === 'feedback_items')?.row
const titles = (body: any) => (body.items || []).map((i: any) => i.title)
const feedbackFilters = () =>
  h.state.queries.filter(q => q.table === 'feedback_items').flatMap(q => q.filters)

beforeEach(() => {
  h.reset()
  direct.fn.mockClear()
  direct.fn.mockImplementation(async () => ({ success: true, id: 'm1' }))
  asSuperAdmin()
})

// ═══════════════════════════════════════════════════════════════════
describe('POST /api/admin/feedback — filing an internal item', () => {
  for (const type of ['bug', 'feature', 'decision', 'hazard']) {
    it(`files an internal '${type}'`, async () => {
      const { status } = await adminPost({ type, title: `a ${type}`, description: 'what happened' })
      expect(status).toBe(201)
      expect(filedRow()).toMatchObject({ type, is_internal: true, user_id: 'kevin', status: 'submitted' })
    })
  }

  it('is_internal comes from the ROUTE, not the body — a false in the body is ignored', async () => {
    // The failure this prevents: an owner-visible row carrying a type the owner
    // UI cannot render. The database would refuse a decision, but a bug filed
    // this way would land in an owner's list.
    const { status } = await adminPost({
      type: 'hazard', title: 'h', description: 'd', is_internal: false,
    } as any)
    expect(status).toBe(201)
    expect(filedRow().is_internal).toBe(true)
  })

  it('carries an optional location TAG, and files fine without one', async () => {
    await adminPost({ type: 'bug', title: 'Palm Beach import is stuck', description: 'd', location_id: LOC })
    expect(filedRow()).toMatchObject({ location_id: LOC, is_internal: true })

    h.reset(); asSuperAdmin()
    await adminPost({ type: 'bug', title: 'platform-wide', description: 'd' })
    expect(filedRow().location_id).toBeNull()
  })

  it('rejects a type outside the four', async () => {
    const { status, body } = await adminPost({ type: 'chore', title: 't', description: 'd' })
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_type')
    expect(h.state.inserts).toHaveLength(0)
  })

  it('rejects an empty title or description', async () => {
    expect((await adminPost({ type: 'bug', title: '', description: 'd' })).status).toBe(400)
    expect((await adminPost({ type: 'bug', title: 't', description: '' })).status).toBe(400)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('reports an unknown location as a 400 naming the field, not a 500', async () => {
    h.state.insertError = { code: '23503', message: 'violates foreign key constraint' }
    const { status, body } = await adminPost({ type: 'bug', title: 't', description: 'd', location_id: 'nope' })
    expect(status).toBe(400)
    expect(body.error).toBe('unknown_location')
  })

  it('is FORBIDDEN to an owner — internal filing is corp-only', async () => {
    asOwner()
    const { status } = await adminPost({ type: 'hazard', title: 't', description: 'd' })
    expect(status).toBe(403)
    expect(h.state.inserts).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('the owner filing path is untouched', () => {
  it('an owner still cannot file a decision or a hazard', async () => {
    asOwner()
    for (const type of ['decision', 'hazard']) {
      h.state.inserts = []
      const { status, body } = await ownerPost({ type, title: 't', description: 'd' })
      expect(status).toBe(400)
      // The error name widened when 'question' became owner-fileable; the pin
      // that matters — decision/hazard refused at the owner door — is intact.
      expect(body.error).toBe('type_must_be_bug_feature_or_question')
      expect(h.state.inserts).toHaveLength(0)
    }
  })

  it('an owner CAN still file a bug, and it is not internal', async () => {
    asOwner()
    const { status } = await ownerPost({ type: 'bug', title: 'my bug', description: 'd' })
    expect(status).toBe(201)
    const row = filedRow()
    expect(row.type).toBe('bug')
    // The owner path never sets is_internal — the column default (false) applies.
    expect(row.is_internal).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('?type= and ?status= no longer silently unfilter', () => {
  const MIXED = [
    { id: '1', type: 'bug', title: 'a bug', status: 'submitted', location_id: LOC, is_internal: false, user_id: 'angie' },
    { id: '2', type: 'feature', title: 'an idea', status: 'submitted', location_id: LOC, is_internal: false, user_id: 'angie' },
    { id: '3', type: 'decision', title: 'a decision', status: 'submitted', location_id: LOC, is_internal: true, user_id: 'kevin' },
    { id: '4', type: 'hazard', title: 'a hazard', status: 'submitted', location_id: LOC, is_internal: true, user_id: 'kevin' },
  ]

  for (const [type, expected] of [
    ['bug', 'a bug'], ['feature', 'an idea'], ['decision', 'a decision'], ['hazard', 'a hazard'],
  ] as const) {
    it(`?type=${type} returns exactly that set`, async () => {
      h.state.tables.feedback_items = MIXED
      const { status, body } = await adminGet(`http://x/api/admin/feedback?type=${type}`)
      expect(status).toBe(200)
      expect(titles(body)).toEqual([expected])
    })
  }

  it('an UNKNOWN type is a 400 — not the unfiltered list', async () => {
    h.state.tables.feedback_items = MIXED
    const { status, body } = await adminGet('http://x/api/admin/feedback?type=chore')
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_type')
    // The regression this guards: it used to answer 200 with ALL FOUR rows,
    // which reads as "here are your chores".
    expect(body.items).toBeUndefined()
  })

  it('an UNKNOWN status is a 400 too — the same bug one line up', async () => {
    h.state.tables.feedback_items = MIXED
    const { status, body } = await adminGet('http://x/api/admin/feedback?status=wibble')
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_status')
  })

  it('an EMPTY param still means "no filter", as it always did', async () => {
    h.state.tables.feedback_items = MIXED
    const { status, body } = await adminGet('http://x/api/admin/feedback?type=')
    expect(status).toBe(200)
    expect(body.items).toHaveLength(4)
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('no owner-facing read ever yields the internal-only types', () => {
  it('an owner list excludes a decision and a hazard tagged with their OWN location', async () => {
    asOwner()
    h.state.tables.feedback_items = [
      { id: '1', type: 'bug', title: 'my bug', status: 'submitted', location_id: LOC, is_internal: false, user_id: 'angie' },
      { id: '2', type: 'decision', title: 'a decision about Palm Beach', status: 'submitted', location_id: LOC, is_internal: true, user_id: 'kevin' },
      { id: '3', type: 'hazard', title: 'a hazard about Palm Beach', status: 'submitted', location_id: LOC, is_internal: true, user_id: 'kevin' },
    ]
    const { body } = await adminGet()
    expect(titles(body)).toEqual(['my bug'])
    expect(JSON.stringify(body)).not.toContain('decision')
    expect(JSON.stringify(body)).not.toContain('hazard')
    expect(feedbackFilters()).toContainEqual(['is_internal', false])
  })

  it('an owner filtering ?type=hazard is refused before any row is read', async () => {
    asOwner()
    h.state.tables.feedback_items = []
    // hazard IS a valid filter value now, so this one is allowed through — and
    // still returns nothing, because the is_internal predicate rides with it.
    const { status, body } = await adminGet('http://x/api/admin/feedback?type=hazard')
    expect(status).toBe(200)
    expect(body.items).toEqual([])
    expect(feedbackFilters()).toContainEqual(['is_internal', false])
  })
})

// ═══════════════════════════════════════════════════════════════════
// Rule 6. Rule 4 only suppresses when the replier IS the submitter, so both of
// these are cases rule 4 lets straight through.
describe('an internal item notifies nobody', () => {
  it('a colleague marking Kevin\'s internal item Fixed sends no announcement', async () => {
    authUser.current = { id: 'sydney' }
    h.state.tables.hub_users = [{ id: 'sydney', role: 'admin', location_id: null, email: 's@bmave.com' }]
    h.state.tables.feedback_items = [{
      id: 'i1', user_id: 'kevin', location_id: null, type: 'bug',
      title: 'Jobber token rotation race', status: 'in_progress',
      admin_response: null, is_internal: true,
    }]
    const { status, body } = await patch('i1', { status: 'shipped' })
    expect(status).toBe(200)
    expect(direct.fn).not.toHaveBeenCalled()
    expect(body.reply_email).toMatchObject({ sent: false, skipped: 'internal_item' })
  })

  it('an owner report FLIPPED internal does not mail the owner about a hidden item', async () => {
    // The worse case: the submitter is still the owner, so the announcement
    // would mail THEM — about an item now excluded from every owner-facing
    // read. They would follow the link and find nothing.
    authUser.current = { id: 'sydney' }
    h.state.tables.hub_users = [{ id: 'sydney', role: 'admin', location_id: null, email: 's@bmave.com' }]
    h.state.tables.feedback_items = [{
      id: 'f1', user_id: 'angie', location_id: LOC, type: 'bug',
      title: 'Client not moving', status: 'planned',
      admin_response: null, is_internal: true,
    }]
    const { body } = await patch('f1', { status: 'shipped', admin_response: 'Fixed it.' })
    expect(direct.fn).not.toHaveBeenCalled()
    expect(body.reply_email).toMatchObject({ sent: false, skipped: 'internal_item' })
  })

  it('a NON-internal item still emails, exactly as issue 233/236 built it', async () => {
    authUser.current = { id: 'sydney' }
    // The submitter needs a real address here — this is the case that MUST
    // still send, so the send has to actually reach sendEmailDirect.
    h.state.tables.hub_users = [
      { id: 'sydney', role: 'admin', location_id: null, email: 's@bmave.com' },
      { id: 'angie', role: 'owner', location_id: LOC, email: 'angie@pb.com', full_name: 'Angie' },
    ]
    h.state.tables.feedback_items = [{
      id: 'f2', user_id: 'angie', location_id: LOC, type: 'bug',
      title: 'Client not moving', status: 'planned',
      admin_response: null, is_internal: false,
    }]
    const { body } = await patch('f2', { admin_response: 'Good catch — fixing it.' })
    expect(body.reply_email).toMatchObject({ sent: true })
    expect(direct.fn).toHaveBeenCalledTimes(1)
  })
})
