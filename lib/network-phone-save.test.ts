// @vitest-environment node
//
// A phone typed into a Network person or a company is saved in the
// universal shape, (123) 456-7890 — through the REAL routes, not just the
// mapping helper, so removing the line from lib/crm.ts (or the partners
// routes' override) fails here.
//
// And a Network person follows the lead rule for a field holding two
// numbers (Kevin, 16 Oct 2026): the first is the phone, the whole original
// is ONE note on their timeline. A company has no timeline, so it saves
// such a field whole and writes no note.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const LOC = '11111111-2222-4333-8444-555555555555'

const h = vi.hoisted(() => {
  type Call = { table: string; ops: [string, any[]][] }
  const state = { calls: [] as Call[] }
  const rowFor = (table: string, call: Call) => {
    if (table === 'touchpoints') return { id: 'tp-1' }
    const written = call.ops.find(([m]) => m === 'insert' || m === 'update')?.[1][0] ?? {}
    return { id: table === 'partners' ? 'p-1' : 'c-1', location_id: '11111111-2222-4333-8444-555555555555', name: 'X', ...written }
  }
  const makeBuilder = (table: string) => {
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'is', 'in', 'order', 'range', 'limit', 'or', 'not', 'ilike']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.single = () => Promise.resolve({ data: rowFor(table, call), error: null })
    b.maybeSingle = b.single
    b.then = (res: any, rej: any) => Promise.resolve({ data: [], error: null, count: 0 }).then(res, rej)
    return b
  }
  return { state, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'u-1', role: 'owner', location_id: '11111111-2222-4333-8444-555555555555' } }) }) }),
    }),
  }),
}))
vi.mock('@/lib/read-only-access', () => ({ readOnlyWriteBlock: async () => null }))
vi.mock('@/lib/partner-tag-writes', () => ({ attachPartnerTags: async () => ({ rejected: [] }) }))

import { partnerPatchToRow, companyPatchToRow } from '@/lib/crm'
import { POST as partnersPOST } from '@/app/api/partners/route'
import { PATCH as partnerPATCH } from '@/app/api/partners/[id]/route'
import { POST as companiesPOST } from '@/app/api/companies/route'
import { PATCH as companyPATCH } from '@/app/api/companies/[id]/route'

const req = (body: any) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) }) as any
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const writes = (table: string, kind: 'insert' | 'update') =>
  h.state.calls.filter(c => c.table === table).map(c => c.ops.find(([m]) => m === kind)?.[1][0]).filter(Boolean)

beforeEach(() => { h.state.calls = [] })

describe('the mapping helpers format a phone', () => {
  it.each([
    ['  732 755-0037 ', '(732) 755-0037'],
    ['+1 (303) 210-4579', '(303) 210-4579'],
    ['609 693-5002 X6017', '(609) 693-5002 ext. 6017'],
    ['+82-10-2890-8574', '+82-10-2890-8574'],
  ])('%j → %s for a person and a company', (raw, want) => {
    expect(partnerPatchToRow({ phone: raw }).phone).toBe(want)
    expect(companyPatchToRow({ phone: raw }).phone).toBe(want)
  })
  it('no phone in the patch → the phone is not touched', () => {
    expect(partnerPatchToRow({ name: 'x' })).not.toHaveProperty('phone')
    expect(companyPatchToRow({ name: 'x' })).not.toHaveProperty('phone')
  })
})

describe('a Network PERSON, through the real routes', () => {
  it('create: the phone is saved formatted, no note', async () => {
    const res = await partnersPOST(req({ location_id: LOC, name: 'Karen', phone: '732 755-0037' }))
    expect(res.status).toBe(201)
    expect(writes('partners', 'insert')[0].phone).toBe('(732) 755-0037')
    expect(writes('touchpoints', 'insert')).toHaveLength(0)
  })
  it('edit: the phone is saved formatted, no note', async () => {
    const res = await partnerPATCH(req({ phone: '7327550037' }), params('p-1'))
    expect(res.status).toBe(200)
    expect(writes('partners', 'update')[0].phone).toBe('(732) 755-0037')
    expect(writes('touchpoints', 'insert')).toHaveLength(0)
  })
  it('create with two numbers: the first is the phone, the original is ONE timeline note', async () => {
    await partnersPOST(req({ location_id: LOC, name: 'Karen', phone: 'Office 321-348-8720 & cell 407-230-3116' }))
    expect(writes('partners', 'insert')[0].phone).toBe('(321) 348-8720')
    const notes = writes('touchpoints', 'insert')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ partner_id: 'p-1', kind: 'note', location_uuid: LOC })
    expect(notes[0]).not.toHaveProperty('lead_id')
    expect(notes[0].notes).toContain('Office 321-348-8720 & cell 407-230-3116')
  })
  it('edit with two numbers: same — first number, one note', async () => {
    await partnerPATCH(req({ phone: '407-393-5901 & 407-392-1931' }), params('p-1'))
    expect(writes('partners', 'update')[0].phone).toBe('(407) 393-5901')
    const notes = writes('touchpoints', 'insert')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ partner_id: 'p-1', kind: 'note' })
    expect(notes[0].notes).toContain('407-393-5901 & 407-392-1931')
  })
})

describe('a COMPANY, through the real routes', () => {
  it('create and edit: the phone is saved formatted', async () => {
    await companiesPOST(req({ location_id: LOC, name: 'Acme', phone: '732 497-8739' }))
    await companyPATCH(req({ phone: '732.758.0404' }), params('c-1'))
    expect(writes('companies', 'insert')[0].phone).toBe('(732) 497-8739')
    expect(writes('companies', 'update')[0].phone).toBe('(732) 758-0404')
  })
  it('two numbers: saved whole (no timeline to keep a note on), and no note written', async () => {
    await companiesPOST(req({ location_id: LOC, name: 'Acme', phone: '407-393-5901 & 407-392-1931' }))
    expect(writes('companies', 'insert')[0].phone).toBe('407-393-5901 & 407-392-1931')
    expect(writes('touchpoints', 'insert')).toHaveLength(0)
  })
})
