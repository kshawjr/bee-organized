// @vitest-environment node
// /api/leads/intake — match-or-create dedup gate. This was the last
// un-deduped door into people-world; these tests pin the three tiers:
//   SOLID       — exact email OR exact phone_normalized → exactly one
//                 lead → NO new row, fill-empty merge, resubmission
//                 touchpoint, drip only if never enrolled.
//   IN QUESTION — strong key hits >1 lead / conflicting keys / name-only
//                 → still creates, but possible_duplicate_of is set.
//   NO MATCH    — clean insert, unchanged.
// Plus the standing NULL-safety patterns and the generated-column rule:
// phone_normalized must NEVER appear in an insert/update payload.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { classifyLeadMatches } from '@/components/hive/shared/clientMatch'

// ── mock supabaseService: recording query-builder with per-table FIFO
//    response queues. Anything not queued resolves { data:null, error:null }.
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    calls: [] as Call[],
  }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/drip-lifecycle', () => ({
  applyDripSideEffects: vi.fn(async () => {}),
  startDripForLead: vi.fn(async () => {}),
}))
vi.mock('@/lib/drip-send', () => ({
  sendDripStep: vi.fn(async () => ({ sent: true })),
}))

import { POST } from '@/app/api/leads/intake/route'
import { startDripForLead } from '@/lib/drip-lifecycle'
import { sendDripStep } from '@/lib/drip-send'

// ── helpers ────────────────────────────────────────────────
const LOC = {
  id: 'loc-uuid-1',
  name: 'Boulder',
  location_id: 'boulder-01',
  lifecycle_status: 'onboarding', // drip path stays quiet unless a test opts in
}

const makeReq = (body: any, key = 'test-key') => ({
  headers: { get: (k: string) => (k.toLowerCase() === 'x-api-key' ? key : null) },
  json: async () => body,
}) as any

const submission = (over: any = {}) => ({
  location_slug: 'boulder-01',
  full_name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
  ...over,
})

const storedLead = (over: any = {}) => ({
  id: 'lead-A',
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: null,
  phone_normalized: '',
  address: null,
  city: null,
  state: null,
  zip: null,
  project_type: null,
  stage: 'New',
  is_junk: null,
  location_uuid: 'loc-uuid-1',
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
})

const callsFor = (table: string) => h.state.calls.filter(c => c.table === table)
const opsOf = (call: { ops: [string, any[]][] }, m: string) => call.ops.filter(o => o[0] === m)
const insertPayloads = (table: string) =>
  callsFor(table).flatMap(c => opsOf(c, 'insert').map(o => o[1][0]))
const updatePayloads = (table: string) =>
  callsFor(table).flatMap(c => opsOf(c, 'update').map(o => o[1][0]))

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  process.env.LEAD_INTAKE_API_KEY = 'test-key'
  h.enqueue('locations', LOC)
})

// ═══ SOLID tier — auto-merge ═══════════════════════════════
describe('intake dedup — SOLID auto-merge', () => {
  it('exact email match → NO new leads row; empty fields filled only; resubmission touchpoint', async () => {
    h.enqueue('leads', [storedLead({ city: 'Boulder' })]) // match query
    const res = await POST(makeReq(submission({
      email: 'Sarah@Email.com', // case-varied on purpose — normalized match
      address: '123 Main St',
      city: 'Denver', // matched lead already HAS a city — must not overwrite
      message: 'Back again, need the garage done',
    })))
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.merged).toBe(true)
    expect(body.lead_id).toBe('lead-A')
    expect(body.matched_on).toBe('email')

    // ZERO new leads rows on a solid match.
    expect(insertPayloads('leads')).toHaveLength(0)

    // Fill-empty only: phone + address were NULL → filled; city was
    // 'Boulder' → NOT overwritten; email already present → untouched.
    const upd = updatePayloads('leads')
    expect(upd).toHaveLength(1)
    expect(upd[0]).toMatchObject({ phone: '(561) 555-0199', address: '123 Main St' })
    expect(upd[0]).not.toHaveProperty('city')
    expect(upd[0]).not.toHaveProperty('email')
    expect(upd[0], 'generated column must never be written').not.toHaveProperty('phone_normalized')

    // Resubmission touchpoint on the MATCHED lead.
    const tps = insertPayloads('touchpoints')
    expect(tps).toHaveLength(1)
    expect(tps[0]).toMatchObject({ lead_id: 'lead-A', label: 'Webform resubmission' })
    expect(tps[0].notes).toContain('Back again')
  })

  it('exact phone_normalized match (formatted stored phone, digits-only compare) → merges', async () => {
    // The stored value the old blind insert could never match: free-text
    // phone with inline text; phone_normalized (generated) is the digits.
    h.enqueue('leads', [storedLead({
      id: 'lead-B',
      email: null,
      phone: '3039949176 (stuart)',
      phone_normalized: '3039949176',
    })])
    const res = await POST(makeReq(submission({
      email: 'stuart@newmail.com', // no email hit — phone is the key
      phone: '(303) 994-9176',
    })))
    const body = await res.json()

    expect(body.merged).toBe(true)
    expect(body.lead_id).toBe('lead-B')
    expect(body.matched_on).toBe('phone')
    expect(insertPayloads('leads')).toHaveLength(0)

    // The match query ran against phone_normalized — never raw phone.
    const matchCall = callsFor('leads')[0]
    const orArg = opsOf(matchCall, 'or')[0][1][0] as string
    expect(orArg).toContain('phone_normalized.eq."3039949176"')
    expect(orArg).not.toMatch(/(^|,)phone\.eq\./)

    // Matched lead had no email → the submitted one fills the gap.
    const upd = updatePayloads('leads')
    expect(upd[0]).toMatchObject({ email: 'stuart@newmail.com' })
    expect(upd[0]).not.toHaveProperty('phone_normalized')
  })

  it('merge path: drip NOT re-enrolled when a progress row already exists', async () => {
    h.reset() // replace the beforeEach location with an ACTIVE one
    h.enqueue('locations', { ...LOC, lifecycle_status: 'active' })
    h.enqueue('leads', [storedLead()])
    h.enqueue('lead_drip_progress', { id: 'prog-existing' }) // already enrolled
    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.merged).toBe(true)
    expect(body.drip_enrolled).toBe(false)
    expect(startDripForLead).not.toHaveBeenCalled()
    expect(sendDripStep).not.toHaveBeenCalled()
  })

  it('merge path: never-enrolled lead on an active location gets enrolled once', async () => {
    h.reset()
    h.enqueue('locations', { ...LOC, lifecycle_status: 'active' })
    h.enqueue('leads', [storedLead()])
    h.enqueue('lead_drip_progress', null)                 // pre-check: never enrolled
    h.enqueue('lead_drip_progress', { id: 'prog-new-1' }) // post-start re-check: seeded
    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.merged).toBe(true)
    expect(body.drip_enrolled).toBe(true)
    expect(startDripForLead).toHaveBeenCalledTimes(1)
    expect(startDripForLead).toHaveBeenCalledWith('lead-A', 'loc-uuid-1')
    expect(sendDripStep).toHaveBeenCalledTimes(1)
  })
})

// ═══ IN QUESTION tier — create + flag, never merge ═════════
describe('intake dedup — IN QUESTION creates and flags', () => {
  it('strong key matching MULTIPLE leads → new row + possible_duplicate_of, NOT merged', async () => {
    h.enqueue('leads', [
      storedLead({ id: 'lead-A' }),
      storedLead({ id: 'lead-B' }),
    ])
    h.enqueue('leads', { id: 'lead-new-1' }) // the insert
    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.merged).toBeUndefined()
    expect(body.lead_id).toBe('lead-new-1')
    expect(body.possible_duplicate_of).toEqual(['lead-A', 'lead-B'])

    const ins = insertPayloads('leads')
    expect(ins).toHaveLength(1)
    expect(ins[0].possible_duplicate_of).toEqual(['lead-A', 'lead-B'])
    expect(ins[0].stage).toBe('New')
    expect(ins[0], 'generated column must never be written').not.toHaveProperty('phone_normalized')
    expect(updatePayloads('leads')).toHaveLength(0) // no merge write

    // Creation touchpoint + the suspected-match one.
    const tps = insertPayloads('touchpoints')
    expect(tps.map(t => t.label)).toEqual([
      'Client created',
      'Possible duplicate — webform matched existing lead(s)',
    ])
    expect(tps[1].notes).toContain('lead-A')
    expect(tps[1].notes).toContain('lead-B')
  })

  it('conflicting signal (email → lead A, phone → lead B) → create + flag both', async () => {
    h.enqueue('leads', [
      storedLead({ id: 'lead-A', email: 'sarah@email.com', phone_normalized: '' }),
      storedLead({ id: 'lead-B', email: 'other@x.com', phone_normalized: '5615550199' }),
    ])
    h.enqueue('leads', { id: 'lead-new-2' })
    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.merged).toBeUndefined()
    expect(new Set(body.possible_duplicate_of)).toEqual(new Set(['lead-A', 'lead-B']))
    expect(insertPayloads('leads')).toHaveLength(1)
  })

  it('name-only match → new row + flagged; NEVER auto-merged on name alone', async () => {
    h.enqueue('leads', []) // strong keys: nothing
    h.enqueue('leads', [{ id: 'lead-N', name: 'Sarah Mitchell' }]) // name query
    h.enqueue('leads', { id: 'lead-new-3' }) // insert
    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.merged).toBeUndefined()
    expect(body.lead_id).toBe('lead-new-3')
    expect(body.possible_duplicate_of).toEqual(['lead-N'])
    expect(insertPayloads('leads')[0].possible_duplicate_of).toEqual(['lead-N'])
    expect(updatePayloads('leads')).toHaveLength(0)

    // Name lookup is scoped + junk-safe: ilike (case-insensitive exact),
    // location-scoped, .not is_junk pattern, .range not bare select.
    const nameCall = callsFor('leads')[1]
    expect(opsOf(nameCall, 'ilike')[0][1]).toEqual(['name', 'Sarah Mitchell'])
    expect(opsOf(nameCall, 'eq')[0][1]).toEqual(['location_uuid', 'loc-uuid-1'])
    expect(opsOf(nameCall, 'not')[0][1]).toEqual(['is_junk', 'is', true])
    expect(opsOf(nameCall, 'range')[0][1]).toEqual([0, 999])
  })
})

// ═══ NO MATCH — unchanged clean insert ═════════════════════
describe('intake dedup — NO MATCH inserts as today', () => {
  it('no email/phone/name hit → clean insert, no flags, no merge writes', async () => {
    h.enqueue('leads', []) // strong keys
    h.enqueue('leads', []) // name
    h.enqueue('leads', { id: 'lead-new-4' })
    const res = await POST(makeReq(submission()))
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.lead_id).toBe('lead-new-4')
    expect(body.merged).toBeUndefined()
    expect(body.possible_duplicate_of).toBeUndefined()

    const ins = insertPayloads('leads')
    expect(ins).toHaveLength(1)
    expect(ins[0]).not.toHaveProperty('possible_duplicate_of')
    expect(ins[0]).not.toHaveProperty('phone_normalized')
    expect(ins[0]).toMatchObject({ stage: 'New', name: 'Sarah Mitchell' })
    expect(updatePayloads('leads')).toHaveLength(0)
  })

  it('the strong-key match read carries the standing NULL-safe patterns', async () => {
    h.enqueue('leads', [])
    h.enqueue('leads', [])
    h.enqueue('leads', { id: 'lead-new-5' })
    await POST(makeReq(submission({ phone: undefined }))) // email-only submission

    const matchCall = callsFor('leads')[0]
    const orArg = opsOf(matchCall, 'or')[0][1][0] as string
    expect(orArg).toBe('email.eq."sarah@email.com"') // no phone key → no phone clause
    expect(orArg).not.toContain('null')
    expect(opsOf(matchCall, 'not')[0][1]).toEqual(['is_junk', 'is', true])
    expect(opsOf(matchCall, 'eq')[0][1]).toEqual(['location_uuid', 'loc-uuid-1'])
    expect(opsOf(matchCall, 'range')[0][1]).toEqual([0, 999])
  })
})

// ═══ classification NULL-safety (pure) ═════════════════════
describe('classifyLeadMatches — NULL-safe tiers', () => {
  it('a lead with NULL email/phone is never spuriously matched', () => {
    const rows = [{ id: 'x', email: null, phone_normalized: null }]
    expect(classifyLeadMatches(rows, { email: 'a@b.com', phone: '' }).tier).toBe('none')
    expect(classifyLeadMatches(rows, { email: 'a@b.com', phone: '5615550199' }).tier).toBe('none')
    // Empty submission keys never match empty stored values either.
    expect(classifyLeadMatches([{ id: 'y', email: '', phone_normalized: '' }], { email: '', phone: '' }).tier).toBe('none')
  })

  it('exactly-one semantics: 1 → solid, >1 → in_question, cross-key conflict → in_question', () => {
    const A = { id: 'A', email: 'a@b.com', phone_normalized: '1112223333' }
    const B = { id: 'B', email: 'a@b.com', phone_normalized: '9998887777' }
    expect(classifyLeadMatches([A], { email: 'a@b.com' })).toMatchObject({ tier: 'solid', matchedOn: 'email' })
    expect(classifyLeadMatches([A], { email: 'a@b.com', phone: '111-222-3333' })).toMatchObject({ tier: 'solid', matchedOn: 'email+phone' })
    expect(classifyLeadMatches([A, B], { email: 'a@b.com' }).tier).toBe('in_question')
    const conflict = classifyLeadMatches([A, B], { email: 'x@y.com', phone: '111-222-3333' })
    expect(conflict.tier).toBe('solid') // only A's phone hits — B is noise
    const realConflict = classifyLeadMatches(
      [{ id: 'A', email: 'a@b.com', phone_normalized: '' }, { id: 'B', email: 'z@z.com', phone_normalized: '1112223333' }],
      { email: 'a@b.com', phone: '1112223333' },
    )
    expect(realConflict).toMatchObject({ tier: 'in_question', reason: 'conflicting_keys' })
  })
})
