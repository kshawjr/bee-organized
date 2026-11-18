// POST /api/network/import and POST /api/network/contacts (slice 5), with the
// database stood in for by tables held in memory. What this pins:
//
//   · super admins only: owners, managers, read-only users and corporate get
//     403 and NOT ONE read is made of the service tables on their behalf
//   · a row that cannot be read is skipped and named, and every other row
//     is saved (Kevin's correction, 2026-11-18)
//   · SAVING stays all or nothing, by count: with an unreadable row in the
//     file too, a refused insert or failed tag links leave partners and
//     partner_tags exactly as many as before
//   · if the tag links fail after the contacts went in, the contacts are
//     deleted again, so the count is back where it started
//   · 'check' writes nothing at all
//   · an imported contact lands in the location named, and no other
//     location's count moves
//   · the add route refuses an email already on a live contact here (409,
//     naming who), either side in any case; addAnyway lets it in; a
//     contact with no email is never a duplicate; another location's is not
//
// The same two routes were also run against a Postgres copy of production
// (all 298 contacts), with production's own checks on the tables:
// ~/Projects/bee-organized-repair-reports/2026-11-17/import-proof/.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state: any = { role: 'super_admin', tables: {} as Record<string, any[]>, serviceCalls: [] as string[], failInsert: null as string | null }
  const svc = (table: string) => {
    const ctx: any = { op: 'select', filters: [] as any[], payload: null, returning: false, range: null as any }
    const b: any = {}
    b.select = (c?: string) => { if (ctx.op !== 'select') ctx.returning = true; return b }
    b.insert = (rows: any) => { ctx.op = 'insert'; ctx.payload = Array.isArray(rows) ? rows : [rows]; return b }
    b.delete = () => { ctx.op = 'delete'; return b }
    b.update = () => { ctx.op = 'update'; return b }
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
      if (ctx.op !== 'select') throw new Error(`unexpected ${ctx.op} on ${table}`)
      let out = rows.filter(match)
      if (ctx.range) out = out.slice(ctx.range[0], ctx.range[1] + 1)
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

import { POST as IMPORT } from '@/app/api/network/import/route'
import { POST as ADD } from '@/app/api/network/contacts/route'

const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const req = (body: any) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) }) as any
const send = async (route: any, body: any) => { const res = await route(req(body)); return { status: res.status, body: await res.json() } }
const counts = () => ({ partners: h.state.tables.partners.length, partner_tags: h.state.tables.partner_tags.length })
const at = (loc: string) => h.state.tables.partners.filter((p: any) => p.location_id === loc).length
const FILE = ['Name,Email,Tags', 'Ann One,ann@x.co,Realtor', 'Ben Two,,Realtor', 'Cat Three,cat@x.co,']

beforeEach(() => {
  h.state.role = 'super_admin'
  h.state.serviceCalls = []
  h.state.failInsert = null
  h.state.tables = {
    locations: [{ id: LOC, name: 'Seattle' }, { id: OTHER, name: 'Greensboro' }],
    lookups: [{ id: 't-realtor', label: 'Realtor', category: 'tags', location_id: null, is_active: true, attrs: { group: 'home_property', shows_on: ['network'] } }],
    partners: [
      { id: 'p1', location_id: LOC, name: 'Tom Here', email: 'tom@x.co', deleted_at: null },
      { id: 'p2', location_id: OTHER, name: 'Ann Elsewhere', email: 'ann@x.co', deleted_at: null },
    ],
    partner_tags: [{ partner_id: 'p1', tag_lookup_id: 't-realtor' }],
  }
})

describe('who may call them', () => {
  for (const role of ['owner', 'manager', 'lite_user', 'admin']) {
    it(`${role}: 403 on import and on add, and not one service read`, async () => {
      h.state.role = role
      expect((await send(IMPORT, { location_id: LOC, csv: FILE.join('\n'), mode: 'check' })).status).toBe(403)
      expect((await send(ADD, { location_id: LOC, name: 'X', types: ['vendor'] })).status).toBe(403)
      expect(h.state.serviceCalls).toEqual([])
    })
  }
})

describe('all or nothing, by count', () => {
  it('a file with one unreadable row imports every other row, and names that row with its reason', async () => {
    const before = counts()
    const r = await send(IMPORT, { location_id: LOC, csv: [FILE[0], FILE[1], 'Dee Four,not-an-email,', FILE[2], FILE[3]].join('\n'), mode: 'import' })
    expect(r.status).toBe(200)
    expect(r.body.added).toBe(3)
    expect(r.body.unreadable).toEqual([{ line: 3, name: 'Dee Four', problems: ['Email looks wrong'] }])
    expect(h.state.tables.partners.filter((p: any) => r.body.ids.includes(p.id)).map((p: any) => p.name)).toEqual(['Ann One', 'Ben Two', 'Cat Three'])
    expect(counts().partners).toBe(before.partners + 3)
    // one insert of the contacts, one of the tag links: saved as one lot
    expect(h.state.serviceCalls.filter((c: string) => !c.startsWith('select'))).toEqual(['insert partners', 'insert partner_tags'])
  })

  it('check names the unreadable row too, and writes nothing', async () => {
    const before = JSON.stringify(h.state.tables)
    const r = await send(IMPORT, { location_id: LOC, csv: [...FILE, 'Dee Four,not-an-email,'].join('\n'), mode: 'check' })
    expect(r.body.unreadable.map((u: any) => u.line)).toEqual([5])
    expect(r.body.adding).toHaveLength(3)
    expect(JSON.stringify(h.state.tables)).toBe(before)
  })

  it('the table refuses the insert (with an unreadable row in the file too): nothing stays, and the answer says nothing was saved', async () => {
    const before = counts()
    const r = await send(IMPORT, { location_id: LOC, csv: [...FILE, 'Dee Four,not-an-email,', 'FAIL IN TABLE,,'].join('\n'), mode: 'import' })
    expect(r.body.reason).toBe('not_saved')
    expect(counts()).toEqual(before)
  })

  it('the tag links fail after the contacts went in (with an unreadable row too): the contacts are deleted again', async () => {
    h.state.failInsert = 'partner_tags'
    const before = counts()
    const r = await send(IMPORT, { location_id: LOC, csv: [...FILE, 'Dee Four,not-an-email,'].join('\n'), mode: 'import' })
    expect(r.body.reason).toBe('not_saved')
    expect(h.state.serviceCalls.filter((c: string) => !c.startsWith('select'))).toEqual(['insert partners', 'insert partner_tags', 'delete partners'])
    expect(counts()).toEqual(before)
  })

  it('check writes nothing', async () => {
    const before = JSON.stringify(h.state.tables)
    const r = await send(IMPORT, { location_id: LOC, csv: FILE.join('\n'), mode: 'check' })
    expect(r.status).toBe(200)
    expect(r.body.adding).toHaveLength(3)
    expect(JSON.stringify(h.state.tables)).toBe(before)
  })
})

describe('the location being viewed, and only that one', () => {
  it('every imported contact lands in the location named; the other location’s count does not move', async () => {
    const other = at(OTHER)
    const here = at(LOC)
    // Ann's email lives at the OTHER location: not a duplicate here.
    const r = await send(IMPORT, { location_id: LOC, csv: FILE.join('\n'), mode: 'import' })
    expect(r.body.added).toBe(3)
    expect(at(LOC)).toBe(here + 3)
    expect(at(OTHER)).toBe(other)
    expect(h.state.tables.partner_tags.filter((t: any) => r.body.ids.includes(t.partner_id))).toHaveLength(2)
  })

  it('an email already on a live contact here is skipped, naming them', async () => {
    const r = await send(IMPORT, { location_id: LOC, csv: [...FILE, 'Tommy,TOM@x.co,'].join('\n'), mode: 'import' })
    expect(r.body.added).toBe(3)
    expect(r.body.skipped).toEqual([{ line: 5, name: 'Tommy', email: 'tom@x.co', matched: { id: 'p1', name: 'Tom Here', line: null } }])
  })

  it('no location, or one that does not exist: nothing is read or written', async () => {
    expect((await send(IMPORT, { csv: FILE.join('\n'), mode: 'import' })).body.reason).toBe('location_required')
    expect((await send(ADD, { name: 'X', types: ['vendor'] })).body.error).toBe('location_required')
    const r = await send(IMPORT, { location_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', csv: FILE.join('\n'), mode: 'import' })
    expect(r.status).toBe(404)
    expect(h.state.serviceCalls.filter((c: string) => !c.startsWith('select'))).toEqual([])
  })

  it('the add route: one contact at the location named, with its tag', async () => {
    const r = await send(ADD, { location_id: LOC, name: 'Added One', types: ['partner'], tagIds: ['t-realtor'] })
    expect(r.status).toBe(201)
    const row = h.state.tables.partners.find((p: any) => p.id === r.body.id)
    expect(row.location_id).toBe(LOC)
    expect(h.state.tables.partner_tags.filter((t: any) => t.partner_id === r.body.id)).toHaveLength(1)
    expect(at(OTHER)).toBe(1)
  })

  it('the add route refuses an email already on a live contact here, naming who, in any case on either side', async () => {
    h.state.tables.partners[0].email = ' Tom@X.co'
    const before = counts()
    const r = await send(ADD, { location_id: LOC, name: 'Tom Twice', types: ['vendor'], email: 'TOM@x.CO ' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: 'email_already_here', field: 'email', matched: { id: 'p1', name: 'Tom Here' } })
    expect(counts()).toEqual(before)
    expect(h.state.serviceCalls.filter((c: string) => !c.startsWith('select'))).toEqual([])
  })

  it('add anyway, ticked on purpose: it goes in', async () => {
    const r = await send(ADD, { location_id: LOC, name: 'Tom Twice', types: ['vendor'], email: 'tom@x.co', addAnyway: true })
    expect(r.status).toBe(201)
    expect(h.state.tables.partners.filter((p: any) => p.location_id === LOC && p.email === 'tom@x.co')).toHaveLength(2)
  })

  it('another location holding the email, or no email at all: not a duplicate', async () => {
    expect((await send(ADD, { location_id: LOC, name: 'Ann Here', types: ['vendor'], email: 'ann@x.co' })).status).toBe(201)
    h.state.tables.partners.push({ id: 'p3', location_id: LOC, name: 'No Mail', email: null, deleted_at: null })
    expect((await send(ADD, { location_id: LOC, name: 'Also No Mail', types: ['vendor'] })).status).toBe(201)
    expect((await send(ADD, { location_id: LOC, name: 'Blank Mail', types: ['vendor'], email: '   ' })).status).toBe(201)
  })

  it('a contact in the recycle bin is not a duplicate', async () => {
    h.state.tables.partners[0].deleted_at = '2026-11-01T00:00:00Z'
    expect((await send(ADD, { location_id: LOC, name: 'Tom Back', types: ['vendor'], email: 'tom@x.co' })).status).toBe(201)
  })
})
