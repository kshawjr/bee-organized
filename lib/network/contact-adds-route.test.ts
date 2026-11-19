// PATCH /api/network/contacts/[id], slice 4b: a note, the addresses and the
// company link, against a stand-in for the database that records every call.
//
// Pinned here:
//   · each add sends the database ITS ONE COLUMN and updated_at, nothing else
//   · an add that changes nothing sends no update at all
//   · a refused add sends no update at all
//   · super admins only, as before
//   · the tag list on the sheet hides a switched-off tag, and keeps its link
//
// The same route was also run against a Postgres copy holding production's
// contacts, comparing every column of every row and every other table before
// and after: ~/Projects/bee-organized-repair-reports/2026-11-15/contact-adds-proof/.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state: any = { sessionUser: null, hubUser: null, tables: {} as Record<string, any[]>, calls: [] as any[] }
  const makeBuilder = (table: string, client: 'session' | 'service') => {
    const ctx: any = { table, client, op: 'select', cols: '', filters: [] as any[], payload: null as any }
    const b: any = {}
    b.select = (cols?: any) => { if (ctx.op === 'select') ctx.cols = cols || ''; return b }
    for (const op of ['insert', 'update', 'upsert', 'delete']) b[op] = (payload?: any) => { ctx.op = op; ctx.payload = payload ?? null; return b }
    b.eq = (col: string, val: any) => { ctx.filters.push(['eq', col, val]); return b }
    b.is = (col: string, val: any) => { ctx.filters.push(['is', col, val]); return b }
    b.in = (col: string, vals: any[]) => { ctx.filters.push(['in', col, vals]); return b }
    b.order = () => b
    const resolve = (single: boolean) => {
      state.calls.push(ctx)
      if (client === 'session' && table === 'hub_users') return Promise.resolve({ data: state.hubUser, error: null })
      let rows = (state.tables[table] || [])
      for (const fl of ctx.filters) {
        if (fl[0] === 'eq') rows = rows.filter((r: any) => r[fl[1]] === fl[2])
        if (fl[0] === 'is' && fl[2] === null) rows = rows.filter((r: any) => r[fl[1]] == null)
        if (fl[0] === 'in') rows = rows.filter((r: any) => fl[2].includes(r[fl[1]]))
      }
      if (ctx.op === 'update') { for (const r of rows) Object.assign(r, ctx.payload); return Promise.resolve({ data: null, error: null }) }
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows.slice(), error: null })
    }
    b.single = () => resolve(true)
    b.maybeSingle = () => resolve(true)
    b.then = (res: any, rej: any) => resolve(false).then(res, rej)
    return b
  }
  return { state, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t, 'service') } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.state.sessionUser } }) },
    from: (t: string) => h.makeBuilder(t, 'session'),
  }),
}))

import * as route from '@/app/api/network/contacts/[id]/route'

const ID = '11111111-2222-4333-8444-555555555555'
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CO2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const CO_GONE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const CO_ELSEWHERE = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const ME = 'user-me'
const FULL = { type: 'Business', value: '1 Main St, Denver, CO, 80202', street: '1 Main St', apt: '', city: 'Denver', state: 'CO', zip: '80202' }
const NOTE = { id: 'n1', text: 'Loves pantry photos', ts: 'Sep 14', user: 'Kevin' }
const stored = () => ({
  id: ID, location_id: LOC, deleted_at: null, name: 'Lisa Snyder', title: 'Realtor', company: 'Compass', company_id: CO,
  phone: '(303) 555-0142', email: 'lisa@compass.com', website: 'compass.com', addresses: [FULL],
  how_we_met: 'Chamber breakfast', specialties: ['real-estate'], relationship: 'Realtor', notes: [NOTE],
  next_steps: [{ id: 's1', text: 'Send packet', done: false }], activity: [{ type: 'event', label: 'Added to Network', ts: 'Just now' }],
  is_customer: false, customer_lead_id: null, network_types: ['partner'], partner_level: 'referral', partner_stage: 'Reaching Out',
  birthday: null, birthday_reminder: false, last_contacted_at: null, created_at: '2026-08-24T15:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  met_date: 'Just now', type: 'partner', stage: 'Reaching Out', tier: 'referral-partner', partner_tags: [{ tag_lookup_id: 't1' }, { tag_lookup_id: 't-off' }],
})
const as = (role: string | null, locationId: string | null = null) => {
  h.state.sessionUser = role ? { id: ME } : null
  h.state.hubUser = role ? { id: ME, role, location_id: locationId } : null
}
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) })
const get = () => route.GET({} as any, ctx())
const patch = (body: any) => route.PATCH({ json: async () => body } as any, ctx())
const service = () => h.state.calls.filter((c: any) => c.client === 'service')
const writes = () => service().filter((c: any) => c.op !== 'select')
const partner = () => h.state.tables.partners[0]
const movedSince = (before: any) => Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(partner()[k])).sort()
const snap = () => JSON.parse(JSON.stringify(partner()))

beforeEach(() => {
  h.state.calls = []
  h.state.tables = {
    partners: [stored()],
    companies: [
      { id: CO, name: 'Compass Greenwood Village', location_id: LOC, deleted_at: null },
      { id: CO2, name: 'Oak & Key Realty', location_id: LOC, deleted_at: null },
      { id: CO_GONE, name: 'Closed Co', location_id: LOC, deleted_at: '2026-10-01T00:00:00Z' },
      { id: CO_ELSEWHERE, name: 'Far Away Co', location_id: OTHER, deleted_at: null },
    ],
    locations: [{ id: LOC, name: 'Greensboro' }],
    lookups: [
      { id: 't1', label: 'Realtor', icon: '🏠', attrs: { section: 'trade' }, location_id: null, is_active: true },
      { id: 't-off', label: 'Housekeeper', attrs: { section: 'trade' }, location_id: null, is_active: false },
    ],
    hub_users: [{ id: ME, full_name: 'Kevin Shaw', first_name: 'Kevin' }],
    touchpoints: [], reminders: [],
  }
})

describe('a note', () => {
  it('writes the notes column and updated_at, and no other column on the row', async () => {
    as('super_admin')
    const before = snap()
    const res = await patch({ addNote: { text: 'Prefers a text' } })
    expect(res.status).toBe(200)
    expect((await res.json()).written).toEqual(['notes'])
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({ table: 'partners', op: 'update', filters: [['eq', 'id', ID]] })
    expect(Object.keys(writes()[0].payload).sort()).toEqual(['notes', 'updated_at'])
    expect(movedSince(before)).toEqual(['notes', 'updated_at'])
  })
  it('keeps the stored note and adds the new one after it, signed with the first name of whoever is signed in', async () => {
    as('super_admin')
    await patch({ addNote: { text: 'Prefers a text', user: 'Somebody else' } })
    expect(partner().notes[0]).toEqual(NOTE)
    expect(partner().notes).toHaveLength(2)
    expect(partner().notes[1]).toMatchObject({ text: 'Prefers a text', user: 'Kevin' })
    expect(partner().notes[1].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
  it('comes back on the sheet at once', async () => {
    as('super_admin')
    const json = await (await patch({ addNote: { text: 'Prefers a text' } })).json()
    expect(json.contact.notes.map((n: any) => n.text)).toEqual(['Loves pantry photos', 'Prefers a text'])
  })
  it.each([[{ text: '  ' }, 422], [{ text: 'x'.repeat(2001) }, 422], ['words', 400]])('refused (%j): nothing is written', async (addNote, status) => {
    as('super_admin')
    const res = await patch({ addNote })
    expect(res.status).toBe(status)
    expect(writes()).toEqual([])
    expect(partner().notes).toEqual([NOTE])
  })
})

describe('addresses', () => {
  const NEW = { type: 'Home', street: '5 Lake Dr', apt: '', city: 'Golden', state: 'CO', zip: '' }
  it('writes the addresses column and updated_at, and no other column on the row', async () => {
    as('super_admin')
    const before = snap()
    const res = await patch({ addresses: { from: [FULL], to: [FULL, NEW] } })
    expect((await res.json()).written).toEqual(['addresses'])
    expect(Object.keys(writes()[0].payload).sort()).toEqual(['addresses', 'updated_at'])
    expect(movedSince(before)).toEqual(['addresses', 'updated_at'])
    expect(partner().addresses).toEqual([FULL, { type: 'Home', value: '5 Lake Dr, Golden, CO', street: '5 Lake Dr', apt: '', city: 'Golden', state: 'CO', zip: '' }])
  })
  it('sent back unchanged: no update at all, and updated_at does not move', async () => {
    as('super_admin')
    const res = await patch({ addresses: { from: [FULL], to: [FULL] } })
    expect(res.status).toBe(200)
    expect((await res.json()).written).toEqual([])
    expect(writes()).toEqual([])
    expect(partner().updated_at).toBe('2026-09-01T00:00:00Z')
  })
  it('changed by someone else since the form opened: 409 and nothing written', async () => {
    as('super_admin')
    const res = await patch({ addresses: { from: [], to: [NEW] } })
    expect(res.status).toBe(409)
    expect((await res.json())).toMatchObject({ error: 'changed_by_someone_else', field: 'addresses', current: [FULL], written: [] })
    expect(writes()).toEqual([])
  })
  it('an address that cannot be read is refused and nothing is written', async () => {
    as('super_admin')
    expect((await patch({ addresses: { from: [FULL], to: [{ type: 'Home', value: 'x', partner_stage: 'Active Partner' }] } })).status).toBe(422)
    expect(writes()).toEqual([])
  })
})

describe('the company link', () => {
  it('writes company_id and updated_at, and no other column: the company text stays as it was', async () => {
    as('super_admin')
    const before = snap()
    const res = await patch({ companyId: { from: CO, to: CO2 } })
    expect((await res.json()).written).toEqual(['company_id'])
    expect(Object.keys(writes()[0].payload).sort()).toEqual(['company_id', 'updated_at'])
    expect(movedSince(before)).toEqual(['company_id', 'updated_at'])
    expect(partner()).toMatchObject({ company_id: CO2, company: 'Compass' })
  })
  it('the company is looked up by its id in the companies table, never by a name', async () => {
    as('super_admin')
    await patch({ companyId: { from: CO, to: CO2 } })
    const read = service().find((c: any) => c.table === 'companies' && c.op === 'select' && c.filters.some((f: any) => f[2] === CO2))
    expect(read.filters).toEqual([['eq', 'id', CO2]])
    for (const c of service().filter((x: any) => x.table === 'companies')) expect(c.filters.every((f: any) => f[1] === 'id')).toBe(true)
  })
  it('unlinking writes null', async () => {
    as('super_admin')
    await patch({ companyId: { from: CO, to: null } })
    expect(partner()).toMatchObject({ company_id: null, company: 'Compass' })
  })
  it('the same link again: no update at all', async () => {
    as('super_admin')
    expect((await (await patch({ companyId: { from: CO, to: CO } })).json()).written).toEqual([])
    expect(writes()).toEqual([])
  })
  it.each([
    ['a company that was deleted', CO_GONE, 'company_not_found'],
    ["another location's company", CO_ELSEWHERE, 'company_other_location'],
    ['an id that is no company', '12345678-1234-4234-8234-123456789012', 'company_not_found'],
    ['a company name', 'Compass Greenwood Village', 'company_not_found'],
  ])('%s is refused and nothing is written', async (_n, to, error) => {
    as('super_admin')
    const res = await patch({ companyId: { from: CO, to } })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe(error)
    expect(writes()).toEqual([])
    expect(partner().company_id).toBe(CO)
  })
  it('changed by someone else since the form opened: 409 and nothing written', async () => {
    as('super_admin')
    expect((await patch({ companyId: { from: null, to: CO2 } })).status).toBe(409)
    expect(writes()).toEqual([])
  })
})

describe('together with the nine fields', () => {
  it('a name and the link in one save: one update, those two columns and updated_at', async () => {
    as('super_admin')
    const before = snap()
    const res = await patch({ changes: { title: { from: 'Realtor', to: 'Broker' } }, companyId: { from: CO, to: CO2 } })
    expect((await res.json()).written).toEqual(['title', 'company_id'])
    expect(writes()).toHaveLength(1)
    expect(movedSince(before)).toEqual(['company_id', 'title', 'updated_at'])
  })
  it('if either half is refused, neither is written', async () => {
    as('super_admin')
    expect((await patch({ changes: { title: { from: 'Realtor', to: 'Broker' } }, companyId: { from: CO, to: CO_GONE } })).status).toBe(422)
    expect((await patch({ changes: { email: { to: 'nope' } }, addNote: { text: 'fine' } })).status).toBe(422)
    expect(writes()).toEqual([])
    expect(partner()).toMatchObject({ title: 'Realtor', company_id: CO, notes: [NOTE] })
  })
  it('a save with nothing in it is still refused', async () => {
    as('super_admin')
    expect((await patch({})).status).toBe(400)
    expect((await patch({ changes: {} })).status).toBe(400)
    expect(writes()).toEqual([])
  })
  it('a slice 4a field cannot be smuggled in beside an add', async () => {
    as('super_admin')
    expect((await patch({ addNote: { text: 'fine' }, changes: { tier: { to: 'power-partner' } } })).status).toBe(400)
    expect(writes()).toEqual([])
  })
  it('keys this save does not know are not written: type, stage, tags, met_date', async () => {
    as('super_admin')
    const before = snap()
    await patch({ addNote: { text: 'fine' }, type: 'vendor', partner_stage: 'Active Partner', network_types: ['vendor'], met_date: 'x', tagIds: [] })
    expect(movedSince(before)).toEqual(['notes', 'updated_at'])
  })
})

describe('who may use it', () => {
  it.each([['owner', LOC], ['manager', LOC], ['lite_user', LOC], ['admin', null]])('%s: 403 on every add, nothing read and nothing written', async (role, loc) => {
    as(role, loc)
    for (const body of [{ addNote: { text: 'x' } }, { addresses: { from: [FULL], to: [] } }, { companyId: { from: CO, to: null } }]) expect((await patch(body)).status).toBe(403)
    expect(service()).toEqual([])
    expect(partner()).toMatchObject({ notes: [NOTE], addresses: [FULL], company_id: CO })
  })
  it('nobody signed in: 401', async () => {
    as(null)
    expect((await patch({ addNote: { text: 'x' } })).status).toBe(401)
    expect(service()).toEqual([])
  })
})

describe('only partners is written', () => {
  it('across every kind of add, the one table written is partners, by update', async () => {
    as('super_admin')
    await patch({ addNote: { text: 'one' } })
    await patch({ addresses: { from: [FULL], to: [] } })
    await patch({ companyId: { from: CO, to: CO2 } })
    expect(Array.from(new Set(writes().map((c: any) => `${c.table}/${c.op}`)))).toEqual(['partners/update'])
    expect(writes()).toHaveLength(3)
  })
})

describe('what the save compares against', () => {
  it('reads the stored notes, addresses and company link by name, so a note is appended to what is really there', () => {
    // The stand-in database hands back whole rows whatever is asked for; the
    // real one does not. If `notes` were not asked for, the stored notes would
    // read as empty and a new note would REPLACE them. So this reads the list.
    const { readFileSync } = require('node:fs'); const { join } = require('node:path')
    const src = readFileSync(join(process.cwd(), 'app/api/network/contacts/[id]/route.ts'), 'utf8')
    const cols = src.split('const EDIT_COLS =')[1]!.split('\n')[0]!
    for (const col of ['notes', 'addresses', 'company_id', 'location_id', 'deleted_at']) expect(cols, col).toMatch(new RegExp(`[ ']${col}[,']`))
    expect(src).toContain(".from('partners').select(EDIT_COLS).eq('id', id)")
  })
})

describe('the tags on the sheet', () => {
  it("each tag comes with its stored emoji, read from the tag list by name of column", async () => {
    as('super_admin')
    h.state.tables.lookups.push({ id: 't2', label: 'Partner', icon: null, attrs: { section: 'relationship' }, location_id: null, is_active: true })
    h.state.tables.partners[0].partner_tags.push({ tag_lookup_id: 't2' })
    const json = await (await get()).json()
    expect(json.tags.map((t: any) => [t.label, t.icon])).toEqual([['Partner', null], ['Realtor', '🏠']])
    const read = service().find((c: any) => c.table === 'lookups')
    expect(read.cols).toContain('icon')
  })
  it('a switched-off tag is not shown, and its link is left alone', async () => {
    as('super_admin')
    const json = await (await get()).json()
    expect(json.tags).toEqual([{ id: 't1', label: 'Realtor', icon: '🏠', section: 'trade' }])
    expect(json.contact.tagIds).toEqual(['t1', 't-off'])
    expect(writes()).toEqual([])
  })
})
