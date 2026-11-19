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

import { POST as IMPORT, GET as MAPPINGS } from '@/app/api/network/import/route'
import { cleanMappingToSave, recallMapping, headerSignature } from '@/lib/network/import-mapping'
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
  h.state.noMappingColumn = false
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
    expect(r.body.skipped).toEqual([{ line: 5, name: 'Tommy', email: 'tom@x.co', phone: null, rule: 'email', matched: { id: 'p1', name: 'Tom Here', line: null } }])
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

  it('a whole file imported twice: the second run adds nobody, the no-email rows included', async () => {
    const csv = ['Name,Email,Phone,Tags', 'Ann One,ann@x.co,,Realtor', 'Ben Two,,,Realtor', 'Pia Phone,,206.555.0100,', 'Cat Three,cat@x.co,(303) 555-0142,'].join('\n')
    const first = await send(IMPORT, { location_id: LOC, csv, mode: 'import' })
    expect(first.body.added).toBe(4)
    const before = counts()
    const again = await send(IMPORT, { location_id: LOC, csv, mode: 'import' })
    expect(again.body.added).toBe(0)
    expect(again.body.skipped.map((s: any) => [s.line, s.name, s.rule])).toEqual([[2, 'Ann One', 'email'], [3, 'Ben Two', 'name_only'], [4, 'Pia Phone', 'name_phone'], [5, 'Cat Three', 'email']])
    expect(counts()).toEqual(before)
  })

  it('the add route, no email: the same name and phone, or the same name and no phone either side, is a 409 naming who', async () => {
    h.state.tables.partners.push({ id: 'p4', location_id: LOC, name: 'Pat Phone', email: null, phone: '(303) 555-0142', deleted_at: null })
    h.state.tables.partners.push({ id: 'p5', location_id: LOC, name: 'Bo Bare', email: null, phone: null, deleted_at: null })
    const before = counts()
    const a = await send(ADD, { location_id: LOC, name: 'PAT  phone', types: ['vendor'], phone: '3035550142' })
    expect([a.status, a.body.error, a.body.matched]).toEqual([409, 'name_and_phone_already_here', { id: 'p4', name: 'Pat Phone' }])
    const b = await send(ADD, { location_id: LOC, name: 'bo bare', types: ['vendor'] })
    expect([b.status, b.body.error, b.body.matched]).toEqual([409, 'name_already_here', { id: 'p5', name: 'Bo Bare' }])
    expect(counts()).toEqual(before)
    // a stored phone and none typed: not a match; add anyway: in
    expect((await send(ADD, { location_id: LOC, name: 'Pat Phone', types: ['vendor'] })).status).toBe(201)
    expect((await send(ADD, { location_id: LOC, name: 'Bo Bare', types: ['vendor'], addAnyway: true })).status).toBe(201)
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

describe('names and remembered mappings (third follow-up, 2026-11-19)', () => {
  const getMappings = async (loc = LOC) => { const res = await MAPPINGS({ nextUrl: new URL(`http://x/api/network/import?location_id=${loc}`) } as any); return { status: res.status, body: await res.json() } }
  const MAP = { headers: ['Contact', 'Mail'], fields: ['name', 'email'] }
  const CSV = 'Name,Email\nMary Van Der Berg,mary@x.co\nNorthside Chamber,hi@north.org'

  it('first and last name are written with the full name', async () => {
    const r = await send(IMPORT, { location_id: LOC, csv: 'First name,Last name,Email\nMary Anne,Smith,ma@x.co', mode: 'import' })
    expect(r.status).toBe(200)
    expect(h.state.tables.partners.at(-1)).toMatchObject({ name: 'Mary Anne Smith', first_name: 'Mary Anne', last_name: 'Smith', location_id: LOC })
    expect(r.body.adding[0]).toMatchObject({ first_name: 'Mary Anne', last_name: 'Smith' })
  })

  it('an import stores the owner’s mapping on that location, and only that one', async () => {
    const r = await send(IMPORT, { location_id: LOC, csv: CSV, mode: 'import', mapping: MAP })
    expect(r.body).toMatchObject({ ok: true, added: 2, mappingSaved: true })
    const loc = h.state.tables.locations.find((l: any) => l.id === LOC)
    expect(recallMapping(loc.network_import_mappings, ['Mail', 'Contact'])).toEqual(['email', 'name'])
    expect(h.state.tables.locations.find((l: any) => l.id === OTHER).network_import_mappings).toBeUndefined()
    // ...and the screen reads it back
    const g = await getMappings()
    expect(g.status).toBe(200)
    expect(Object.keys(g.body.mappings)).toEqual([headerSignature(MAP.headers)])
  })

  it('a check never stores a mapping', async () => {
    await send(IMPORT, { location_id: LOC, csv: CSV, mode: 'check', mapping: MAP })
    expect(h.state.serviceCalls.filter((c: string) => c.startsWith('update'))).toEqual([])
    expect(h.state.tables.locations.find((l: any) => l.id === LOC).network_import_mappings).toBeUndefined()
  })

  it('a bad mapping is not stored, and the import still goes in', async () => {
    const r = await send(IMPORT, { location_id: LOC, csv: CSV, mode: 'import', mapping: { headers: ['A', 'B'], fields: ['name', 'name'] } })
    expect(r.body).toMatchObject({ ok: true, added: 2, mappingSaved: false })
    expect(h.state.serviceCalls.filter((c: string) => c.startsWith('update'))).toEqual([])
  })

  it('before the migration runs: no remembered mappings, and the import still goes in', async () => {
    h.state.noMappingColumn = true
    const g = await getMappings()
    expect(g.body).toEqual({ ok: true, remembered: false, mappings: {} })
    const r = await send(IMPORT, { location_id: LOC, csv: CSV, mode: 'import', mapping: MAP })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, added: 2, mappingSaved: false })
  })

  it('only super admins may read the mappings', async () => {
    for (const role of ['owner', 'manager', 'lite_user', 'admin']) {
      h.state.role = role
      h.state.serviceCalls = []
      expect((await getMappings()).status).toBe(403)
      expect(h.state.serviceCalls).toEqual([])
    }
  })

  it('what is stored holds headings and field names only, never a contact', async () => {
    await send(IMPORT, { location_id: LOC, csv: CSV, mode: 'import', mapping: MAP })
    const stored = JSON.stringify(h.state.tables.locations.find((l: any) => l.id === LOC).network_import_mappings)
    expect(stored).not.toMatch(/mary|north|@/i)
    expect(cleanMappingToSave(MAP)!.mapping.headers).toEqual(['Contact', 'Mail'])
  })
})
