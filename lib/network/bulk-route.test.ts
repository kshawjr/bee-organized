// POST /api/network/contacts/bulk (slice 6), with the database stood in for
// by tables held in memory that hand back only the columns asked for. What
// this pins:
//   · super admins only: owners, managers, read-only users and corporate get
//     403 and not one read is made on their behalf
//   · NO YES, NO CHANGE: without confirmed: true the answer is 428, nothing is
//     read from partners and every table is byte-identical afterwards
//   · twenty contacts are changed by ONE statement, and only those that really
//     change; updated_at moves on those rows only
//   · a level or stage goes on Referral partners only; others are skipped and
//     named; a contact at another location stops the whole action
//   · tags: one insert to add, one delete to take off, a Network tag of this
//     location only
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state: any = { role: 'super_admin', tables: {} as Record<string, any[]>, serviceCalls: [] as string[], failInsert: null as string | null, noMappingColumn: false }
  const svc = (table: string) => {
    const ctx: any = { op: 'select', filters: [] as any[], payload: null, returning: false, range: null as any }
    const b: any = {}
    // A read hands back only the columns it asked for, as the database does,
    // so a read that forgets a column (the phone, for the duplicate check)
    // is caught here.
    b.select = (c?: string) => { if (ctx.op !== 'select') ctx.returning = true; else ctx.cols = c; return b }
    b.insert = (rows: any) => { ctx.op = 'insert'; ctx.payload = Array.isArray(rows) ? rows : [rows]; return b }
    b.delete = () => { ctx.op = 'delete'; return b }
    b.update = (v: any) => { ctx.op = 'update'; ctx.payload = v; return b }
    b.upsert = () => { ctx.op = 'upsert'; return b }
    b.eq = (c: string, v: any) => { ctx.filters.push(['eq', c, v]); return b }
    b.is = (c: string, v: any) => { ctx.filters.push(['is', c, v]); return b }
    b.in = (c: string, v: any[]) => { ctx.filters.push(['in', c, v]); return b }
    b.or = (expr: string) => { ctx.filters.push(['or', expr]); return b }
    b.order = () => b
    b.range = (a: number, z: number) => { ctx.range = [a, z]; return b }
    const match = (r: any) => ctx.filters.every((f: any) => {
      if (f[0] === 'eq') return r[f[1]] === f[2]
      if (f[0] === 'is') return r[f[1]] == null
      if (f[0] === 'in') return f[2].includes(r[f[1]])
      if (f[0] === 'or') { const loc = f[1].split('location_id.eq.')[1]; return r.location_id == null || r.location_id === loc }
      return true
    })
    const run = async (single: boolean) => {
      state.serviceCalls.push(`${ctx.op} ${table}`)
      const rows = (state.tables[table] ||= [])
      if (ctx.op === 'insert') {
        // One statement: all rows or none.
        if (state.failInsert === table || ctx.payload.some((r: any) => r.name === 'FAIL IN TABLE')) return { data: null, error: { message: `${table} refused the insert` } }
        rows.push(...ctx.payload.map((r: any) => ({ deleted_at: null, ...r })))
        return { data: ctx.returning ? ctx.payload.map((r: any) => ({ id: r.id })) : null, error: null }
      }
      if (ctx.op === 'delete') {
        const keep = rows.filter((r: any) => !match(r))
        const gone = new Set(rows.filter(match).map((r: any) => r.id))
        state.tables[table] = keep
        // partner_tags cascades from partners
        if (table === 'partners') state.tables.partner_tags = (state.tables.partner_tags || []).filter((t: any) => !gone.has(t.partner_id))
        return { data: null, error: null }
      }
      // Before the migration runs, locations has no network_import_mappings.
      const wantsMappings = String(ctx.cols || '').includes('network_import_mappings') || (ctx.op === 'update' && 'network_import_mappings' in (ctx.payload || {}))
      if (table === 'locations' && wantsMappings && state.noMappingColumn) return { data: null, error: { message: 'column locations.network_import_mappings does not exist' } }
      if (ctx.op === 'update') { for (const r of rows.filter(match)) Object.assign(r, ctx.payload); return { data: null, error: null } }
      if (ctx.op !== 'select') throw new Error(`unexpected ${ctx.op} on ${table}`)
      let out = rows.filter(match)
      if (ctx.range) out = out.slice(ctx.range[0], ctx.range[1] + 1)
      if (typeof ctx.cols === 'string' && /^[\w\s,]+$/.test(ctx.cols)) {
        const cols = ctx.cols.split(',').map((x: string) => x.trim())
        out = out.map((r: any) => Object.fromEntries(cols.map((k: string) => [k, r[k]])))
      }
      return { data: single ? out[0] ?? null : out, error: null }
    }
    b.single = () => run(true)
    b.maybeSingle = () => run(true)
    b.then = (res: any, rej: any) => run(false).then(res, rej)
    return b
  }
  return { state, svc }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.svc(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-000000000001' } } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: '00000000-0000-4000-8000-000000000001', role: h.state.role, location_id: null }, error: null }) }) }) }),
  }),
}))


import { POST as BULK } from '@/app/api/network/contacts/bulk/route'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TAG = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const req = (body: any) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) }) as any
const send = async (body: any) => { const res = await BULK(req(body)); return { status: res.status, body: await res.json() } }
const snapshot = () => JSON.stringify(h.state.tables)
const writes = () => h.state.serviceCalls.filter((c: string) => !c.startsWith('select'))
const OLD = '2026-09-01T00:00:00Z'

beforeEach(() => {
  h.state.role = 'super_admin'
  h.state.serviceCalls = []
  h.state.failInsert = null
  h.state.tables = {
    locations: [{ id: LOC, name: 'Seattle' }, { id: OTHER, name: 'Greensboro' }],
    lookups: [{ id: TAG, label: 'Realtor', category: 'tags', location_id: null, is_active: true, attrs: { group: 'home_property', shows_on: ['network'] } }],
    partners: [
      ...Array.from({ length: 20 }, (_, i) => ({ id: id(i + 1), location_id: LOC, name: `Partner ${i + 1}`, deleted_at: null, network_types: ['partner'], partner_level: 'referral', partner_stage: 'New Contact', updated_at: OLD })),
      { id: id(21), location_id: LOC, name: 'Vera Vendor', deleted_at: null, network_types: ['vendor'], partner_level: null, partner_stage: null, updated_at: OLD },
      { id: id(22), location_id: OTHER, name: 'Elsewhere', deleted_at: null, network_types: ['partner'], partner_level: 'referral', partner_stage: 'New Contact', updated_at: OLD },
    ],
    partner_tags: [{ partner_id: id(1), tag_lookup_id: TAG }],
  }
})
const TWENTY = Array.from({ length: 20 }, (_, i) => id(i + 1))

describe('no yes, no change', () => {
  for (const confirmed of [undefined, false, 'true']) {
    it(`confirmed: ${JSON.stringify(confirmed)} → 428, partners never read, every table byte-identical`, async () => {
      const before = snapshot()
      for (const action of ['stage', 'level', 'tag_add', 'tag_remove']) {
        const value = action === 'stage' ? 'Active Partner' : action === 'level' ? 'power' : TAG
        const r = await send({ location_id: LOC, ids: TWENTY, action, value, ...(confirmed === undefined ? {} : { confirmed }) })
        expect(r.status).toBe(428)
        expect(r.body).toMatchObject({ error: 'needs_confirmation', changed: 0 })
      }
      expect(h.state.serviceCalls).toEqual([])
      expect(snapshot()).toBe(before)
    })
  }
})

describe('twenty at once', () => {
  it('a stage for twenty: ONE update statement, twenty rows, updated_at on those rows only', async () => {
    const r = await send({ location_id: LOC, ids: TWENTY, action: 'stage', value: 'Reaching Out', confirmed: true })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, changed: 20, unchanged: 0, skipped: [] })
    expect(writes()).toEqual(['update partners'])
    const rows = h.state.tables.partners
    expect(rows.filter((p: any) => p.partner_stage === 'Reaching Out').map((p: any) => p.id)).toEqual(TWENTY)
    expect(rows.filter((p: any) => p.updated_at !== OLD).map((p: any) => p.id)).toEqual(TWENTY)
    expect(rows.find((p: any) => p.id === id(22)).partner_stage).toBe('New Contact')
  })
  it('only the rows that change are written, and only the one column (plus updated_at)', async () => {
    h.state.tables.partners[0].partner_level = 'power'
    const before = JSON.parse(JSON.stringify(h.state.tables.partners))
    const r = await send({ location_id: LOC, ids: TWENTY, action: 'level', value: 'power', confirmed: true })
    expect(r.body).toMatchObject({ changed: 19, unchanged: 1 })
    expect(r.body.changedIds).not.toContain(id(1))
    ;(h.state.tables.partners as any[]).forEach((p: any, i: number) => {
      const moved = Object.keys(p).filter((k) => JSON.stringify(p[k]) !== JSON.stringify(before[i][k]))
      expect(moved, p.name).toEqual(r.body.changedIds.includes(p.id) ? ['partner_level', 'updated_at'] : [])
    })
  })
  it('a Vendor in the selection is skipped and named, never given a level or stage', async () => {
    const r = await send({ location_id: LOC, ids: [...TWENTY, id(21)], action: 'stage', value: 'Active Partner', confirmed: true })
    expect(r.body).toMatchObject({ changed: 20, skipped: [{ id: id(21), name: 'Vera Vendor', reason: 'not_a_referral_partner' }] })
    expect(h.state.tables.partners.find((p: any) => p.id === id(21))).toMatchObject({ partner_level: null, partner_stage: null, updated_at: OLD })
  })
  it('one contact from another location: refused, nothing written', async () => {
    const before = snapshot()
    const r = await send({ location_id: LOC, ids: [...TWENTY, id(22)], action: 'stage', value: 'Active Partner', confirmed: true })
    expect(r.status).toBe(422)
    expect(writes()).toEqual([])
    expect(snapshot()).toBe(before)
  })
})

describe('tags', () => {
  it('add to twenty: one insert, for the nineteen who lack it', async () => {
    const r = await send({ location_id: LOC, ids: TWENTY, action: 'tag_add', value: TAG, confirmed: true })
    expect(r.body).toMatchObject({ changed: 19, unchanged: 1 })
    expect(writes()).toEqual(['insert partner_tags'])
    expect(h.state.tables.partner_tags).toHaveLength(20)
  })
  it('take off: one delete, only that tag, only those contacts', async () => {
    h.state.tables.partner_tags.push({ partner_id: id(2), tag_lookup_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })
    const r = await send({ location_id: LOC, ids: TWENTY, action: 'tag_remove', value: TAG, confirmed: true })
    expect(r.body).toMatchObject({ changed: 1, unchanged: 19 })
    expect(writes()).toEqual(['delete partner_tags'])
    expect(h.state.tables.partner_tags).toEqual([{ partner_id: id(2), tag_lookup_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }])
  })
})

describe('who may call it', () => {
  for (const role of ['owner', 'manager', 'lite_user', 'admin']) {
    it(`${role}: 403, nothing read, nothing written`, async () => {
      h.state.role = role
      const before = snapshot()
      const r = await send({ location_id: LOC, ids: TWENTY, action: 'stage', value: 'Reaching Out', confirmed: true })
      expect(r.status).toBe(403)
      expect(h.state.serviceCalls).toEqual([])
      expect(snapshot()).toBe(before)
    })
  }
})
