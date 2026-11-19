// /api/network/contacts/[id] — the contact sheet's read and its save (slice 4a).
//
// Pinned here, against a stand-in for the database that records every call:
//   · super admins only; every other role is refused before anything is read
//   · a save sends the database ONLY the columns that changed, plus updated_at
//   · a save that changes nothing sends no update at all
//   · a refused save sends no update at all
//   · nothing but public.partners is ever written
//
// The same route was also run against a Postgres copy holding production's
// 269 contacts, comparing every column of every row before and after each
// save. That run and its results are in
// ~/Projects/bee-organized-repair-reports/2026-11-15/contact-sheet-save-proof/.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WRITABLE_COLUMNS } from './contact-edit'

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
      // A plain column list hands back only those columns, as the database
      // does, so a read that forgets one (network_types, to tell a person from
      // an organization) is caught. A list with a joined table is left whole.
      if (typeof ctx.cols === 'string' && /^[\w\s,]+$/.test(ctx.cols) && ctx.cols.trim() !== '*') {
        const keep = ctx.cols.split(',').map((c: string) => c.trim())
        rows = rows.map((r: any) => Object.fromEntries(keep.map((k: string) => [k, r[k]])))
      }
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
const GONE = '99999999-2222-4333-8444-555555555555'
const LOC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ME = 'user-me'
const stored = () => ({
  id: ID, location_id: LOC, deleted_at: null, name: 'Lisa Snyder', title: 'Realtor', company: 'Compass', company_id: CO,
  phone: '(303) 555-0142', email: 'lisa@compass.com', website: 'compass.com', addresses: [{ type: 'Office', value: '1 Main St' }],
  how_we_met: 'Chamber breakfast', specialties: ['real-estate'], relationship: 'Realtor', notes: [{ id: 'n1', text: 'Loves pantry photos', ts: 'Sep 14', user: 'Kevin' }],
  next_steps: [{ id: 's1', text: 'Send packet', done: false }], activity: [{ type: 'event', label: 'Added to Network', ts: 'Aug 24' }],
  is_customer: false, customer_lead_id: null, network_types: ['partner'], partner_level: 'referral', partner_stage: 'Reaching Out',
  birthday: null, birthday_reminder: false, last_contacted_at: null, created_at: '2026-08-24T15:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  met_date: 'Just now', type: 'partner', stage: 'Reaching Out', tier: 'referral-partner', partner_tags: [{ tag_lookup_id: 't1' }],
})
const as = (role: string | null, locationId: string | null = null) => {
  h.state.sessionUser = role ? { id: ME } : null
  h.state.hubUser = role ? { id: ME, role, location_id: locationId } : null
}
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) })
const get = (id = ID) => route.GET({} as any, ctx(id))
const patch = (changes: any, id = ID) => route.PATCH({ json: async () => ({ changes }) } as any, ctx(id))
const service = () => h.state.calls.filter((c: any) => c.client === 'service')
const writes = () => service().filter((c: any) => c.op !== 'select')

beforeEach(() => {
  h.state.calls = []
  h.state.tables = {
    partners: [stored(), { ...stored(), id: GONE, deleted_at: '2026-10-01T00:00:00Z' }],
    companies: [{ id: CO, name: 'Compass Greenwood Village', deleted_at: null }],
    locations: [{ id: LOC, name: 'Greensboro' }],
    lookups: [{ id: 't1', label: 'Realtor', attrs: { section: 'trade' }, location_id: null, is_active: true }],
    touchpoints: [{ id: 'tp1', partner_id: ID, kind: 'reach_out', method: 'call', label: 'Phone Call', status: 'reached', notes: 'Spring listings', occurred_at: '2026-09-14T15:00:00Z' }],
    reminders: [
      { id: 'r1', user_id: ME, partner_id: ID, due_on: '2026-11-20', note: 'Coffee', done_at: null },
      { id: 'r2', user_id: 'someone-else', partner_id: ID, due_on: '2026-11-01', note: 'Theirs', done_at: null },
    ],
  }
})

describe('who may use it', () => {
  it('nobody signed in: 401 on both, nothing read', async () => {
    as(null)
    expect((await get()).status).toBe(401)
    expect((await patch({ title: { to: 'Broker' } })).status).toBe(401)
    expect(service()).toEqual([])
  })
  it.each([['owner', LOC], ['manager', LOC], ['lite_user', LOC], ['admin', null]])('%s: 403 on both, nothing read and nothing written', async (role, loc) => {
    as(role, loc)
    expect((await get()).status).toBe(403)
    expect((await patch({ title: { to: 'Broker' } })).status).toBe(403)
    expect(service()).toEqual([])
    expect(h.state.tables.partners[0].title).toBe('Realtor')
  })
  it('the file has two handlers, GET and PATCH: nothing can create or delete a contact here', () => {
    expect(Object.keys(route).sort()).toEqual(['GET', 'PATCH', 'runtime'])
  })
})

describe('the read', () => {
  it('sends what the design has no field for: address, website, the company link, how you met, specialties, notes, next steps, relationship', async () => {
    as('super_admin')
    const { contact } = await (await get()).json()
    expect(contact).toMatchObject({
      website: 'compass.com', addresses: [{ type: 'Office', value: '1 Main St' }], companyId: CO,
      linkedCompany: { id: CO, name: 'Compass Greenwood Village' }, howWeMet: 'Chamber breakfast', specialties: ['real-estate'],
      relationship: 'Realtor', locationName: 'Greensboro',
    })
    expect(contact.notes).toHaveLength(1)
    expect(contact.nextSteps).toHaveLength(1)
  })
  it('the company link is the linked company, not a match on the company text', async () => {
    as('super_admin')
    const { contact } = await (await get()).json()
    expect(contact.company).toBe('Compass')
    expect(contact.linkedCompany.name).toBe('Compass Greenwood Village')
    const read = service().find((c: any) => c.table === 'companies')
    expect(read.filters).toEqual([['eq', 'id', CO]])
  })
  it('sends type, level and stage as stored, and the date it was added', async () => {
    as('super_admin')
    const { contact } = await (await get()).json()
    expect(contact).toMatchObject({ networkTypes: ['partner'], partnerLevel: 'referral', partnerStage: 'Reaching Out', createdAt: '2026-08-24T15:00:00Z' })
  })
  it('never reads met_date: the junk "Just now" cannot reach the sheet', async () => {
    as('super_admin')
    const body = await (await get()).json()
    expect(JSON.stringify(body)).not.toContain('Just now')
    for (const c of service()) expect(c.cols).not.toContain('met_date')
  })
  it('names the tags with their Bee Hub section', async () => {
    as('super_admin')
    expect((await (await get()).json()).tags).toEqual([{ id: 't1', label: 'Realtor', icon: null, section: 'trade' }])
  })
  it("follow-ups are the caller's own open reminders on this contact", async () => {
    as('super_admin')
    // only the columns the route reads (id, due_on, note), as the database answers
    expect((await (await get()).json()).followUps).toEqual([{ id: 'r1', due_on: '2026-11-20', note: 'Coffee' }])
  })
  it('a reminder already ticked off is not a follow-up', async () => {
    as('super_admin')
    h.state.tables.reminders.push({ id: 'r3', user_id: ME, partner_id: ID, due_on: '2026-10-01', note: 'Done one', done_at: '2026-10-02T00:00:00Z' })
    expect((await (await get()).json()).followUps.map((r: any) => r.id)).toEqual(['r1'])
  })
  it('a company that was deleted is not shown as the link, though the link itself is kept', async () => {
    as('super_admin')
    h.state.tables.companies[0].deleted_at = '2026-10-01T00:00:00Z'
    const { contact } = await (await get()).json()
    expect(contact.linkedCompany).toBeNull()
    expect(contact.companyId).toBe(CO)
  })
  it('asks the database for every field the design drops, by name', () => {
    // The stand-in database hands back whole rows whatever is asked for, so
    // this reads the list of columns the route really asks for.
    const src = readFileSync(join(process.cwd(), 'app/api/network/contacts/[id]/route.ts'), 'utf8')
    const cols = src.split('const SHEET_COLS =')[1]!.split('\n\n')[0]!
    for (const col of ['addresses', 'website', 'company_id', 'how_we_met', 'specialties', 'relationship', 'notes', 'next_steps', 'created_at', 'network_types', 'partner_level', 'partner_stage', 'birthday', 'birthday_reminder']) {
      expect(cols, col).toMatch(new RegExp(`[ ']${col},`))
    }
  })
  it('a deleted contact, or an id that is not one, is not found', async () => {
    as('super_admin')
    expect((await get(GONE)).status).toBe(404)
    expect((await get('not-an-id')).status).toBe(404)
  })
  it('reading writes nothing', async () => {
    as('super_admin')
    await get()
    expect(writes()).toEqual([])
  })
})

describe('the save writes only what changed', () => {
  it.each([
    ['title', 'Broker', 'title'], ['company', 'Compass Denver', 'company'], ['phone', '720-555-0199', 'phone'],
    ['email', 'new@example.com', 'email'], ['website', 'new.example', 'website'], ['howWeMet', 'BNI', 'how_we_met'], ['birthday', 'Mar 22', 'birthday'],
  ])('%s: the database is sent that column and updated_at, and nothing else', async (field, to, column) => {
    as('super_admin')
    const res = await patch({ [field]: { to } })
    expect(res.status).toBe(200)
    expect((await res.json()).written).toEqual([column])
    expect(writes()).toHaveLength(1)
    expect(writes()[0]).toMatchObject({ table: 'partners', op: 'update', filters: [['eq', 'id', ID]] })
    expect(Object.keys(writes()[0].payload).sort()).toEqual([column, 'updated_at'].sort())
  })
  it('every other column on the row is untouched', async () => {
    as('super_admin')
    const before = JSON.parse(JSON.stringify(h.state.tables.partners[0]))
    await patch({ phone: { from: '(303) 555-0142', to: '720-555-0199' } })
    const after = h.state.tables.partners[0]
    const moved = Object.keys(before).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    expect(moved.sort()).toEqual(['phone', 'updated_at'])
    expect(after.phone).toBe('(720) 555-0199')
    expect(after).toMatchObject({ website: 'compass.com', company_id: CO, met_date: 'Just now', stage: 'Reaching Out', tier: 'referral-partner', partner_stage: 'Reaching Out' })
    expect(after.addresses).toEqual(before.addresses)
    expect(after.notes).toEqual(before.notes)
  })
  it('a save that changes nothing sends no update, so updated_at does not move', async () => {
    as('super_admin')
    const res = await patch({ phone: { from: '(303) 555-0142', to: '303-555-0142' }, title: { from: 'Realtor', to: ' Realtor ' } })
    expect(res.status).toBe(200)
    expect((await res.json()).written).toEqual([])
    expect(writes()).toEqual([])
    expect(h.state.tables.partners[0].updated_at).toBe('2026-09-01T00:00:00Z')
  })
  it('the whole contact sent with one field different writes one column', async () => {
    as('super_admin')
    await patch({
      name: { from: 'Lisa Snyder', to: 'Lisa Snyder' }, title: { from: 'Realtor', to: 'Realtor' }, company: { from: 'Compass', to: 'Compass' },
      phone: { from: '(303) 555-0142', to: '(303) 555-0142' }, email: { from: 'lisa@compass.com', to: 'lisa@compass.com' },
      website: { from: 'compass.com', to: 'compass.example' }, howWeMet: { from: 'Chamber breakfast', to: 'Chamber breakfast' },
      birthday: { from: null, to: null }, birthdayReminder: { from: false, to: false },
    })
    expect(Object.keys(writes()[0].payload).sort()).toEqual(['updated_at', 'website'])
  })
  it('only ever sends columns from the editable list', async () => {
    as('super_admin')
    await patch({ firstName: { to: 'A' }, lastName: { to: 'Z' }, title: { to: 'B' }, company: { to: 'C' }, phone: { to: '720-555-0199' }, email: { to: 'd@example.com' }, website: { to: 'e.example' }, howWeMet: { to: 'F' }, birthday: { to: 'Mar 22' }, birthdayReminder: { to: true } })
    for (const col of Object.keys(writes()[0].payload)) expect(WRITABLE_COLUMNS, col).toContain(col)
    // first, last and the full name set from them, the eight others, updated_at
    expect(Object.keys(writes()[0].payload)).toHaveLength(12)
  })
  it('the answer is the contact as it now stands, with what was written', async () => {
    as('super_admin')
    const body = await (await patch({ title: { to: 'Broker' } })).json()
    expect(body.contact.title).toBe('Broker')
    expect(body.written).toEqual(['title'])
    expect(body.notes).toEqual([])
  })
})

describe('a refused save writes nothing', () => {
  it.each([
    ['changed by someone else', { phone: { from: '(303) 555-0000', to: '720-555-0199' } }, 409, 'changed_by_someone_else'],
    ['a field that is not editable', { title: { to: 'Broker' }, tier: { to: 'power-partner' } }, 400, 'field_not_editable'],
    ['a stage change nobody confirmed', { title: { to: 'Broker' }, partnerStage: { from: 'Reaching Out', to: 'Active Partner' } }, 428, 'needs_confirmation'],
    ['a type change', { networkTypes: { to: ['vendor'] } }, 400, 'field_not_editable'],
    ['an address', { addresses: { to: [] } }, 400, 'field_not_editable'],
    ['the company link', { companyId: { to: null } }, 400, 'field_not_editable'],
    ['met_date', { metDate: { to: 'Aug 2026' } }, 400, 'field_not_editable'],
    ['an email that looks wrong', { email: { to: 'nope' } }, 422, 'email_looks_wrong'],
    ['two phone numbers', { phone: { to: '407-393-5901 & 407-392-1931' } }, 422, 'one_phone_number_only'],
    ['no changes', {}, 400, 'changes_required'],
  ])('%s: %o → no update is sent', async (_name, changes, status, error) => {
    as('super_admin')
    const before = JSON.stringify(h.state.tables.partners[0])
    const res = await patch(changes)
    expect(res.status).toBe(status)
    const body = await res.json()
    expect(body.error).toBe(error)
    expect(body.written).toEqual([])
    expect(writes()).toEqual([])
    expect(JSON.stringify(h.state.tables.partners[0])).toBe(before)
  })
  it('a conflict says what the field holds now', async () => {
    as('super_admin')
    expect(await (await patch({ phone: { from: 'stale', to: '720-555-0199' } })).json()).toMatchObject({ field: 'phone', current: '(303) 555-0142' })
  })
  it('a deleted contact cannot be saved to', async () => {
    as('super_admin')
    expect((await patch({ title: { to: 'x' } }, GONE)).status).toBe(404)
    expect(writes()).toEqual([])
  })
})

describe('nothing outside partners is written', () => {
  it('across every kind of save, the only table written is partners', async () => {
    as('super_admin')
    await patch({ phone: { to: '720-555-0199' } }); await patch({ birthday: { to: 'Mar 22' }, birthdayReminder: { to: true } }); await patch({ birthday: { to: '' } })
    expect(writes().length).toBe(3)
    expect(Array.from(new Set(writes().map((c: any) => `${c.table}/${c.op}`)))).toEqual(['partners/update'])
  })
  it('the source names one write, an update of partners, and no other table to write', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/network/contacts/[id]/route.ts'), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    expect(src.match(/\.(insert|upsert|delete|rpc)\(/g)).toBeNull()
    expect(src.match(/\.update\(/g)).toHaveLength(1)
    expect(src).toMatch(/\.from\('partners'\)\s*\.update\(\{ \.\.\.plan\.update, updated_at: new Date\(\)\.toISOString\(\) \}\)/)
    expect(src).not.toMatch(/recordPhoneNote|partnerPatchToRow/)
  })
  it('keeps the paused-location check ahead of the save, for the day another role is let in', () => {
    // Today only super admins reach this route and that check always lets
    // them through, so it cannot be seen to fire. It is kept, in order, so
    // that widening the gate later cannot skip it.
    const src = readFileSync(join(process.cwd(), 'app/api/network/contacts/[id]/route.ts'), 'utf8')
    const check = src.indexOf('const blocked = await readOnlyWriteBlock({ role: caller.role }, (stored as any).location_id)\n  if (blocked) return blocked')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(src.indexOf('planContactSave(row'))
    expect(check).toBeLessThan(src.indexOf('planContactAdds(row'))
    expect(check).toBeLessThan(src.indexOf('.update('))
  })
})

describe('a rename on the sheet keeps first, last and full name together (2026-11-19)', () => {
  it('a person: the last name changed writes last_name AND name in the same update', async () => {
    as('super_admin')
    h.state.tables.partners[0].first_name = 'Lisa'
    h.state.tables.partners[0].last_name = 'Snyder'
    const res = await patch({ lastName: { from: 'Snyder', to: 'Snyder-Hall' } })
    expect(res.status).toBe(200)
    expect(writes()).toHaveLength(1)
    expect(Object.keys(writes()[0].payload).sort()).toEqual(['last_name', 'name', 'updated_at'])
    expect(h.state.tables.partners[0]).toMatchObject({ name: 'Lisa Snyder-Hall', first_name: 'Lisa', last_name: 'Snyder-Hall' })
    const body = await res.json()
    expect(body.contact).toMatchObject({ name: 'Lisa Snyder-Hall', firstName: 'Lisa', lastName: 'Snyder-Hall' })
  })
  it('a person: the full name alone cannot be changed, and nothing is written', async () => {
    as('super_admin')
    const res = await patch({ name: { from: 'Lisa Snyder', to: 'Lisa Hall' } })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe('name_is_set_from_first_and_last')
    expect(writes()).toEqual([])
  })
  it('an organization: one name, first and last stay empty', async () => {
    as('super_admin')
    h.state.tables.partners[0].network_types = ['organization']
    const res = await patch({ name: { to: 'Compass Realty' } })
    expect(res.status).toBe(200)
    expect(Object.keys(writes()[0].payload).sort()).toEqual(['name', 'updated_at'])
    expect((await patch({ firstName: { to: 'Compass' } })).status).toBe(422)
  })
})

describe('a level or stage change (slice 6)', () => {
  it('confirmed: the database is sent partner_stage and updated_at, nothing else', async () => {
    as('super_admin')
    const res = await route.PATCH({ json: async () => ({ changes: { partnerStage: { from: 'Reaching Out', to: 'Active Partner' } }, confirmed: true }) } as any, ctx(ID))
    expect(res.status).toBe(200)
    expect(writes()).toHaveLength(1)
    expect(Object.keys(writes()[0].payload).sort()).toEqual(['partner_stage', 'updated_at'])
    expect(h.state.tables.partners[0].partner_stage).toBe('Active Partner')
  })
  it('not confirmed: 428, nothing written, the row exactly as it was', async () => {
    as('super_admin')
    const before = JSON.stringify(h.state.tables.partners)
    const res = await patch({ partnerStage: { from: 'Reaching Out', to: 'Active Partner' } })
    expect(res.status).toBe(428)
    expect(writes()).toEqual([])
    expect(JSON.stringify(h.state.tables.partners)).toBe(before)
  })
})
