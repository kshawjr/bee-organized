// @vitest-environment node
//
// A returning client must not become a second record when a lead is
// transferred (22 Oct 2026). Shirley Ann Morgan came in on the general form,
// landed in Other on 12 Oct, and the move into Central Denver on 13 Oct made a
// second record there — her Jobber-imported one (same email, same phone) was
// never looked at. lib/lead-transfer now runs intake's own match at the
// DESTINATION before moving:
//   • one clear match by email or phone at that location → the enquiry is
//     attached to that record as a resubmission (lib/enquiry-resubmission) and
//     the waiting copy is binned, flagged — no move, no second record;
//   • email ignores case and surrounding spaces; phone ignores formatting;
//   • a name alone never matches;
//   • a match at ANY OTHER location is not a match;
//   • an ambiguous match moves as before, flagged possible_duplicate_of.
//
// The fake database answers the match read the way PostgREST would: it
// honours the location filter and the .or() clauses clientMatch builds
// (email ilike / eq, phone_normalized in), so the matching itself is the real
// clientMatch code, not a stub.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Op = { table: string; kind: 'select' | 'update' | 'insert' | 'delete'; arg?: any; filters: any[] }
  const state = {
    lead: null as any,
    dest: null as any,
    // Every leads row the match read can see (any location).
    people: [] as any[],
    ops: [] as Op[],
  }
  const unq = (s: string) => s.replace(/^"|"$/g, '')
  // The .or() clauses clientMatch builds, applied to one row.
  const orHit = (row: any, or: string) => or.split(/,(?=email\.|phone_normalized\.)/).some((clause) => {
    let m = clause.match(/^email\.ilike\.(".*")$/)
    if (m) return (row.email || '').toLowerCase() === unq(m[1]).replace(/\\\\_/g, '_').toLowerCase()
    m = clause.match(/^email\.eq\.(".*")$/)
    if (m) return row.email === unq(m[1])
    m = clause.match(/^phone_normalized\.in\.\((.*)\)$/)
    if (m) return m[1].split(',').map(unq).includes(row.phone_normalized)
    m = clause.match(/^phone_normalized\.eq\.(".*")$/)
    if (m) return row.phone_normalized === unq(m[1])
    throw new Error(`fake db: unknown clause ${clause}`)
  })
  const answer = (op: Op, wantsCount: boolean): any => {
    const t = op.table
    if (op.kind === 'select') {
      if (t === 'hub_users') return { data: { id: 'u-leslie', role: 'admin', location_id: null }, error: null }
      if (t === 'leads') {
        const or = op.filters.find((f) => f[0] === 'or')
        if (!or) return { data: state.lead, error: null }
        const loc = op.filters.find((f) => f[0] === 'eq' && f[1] === 'location_uuid')
        const rows = state.people
          .filter((r) => r.is_junk !== true)
          .filter((r) => !loc || r.location_uuid === loc[2])
          .filter((r) => orHit(r, or[1]))
        return { data: rows, error: null }
      }
      if (t === 'locations') return { data: state.dest, error: null }
      if (wantsCount) return { data: null, count: 0, error: null }
      return { data: null, error: null }
    }
    if (op.kind === 'update' && t === 'leads') return { data: [{ id: state.lead.id }], error: null }
    return { data: null, error: null }
  }
  const from = (table: string) => {
    const op: Op = { table, kind: 'select', filters: [] }
    let wantsCount = false
    const b: any = {}
    b.select = (_c?: any, o?: any) => { if (o?.count) wantsCount = true; return b }
    for (const m of ['eq', 'neq', 'is', 'in', 'not', 'or', 'order', 'limit', 'range']) {
      b[m] = (...a: any[]) => { op.filters.push([m, ...a]); return b }
    }
    b.update = (arg: any) => { op.kind = 'update'; op.arg = arg; return b }
    b.insert = (arg: any) => { op.kind = 'insert'; op.arg = arg; return b }
    b.delete = () => { op.kind = 'delete'; return b }
    const done = () => { state.ops.push(op); return Promise.resolve(answer(op, wantsCount)) }
    b.single = done
    b.maybeSingle = done
    b.then = (res: any, rej: any) => done().then(res, rej)
    return b
  }
  return { state, from }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.from(t) } }))
vi.mock('@/lib/lead-notification-email', () => ({ notifyNewLead: vi.fn(async () => ({ sent: true, recipientCount: 1 })) }))
vi.mock('@/lib/notification-recipients', () => ({ locationHasOperationalStaff: vi.fn(async () => false) }))
vi.mock('@/lib/drip-lifecycle', () => ({ stopActiveDripsForLead: vi.fn(async () => {}), startDripForLead: vi.fn(async () => {}) }))
vi.mock('@/lib/slack-bot', () => ({ notifyNewLeadSlack: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/notification-log', () => ({ logSlackNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/realtime-broadcast', () => ({ broadcastLeadMoved: vi.fn(async () => true) }))
vi.mock('@/lib/other-card-sync', async (orig) => {
  const real: any = await orig()
  return { ...real, retireOtherCards: vi.fn(async () => ({ edited: 1, failed: 0 })), actorName: vi.fn(async () => 'Leslie Mullins') }
})
// The attach itself is intake's resubmission, pinned by the intake suites;
// here it is the hand-off that matters.
vi.mock('@/lib/enquiry-resubmission', () => ({
  attachResubmission: vi.fn(async () => ({
    engagementId: 'eng-1', engagementFounded: false, foundingSkipped: null, returningDrip: 'skipped:not_founded',
    dripEnrolled: false, dripSkippedReason: null, assignedCount: 1, assignmentBasis: 'existing',
    notifiedCount: 2, notificationsMuted: false, warnings: [],
  })),
}))

import { transferLead } from '@/lib/lead-transfer'
import { attachResubmission } from '@/lib/enquiry-resubmission'
import { notifyNewLead } from '@/lib/lead-notification-email'
import { stopActiveDripsForLead } from '@/lib/drip-lifecycle'
import { retireOtherCards } from '@/lib/other-card-sync'

const DENVER = 'central-denver-uuid'
const SOUTH = 'denver-south-uuid'

// The copy waiting in Other — what the general form made on 12 Oct.
const WAITING = (over: any = {}) => ({
  id: 'dup-2de9', name: 'Shirley Ann Morgan', email: 'smorganwre@yahoo.com', phone: '702-764-9862',
  project_type: 'Organizing', request_details: 'Garage again please', preferred_contact: 'Email', source: 'Website',
  address: null, city: 'Denver', state: 'CO', zip: '80202',
  location_id: 'loc_other', location_uuid: 'other-uuid', jobber_client_id: null, possible_duplicate_of: null,
  ...over,
})
// Her real record — the Jobber-imported client at Central Denver.
const REAL = (over: any = {}) => ({
  id: 'real-072e', name: 'Shirley Ann Morgan', email: 'smorganwre@yahoo.com', phone: '(702) 764-9862',
  phone_normalized: '7027649862', stage: 'Closed Won', location_uuid: DENVER, jobber_client_id: '146257602',
  ...over,
})

const run = () => transferLead({ leadId: 'dup-2de9', destinationLocationId: DENVER, reason: null, actor: { hubUserId: 'u-leslie', role: 'admin' } })
const leadUpdates = () => h.state.ops.filter((o) => o.table === 'leads' && o.kind === 'update').map((o) => o.arg)
const moved = () => leadUpdates().some((a) => 'location_uuid' in a)

beforeEach(() => {
  vi.clearAllMocks()
  h.state.ops = []
  h.state.lead = WAITING()
  h.state.dest = { id: DENVER, name: 'Central Denver', location_id: 'loc_centraldenver', lifecycle_status: 'active' }
  h.state.people = [REAL()]
})

describe('a transferred-in enquiry from someone already a client there', () => {
  it('matching by EMAIL attaches to their record — no move, no second record', async () => {
    h.state.people = [REAL({ phone: null, phone_normalized: null })]
    const out = await run()
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ success: true, lead_id: 'dup-2de9', attached_to: 'real-072e', matched_on: 'email' })
    expect(moved()).toBe(false)
    expect(attachResubmission).toHaveBeenCalledTimes(1)
    const a = vi.mocked(attachResubmission).mock.calls[0][0]
    expect(a.matched.id).toBe('real-072e')
    expect(a.location).toMatchObject({ id: DENVER, name: 'Central Denver' })
    expect(a.submission).toMatchObject({ email: 'smorganwre@yahoo.com', message: 'Garage again please' })
    expect(a.via).toBe('transferred from Other')
    // Not announced as a NEW lead — the attach says "returning client".
    expect(notifyNewLead).not.toHaveBeenCalled()
  })

  it('matching by PHONE attaches the same way, whatever the formatting', async () => {
    h.state.lead = WAITING({ email: 'shirley.new@gmail.com', phone: '+1 (702) 764 9862' })
    const out = await run()
    expect(out.body).toMatchObject({ attached_to: 'real-072e', matched_on: 'phone' })
    expect(moved()).toBe(false)
    expect(attachResubmission).toHaveBeenCalledTimes(1)
  })

  it('email ignores case and surrounding spaces — on either side', async () => {
    h.state.lead = WAITING({ email: '  SMorganWRE@Yahoo.COM ', phone: null })
    h.state.people = [REAL({ email: 'SMorganWre@yahoo.com', phone: null, phone_normalized: null })]
    const out = await run()
    expect(out.body).toMatchObject({ attached_to: 'real-072e', matched_on: 'email' })
    expect(moved()).toBe(false)
  })

  it('the waiting copy is binned and flagged, never deleted; its drip and Other card are retired', async () => {
    h.state.lead = WAITING({ possible_duplicate_of: ['older-1'] })
    await run()
    const bin = leadUpdates()
    expect(bin).toHaveLength(1)
    expect(bin[0]).toMatchObject({ is_junk: true })
    // JSONB array of ids — appended to, not replaced.
    expect(bin[0].possible_duplicate_of).toEqual(['older-1', 'real-072e'])
    expect(h.state.ops.some((o) => o.kind === 'delete' && o.table === 'leads')).toBe(false)
    expect(stopActiveDripsForLead).toHaveBeenCalledWith('dup-2de9', 'junk')
    expect(retireOtherCards).toHaveBeenCalledWith(expect.objectContaining({ leadId: 'dup-2de9', resolution: 'binned' }))
    const tp = h.state.ops.find((o) => o.table === 'touchpoints' && o.kind === 'insert')
    expect(tp?.arg).toMatchObject({ lead_id: 'dup-2de9', label: 'Already a client — added to their record' })
  })
})

describe('what is NOT a returning client', () => {
  it('same name, different email and phone → their own record, moved as before', async () => {
    h.state.people = [REAL({ email: 'someone.else@aol.com', phone: '3035550100', phone_normalized: '3035550100' })]
    const out = await run()
    expect(out.status).toBe(200)
    expect(out.body.attached_to).toBeUndefined()
    expect(moved()).toBe(true)
    expect(attachResubmission).not.toHaveBeenCalled()
    // A name alone does not even flag.
    expect(leadUpdates()[0].possible_duplicate_of).toBeUndefined()
  })

  it('a match at a DIFFERENT location never attaches across locations', async () => {
    h.state.people = [REAL({ location_uuid: SOUTH })]
    const out = await run()
    expect(out.body.attached_to).toBeUndefined()
    expect(moved()).toBe(true)
    expect(attachResubmission).not.toHaveBeenCalled()
    expect(leadUpdates()[0]).toMatchObject({ location_uuid: DENVER })
  })

  it('ambiguous at the destination (two people share the phone) → moved, flagged with both', async () => {
    h.state.lead = WAITING({ email: null })
    h.state.people = [REAL({ email: null }), REAL({ id: 'spouse-9', name: 'Dale Morgan', email: null })]
    const out = await run()
    expect(out.body.attached_to).toBeUndefined()
    expect(moved()).toBe(true)
    expect(leadUpdates()[0].possible_duplicate_of).toEqual(['real-072e', 'spouse-9'])
  })
})
