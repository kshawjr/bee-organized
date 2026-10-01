// @vitest-environment node
//
// CORPORATE CAN TRANSFER ANY LEAD — not only an unrouted one (1 Oct 2026).
//
// Kim Terry sat at Central Austin with a zip that belongs to Southwest Austin,
// and Kevin had to move her with a database update: the transfer was built to
// empty the unrouted queue, so a lead that already HAD a location could not be
// moved at all. This suite pins POST /api/leads/:id/transfer for that lead:
//
//   · WHO      corporate (admin, super_admin) can; an owner, a manager and a
//              lite user cannot — nothing is written for them
//   · REASON   a lead with a home owes one; it lands on the timeline row
//   · ASSIGNEE cleared — the column AND the lead_assignees rows
//   · TOLD     the destination gets the email, the live broadcast and the
//              "Transferred in" row; the old location's screen is told too
//   · HISTORY  touchpoints, notes and extra contacts follow the lead
//   · DRIP     the old location's stops, the new one's starts — including when
//              both locations use the SAME shared sequence
//   · NOT MOVABLE  a lead that has reached Jobber, or has an engagement, is
//              refused with nothing written (lib/lead-transfer-rule)
//
// beta-lead-transfer-endpoint keeps pinning the unrouted path; its mock is a
// FIFO queue, which cannot express "this table has 2 rows". This one answers
// per table.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Op = { table: string; kind: 'select' | 'update' | 'insert' | 'delete'; arg?: any; filters: any[] }
  const state = {
    role: 'admin' as string,
    lead: null as any,
    dest: null as any,
    origin: { name: 'Central Austin' } as any,
    locationReads: 0,
    counts: {} as Record<string, number>,
    countErrors: {} as Record<string, string>,
    assigneeRows: [] as any[],
    moveResult: [{ id: 'lead-1' }] as any,
    // lead_drip_progress verify answers, consumed in order; last one repeats.
    activeRows: [{ id: 'ldp-1' }] as any[],
    ops: [] as Op[],
  }
  const answer = (op: Op, wantsCount: boolean): any => {
    const t = op.table
    if (op.kind === 'select') {
      if (t === 'hub_users') return { data: { id: 'u-corp', role: state.role, location_id: null }, error: null }
      if (t === 'leads') return { data: state.lead, error: state.lead ? null : { message: 'nope' } }
      // The route reads the DESTINATION first, then the origin's name.
      if (t === 'locations') return { data: state.locationReads++ === 0 ? state.dest : state.origin, error: null }
      if (t === 'lead_drip_progress') {
        const row = state.activeRows.length > 1 ? state.activeRows.shift() : state.activeRows[0]
        return { data: row ?? null, error: null }
      }
      if (wantsCount) {
        if (state.countErrors[t]) return { data: null, count: null, error: { message: state.countErrors[t] } }
        return { data: null, count: state.counts[t] ?? 0, error: null }
      }
      return { data: null, error: null }
    }
    if (op.kind === 'update' && t === 'leads') return { data: state.moveResult, error: null }
    if (op.kind === 'delete' && t === 'lead_assignees') return { data: state.assigneeRows, error: null }
    return { data: null, error: null }
  }
  const from = (table: string) => {
    const op: Op = { table, kind: 'select', filters: [] }
    let wantsCount = false
    let recorded = false
    const record = () => { if (!recorded) { recorded = true; state.ops.push(op) } }
    const b: any = {}
    b.select = (_cols?: any, opts?: any) => { if (opts?.count) wantsCount = true; return b }
    for (const m of ['eq', 'neq', 'is', 'in', 'not', 'or', 'order', 'limit']) {
      b[m] = (...a: any[]) => { op.filters.push([m, ...a]); return b }
    }
    b.update = (arg: any) => { op.kind = 'update'; op.arg = arg; return b }
    b.insert = (arg: any) => { op.kind = 'insert'; op.arg = arg; return b }
    b.delete = () => { op.kind = 'delete'; return b }
    const done = () => { record(); return Promise.resolve(answer(op, wantsCount)) }
    b.single = done
    b.maybeSingle = done
    b.then = (res: any, rej: any) => done().then(res, rej)
    return b
  }
  return { state, from }
})

const authUser = vi.hoisted(() => ({ current: { id: 'u-corp' } as any }))

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.from(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.from(t),
  })),
}))
vi.mock('@/lib/lead-notification-email', () => ({
  notifyNewLead: vi.fn(async () => ({ sent: true, recipientCount: 2 })),
}))
vi.mock('@/lib/notification-recipients', () => ({
  locationHasOperationalStaff: vi.fn(async () => true),
}))
vi.mock('@/lib/drip-lifecycle', () => ({
  stopActiveDripsForLead: vi.fn(async () => {}),
  startDripForLead: vi.fn(async () => ({ enrolled: true })),
}))
vi.mock('@/lib/realtime-broadcast', () => ({
  broadcastLeadMoved: vi.fn(async () => true),
}))

import { POST } from '@/app/api/leads/[id]/transfer/route'
import { notifyNewLead } from '@/lib/lead-notification-email'
import { broadcastLeadMoved } from '@/lib/realtime-broadcast'
import { stopActiveDripsForLead, startDripForLead } from '@/lib/drip-lifecycle'
import {
  canTransferLeads, transferBlockFor, transferNeedsReason, TRANSFER_REASON_MAX,
} from '@/lib/lead-transfer-rule'

// Kim Terry's shape: a website lead at Central Austin, assigned to someone
// there, never sent to Jobber, no engagement.
const HOMED = (over: any = {}) => ({
  id: 'lead-1', name: 'Kim Terry', email: 'kim@email.com', phone: '5125550100',
  project_type: 'Moving', request_details: 'Moving next month', preferred_contact: 'Email',
  zip: '78746',
  location_id: 'loc_centralaustin', location_uuid: 'central-uuid',
  assigned_to: 'central-staff-1',
  jobber_client_id: null, jobber_request_id: null, jobber_quote_id: null, jobber_job_id: null,
  jobber_invoice_id: null, jobber_assessment_id: null, jobber_sync_status: null,
  ...over,
})
const DEST = (over: any = {}) => ({
  id: 'sw-uuid', name: 'Southwest Austin', location_id: 'loc_swaustin', lifecycle_status: 'active', ...over,
})

const call = (body: any, id = 'lead-1') =>
  POST(
    new Request(`http://test/api/leads/${id}/transfer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) as any,
    { params: Promise.resolve({ id }) },
  )
const GOOD = { destination_location_id: 'sw-uuid', reason: 'Zip 78746 belongs to Southwest Austin' }

const writes = () => h.state.ops.filter((o) => o.kind !== 'select')
const writesTo = (table: string, kind?: string) =>
  writes().filter((o) => o.table === table && (!kind || o.kind === kind))

beforeEach(() => {
  authUser.current = { id: 'u-corp' }
  Object.assign(h.state, {
    role: 'admin', lead: HOMED(), dest: DEST(), origin: { name: 'Central Austin' }, locationReads: 0,
    counts: {}, countErrors: {}, assigneeRows: [{ hub_user_id: 'central-staff-1' }],
    moveResult: [{ id: 'lead-1' }], activeRows: [{ id: 'ldp-1' }], ops: [],
  })
  vi.mocked(notifyNewLead).mockClear()
  vi.mocked(broadcastLeadMoved).mockClear()
  vi.mocked(stopActiveDripsForLead).mockClear()
  vi.mocked(startDripForLead).mockClear()
  vi.mocked(startDripForLead).mockResolvedValue({ enrolled: true } as any)
})

// ── WHO ──────────────────────────────────────────────────────────
describe('who may move a lead that already has a location', () => {
  it.each(['admin', 'super_admin'])('corporate (%s) can', async (role) => {
    h.state.role = role
    const res = await call(GOOD)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.from).toEqual({ uuid: 'central-uuid', slug: 'loc_centralaustin' })
    expect(j.to).toMatchObject({ uuid: 'sw-uuid', slug: 'loc_swaustin' })
    const move = writesTo('leads', 'update')[0]
    expect(move.arg).toMatchObject({ location_id: 'loc_swaustin', location_uuid: 'sw-uuid' })
  })

  // THE MUTATION TARGET. Let an owner through the route's gate and this fails.
  it.each(['owner', 'manager', 'lite_user'])('%s cannot — 403, and NOTHING is written or sent', async (role) => {
    h.state.role = role
    const res = await call(GOOD)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_admin_only')
    expect(writes()).toEqual([])
    expect(notifyNewLead).not.toHaveBeenCalled()
    expect(broadcastLeadMoved).not.toHaveBeenCalled()
    expect(startDripForLead).not.toHaveBeenCalled()
  })

  it('an owner cannot move a lead out of THEIR OWN location either', async () => {
    h.state.role = 'owner'
    // The route reads hub_users.location_id; owning the origin grants nothing.
    const res = await call(GOOD)
    expect(res.status).toBe(403)
    expect(writes()).toEqual([])
  })

  it('the rule file agrees with the route', () => {
    expect(canTransferLeads('admin')).toBe(true)
    expect(canTransferLeads('super_admin')).toBe(true)
    for (const r of ['owner', 'manager', 'lite_user', '', null, undefined, 'corporate']) {
      expect(canTransferLeads(r as any)).toBe(false)
    }
  })
})

// ── REASON ───────────────────────────────────────────────────────
describe('a lead with a home owes a reason', () => {
  it.each([undefined, '', '   ', 42])('reason %j → 400 reason_required, nothing written', async (reason) => {
    const res = await call({ destination_location_id: 'sw-uuid', reason })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('reason_required')
    expect(writes()).toEqual([])
  })

  it('an over-long reason is refused, not truncated', async () => {
    const res = await call({ destination_location_id: 'sw-uuid', reason: 'x'.repeat(TRANSFER_REASON_MAX + 1) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('reason_too_long')
    expect(writes()).toEqual([])
  })

  it('who moved it and why are recorded on the timeline row', async () => {
    const res = await call({ ...GOOD, reason: `  ${GOOD.reason}  ` })
    const tp = writesTo('touchpoints', 'insert')[0]
    expect(tp.arg).toMatchObject({
      lead_id: 'lead-1', kind: 'system', label: 'Transferred in',
      location_uuid: 'sw-uuid', user_id: 'u-corp',
      notes: 'Moved from Central Austin to Southwest Austin. Reason: Zip 78746 belongs to Southwest Austin',
    })
    expect((await res.json()).reason).toBe(GOOD.reason)
  })

  it('an UNROUTED lead still needs none, and keeps its old wording', async () => {
    h.state.lead = HOMED({ location_id: 'loc_other', location_uuid: 'other-uuid', assigned_to: null })
    const res = await call({ destination_location_id: 'sw-uuid' })
    expect(res.status).toBe(200)
    expect(writesTo('touchpoints', 'insert')[0].arg.notes).toBe('Routed from loc_other to Southwest Austin')
    expect((await res.json()).reason).toBeUndefined()
  })

  it('transferNeedsReason: every real location, never the unrouted pen', () => {
    expect(transferNeedsReason('loc_centralaustin')).toBe(true)
    expect(transferNeedsReason('loc_other')).toBe(false)
    expect(transferNeedsReason(null)).toBe(false)
  })
})

// ── ASSIGNEE ─────────────────────────────────────────────────────
describe('the assignee is cleared', () => {
  it('leads.assigned_to is nulled in the SAME write that moves the lead', async () => {
    await call(GOOD)
    const move = writesTo('leads', 'update')
    expect(move).toHaveLength(1)
    expect(move[0].arg.assigned_to).toBeNull()
    expect(move[0].arg.location_uuid).toBe('sw-uuid')
  })

  it('the lead_assignees rows go too — the column alone leaves the old person assigned', async () => {
    h.state.assigneeRows = [{ hub_user_id: 'central-staff-1' }, { hub_user_id: 'central-staff-2' }]
    const res = await call(GOOD)
    const del = writesTo('lead_assignees', 'delete')
    expect(del).toHaveLength(1)
    expect(del[0].filters).toContainEqual(['eq', 'lead_id', 'lead-1'])
    expect((await res.json()).assignees_cleared).toBe(2)
  })
})

// ── TOLD ─────────────────────────────────────────────────────────
describe('the destination is told', () => {
  it('email to the DESTINATION, a live broadcast naming BOTH ends, and the timeline row', async () => {
    const res = await call(GOOD)
    expect(notifyNewLead).toHaveBeenCalledTimes(1)
    expect(notifyNewLead).toHaveBeenCalledWith(expect.objectContaining({
      location: { id: 'sw-uuid', name: 'Southwest Austin' },
      locationSlug: 'loc_swaustin',
      lead: expect.objectContaining({ id: 'lead-1', name: 'Kim Terry', zip: '78746' }),
    }))
    // 3f0ebf8: the receiving Inbox learns of a transfer ONLY from this. The
    // origin is a real location here, so its open screens drop the card too.
    expect(broadcastLeadMoved).toHaveBeenCalledWith({
      leadId: 'lead-1', fromLocationUuid: 'central-uuid', toLocationUuid: 'sw-uuid',
    })
    const j = await res.json()
    expect(j.notified).toBe(2)
    expect(j.warnings).toBeUndefined()
  })

  it('the Inbox holds are cleared so it arrives visible', async () => {
    await call(GOOD)
    expect(writesTo('leads', 'update')[0].arg).toMatchObject({ inbox_dismissed_at: null, snoozed_until: null })
  })
})

// ── HISTORY ──────────────────────────────────────────────────────
describe("the lead's history follows it", () => {
  it('touchpoints, notes and extra contacts are re-homed to the destination', async () => {
    await call(GOOD)
    for (const table of ['touchpoints', 'lead_notes', 'lead_contacts']) {
      const up = writesTo(table, 'update')
      expect(up, table).toHaveLength(1)
      expect(up[0].arg).toEqual({ location_uuid: 'sw-uuid' })
      expect(up[0].filters).toContainEqual(['eq', 'lead_id', 'lead-1'])
    }
  })

  it('nothing is carried before the move has landed', async () => {
    await call(GOOD)
    const order = writes().map((o) => `${o.kind}:${o.table}`)
    expect(order.indexOf('update:leads')).toBe(0)
    expect(order.indexOf('update:touchpoints')).toBeLessThan(order.indexOf('insert:touchpoints'))
  })
})

// ── DRIP ─────────────────────────────────────────────────────────
describe('the drip', () => {
  it("the old location's stops FIRST, then the destination's starts", async () => {
    const res = await call(GOOD)
    expect(stopActiveDripsForLead).toHaveBeenCalledTimes(1)
    expect(startDripForLead).toHaveBeenCalledTimes(1)
    expect(startDripForLead).toHaveBeenCalledWith('lead-1', 'sw-uuid')
    expect(vi.mocked(stopActiveDripsForLead).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(startDripForLead).mock.invocationCallOrder[0])
    expect((await res.json()).drip_enrolled).toBe(true)
  })

  it('SAME shared sequence at both locations: the stopped row is cleared and it starts again', async () => {
    // The start collides with the row just stopped: it reports enrolled and
    // leaves nothing running. First verify finds nothing; second finds a row.
    h.state.activeRows = [null, { id: 'ldp-fresh' }]
    const res = await call(GOOD)
    expect(writesTo('lead_drip_progress', 'delete')).toHaveLength(1)
    expect(startDripForLead).toHaveBeenCalledTimes(2)
    const j = await res.json()
    expect(j.drip_enrolled).toBe(true)
    expect(j.warnings).toBeUndefined()
  })

  it('a lead that may NOT be emailed is not force-started — and the reason is said', async () => {
    vi.mocked(startDripForLead).mockResolvedValue({ enrolled: false, reason: 'opted_out' } as any)
    h.state.activeRows = [null]
    const res = await call(GOOD)
    expect(writesTo('lead_drip_progress', 'delete')).toHaveLength(0)
    expect(startDripForLead).toHaveBeenCalledTimes(1)
    const j = await res.json()
    expect(j.drip_enrolled).toBe(false)
    expect(j.warnings).toContain('drip_not_enrolled_after_start: opted_out')
  })

  it('a destination that is not live gets the lead and the email, no drip', async () => {
    h.state.dest = DEST({ lifecycle_status: 'onboarding' })
    const res = await call(GOOD)
    expect(res.status).toBe(200)
    expect(startDripForLead).not.toHaveBeenCalled()
    expect(notifyNewLead).toHaveBeenCalledTimes(1)
    expect((await res.json()).drip_skipped_reason).toBe('destination_not_active')
  })
})

// ── NOT MOVABLE ──────────────────────────────────────────────────
describe('a lead that has reached Jobber cannot be moved', () => {
  const refused = async (code: string) => {
    const res = await call(GOOD)
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.error).toBe(code)
    expect(typeof j.detail).toBe('string')
    expect(writes()).toEqual([])
    expect(notifyNewLead).not.toHaveBeenCalled()
    expect(broadcastLeadMoved).not.toHaveBeenCalled()
    expect(stopActiveDripsForLead).not.toHaveBeenCalled()
  }

  it.each([
    ['a Jobber client id', { jobber_client_id: 'Z2lkOi8vSm9iYmVyL0NsaWVudC8x' }],
    ['a Jobber request id', { jobber_request_id: 'req-1' }],
    ['a Jobber quote id', { jobber_quote_id: 'q-1' }],
    ['a Jobber job id', { jobber_job_id: 'job-1' }],
    ['a Jobber invoice id', { jobber_invoice_id: 'inv-1' }],
    ['a recorded send with no client id', { jobber_sync_status: 'Success: Request — 2026-10-01T01:05:05' }],
  ])('%s on the lead → 409 lead_in_jobber, nothing written', async (_label, over) => {
    h.state.lead = HOMED(over)
    await refused('lead_in_jobber')
  })

  it.each(['service_requests', 'quotes', 'jobs', 'invoices', 'assessments', 'payments'])(
    'a %s row for the lead → 409 lead_in_jobber, nothing written', async (table) => {
      h.state.counts = { [table]: 1 }
      await refused('lead_in_jobber')
    })

  it('holds for an UNROUTED lead too — the queue is no safer a place to move it from', async () => {
    h.state.lead = HOMED({ location_id: 'loc_other', location_uuid: 'other-uuid', jobber_client_id: 'c-1' })
    await refused('lead_in_jobber')
  })

  it('the write itself refuses a lead that gained a client id after the check', async () => {
    h.state.moveResult = []   // .is('jobber_client_id', null) matched no row
    const res = await call(GOOD)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('lead_changed')
    expect(writesTo('leads', 'update')[0].filters).toContainEqual(['is', 'jobber_client_id', null])
    expect(writesTo('lead_assignees')).toEqual([])
    expect(notifyNewLead).not.toHaveBeenCalled()
  })
})

describe('a lead with an engagement cannot be moved', () => {
  it.each([1, 3])('%i engagement(s), open or closed → 409 lead_has_engagement, nothing written', async (n) => {
    h.state.counts = { engagements: n }
    const res = await call(GOOD)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('lead_has_engagement')
    expect(writes()).toEqual([])
    expect(notifyNewLead).not.toHaveBeenCalled()
    expect(broadcastLeadMoved).not.toHaveBeenCalled()
  })

  it('in Jobber AND an engagement → says Jobber, the harder fact', () => {
    expect(transferBlockFor({ inJobber: true, engagementCount: 2 })).toBe('in_jobber')
    expect(transferBlockFor({ inJobber: false, engagementCount: 2 })).toBe('has_engagement')
    expect(transferBlockFor({ inJobber: false, engagementCount: 0 })).toBeNull()
  })

  it('FAILS CLOSED — a check that cannot be read refuses the move', async () => {
    h.state.countErrors = { engagements: 'timeout' }
    const res = await call(GOOD)
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('transfer_check_failed')
    expect(writes()).toEqual([])
  })
})

describe('unchanged refusals', () => {
  it('the same location it is already at → 400, nothing written', async () => {
    h.state.dest = DEST({ id: 'central-uuid', location_id: 'loc_centralaustin', name: 'Central Austin' })
    const res = await call({ ...GOOD, destination_location_id: 'central-uuid' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('already_at_destination')
    expect(writes()).toEqual([])
  })

  it('a real lead cannot be sent BACK to the unrouted pen', async () => {
    h.state.dest = DEST({ id: 'other-uuid', location_id: 'loc_other', name: 'Unassigned' })
    const res = await call({ ...GOOD, destination_location_id: 'other-uuid' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('cannot_transfer_to_loc_other')
    expect(writes()).toEqual([])
  })
})
