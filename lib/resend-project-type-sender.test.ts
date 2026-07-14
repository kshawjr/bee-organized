// @vitest-environment node
//
// Per-project-type SENDER resolution + never-drop fallback (resend layer).
//
// sendEmail() sends a location's drips from its base sender trio. When called
// with senderProjectType AND the location has split_senders_enabled + an
// assignment for that type, it sends AS that assigned sender (name/reply-to
// fall back to base individually). Otherwise → base sender.
//
// NEVER-DROP GUARD: a drip must send even when the split is off, the type is
// unassigned, or the table/column doesn't exist yet (migration not run — the
// resolver swallows the "does not exist" error and uses the base sender). B2
// notifications / unassigned drips (no senderProjectType) never touch the
// override lookups at all.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'is', 'in', 'limit', 'order']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const callsFor = (t: string) => state.calls.filter(c => c.table === t)
  return { state, reset, enqueue, makeBuilder, callsFor }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))

const sendSpy = vi.hoisted(() => vi.fn(async () => ({ data: { id: 're-1' }, error: null })))
vi.mock('resend', () => ({
  Resend: class { emails = { send: sendSpy } },
}))

import { sendEmail } from '@/lib/resend'

const LOC_ID = 'loc-uuid-1'
const base = {
  send_from_email: 'org@boulder.beeorganized.com',
  sender_name: 'Bee Organized Boulder',
  reply_to_email: 'reply@boulder.beeorganized.com',
}
const movingSender = {
  sender_name: 'Bree Mover',
  sender_email: 'bree@boulder.beeorganized.com',
  sender_reply_to: 'bree-reply@boulder.beeorganized.com',
}
const sendArgs = { locationId: LOC_ID, to: 'sarah@email.com', subject: 'Hi', html: '<p>hi</p>', text: 'hi' }

// Enqueue the base-sender lookup + (optionally) the split-enabled gate.
const enqueueBase = () => h.enqueue('locations', base)
const enqueueEnabled = (enabled: boolean) => h.enqueue('locations', { split_senders_enabled: enabled })

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('sendEmail — per-project-type sender', () => {
  it('enabled + type assigned → sends AS the assigned sender', async () => {
    enqueueBase(); enqueueEnabled(true)
    h.enqueue('location_project_type_senders', movingSender)

    const res = await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(res).toEqual({ success: true, id: 're-1' })
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: 'Bree Mover <bree@boulder.beeorganized.com>',
      replyTo: 'bree-reply@boulder.beeorganized.com',
    })
  })

  it('assigned sender with null reply-to → reply-to falls back to base', async () => {
    enqueueBase(); enqueueEnabled(true)
    h.enqueue('location_project_type_senders', { ...movingSender, sender_reply_to: null })

    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: 'Bree Mover <bree@boulder.beeorganized.com>',
      replyTo: base.reply_to_email,
    })
  })

  it('enabled + type UNASSIGNED → base sender, still sends', async () => {
    enqueueBase(); enqueueEnabled(true)
    h.enqueue('location_project_type_senders', null) // no row for this type

    const res = await sendEmail({ ...sendArgs, senderProjectType: 'Estate Cleanout' })

    expect(res).toEqual({ success: true, id: 're-1' })
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: `${base.sender_name} <${base.send_from_email}>`,
    })
  })

  it('split DISABLED → base sender, assignments table NOT queried', async () => {
    enqueueBase(); enqueueEnabled(false)

    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(h.callsFor('location_project_type_senders')).toHaveLength(0)
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: `${base.sender_name} <${base.send_from_email}>`,
    })
  })

  it('migration not run — split_senders_enabled column errors → base sender, never drops', async () => {
    enqueueBase()
    h.enqueue('locations', null, { message: 'column locations.split_senders_enabled does not exist' })

    const res = await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(res).toEqual({ success: true, id: 're-1' })
    expect(h.callsFor('location_project_type_senders')).toHaveLength(0)
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ from: `${base.sender_name} <${base.send_from_email}>` })
  })

  it('migration not run — assignments table errors → base sender, never drops', async () => {
    enqueueBase(); enqueueEnabled(true)
    h.enqueue('location_project_type_senders', null, { message: 'relation "location_project_type_senders" does not exist' })

    const res = await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(res).toEqual({ success: true, id: 're-1' })
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ from: `${base.sender_name} <${base.send_from_email}>` })
  })

  it('one person assigned MULTIPLE types → every type routes to them', async () => {
    // Type A
    enqueueBase(); enqueueEnabled(true)
    h.enqueue('location_project_type_senders', movingSender)
    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })
    // Type B → same sender row
    enqueueBase(); enqueueEnabled(true)
    h.enqueue('location_project_type_senders', movingSender)
    await sendEmail({ ...sendArgs, senderProjectType: 'Long-Distance Move' })

    expect(sendSpy).toHaveBeenCalledTimes(2)
    for (const call of sendSpy.mock.calls) {
      expect(call[0]).toMatchObject({ from: 'Bree Mover <bree@boulder.beeorganized.com>' })
    }
  })

  it('no senderProjectType (B2 / welcome / stage) → base sender, no override lookup', async () => {
    enqueueBase()

    await sendEmail(sendArgs)

    expect(h.callsFor('locations')).toHaveLength(1) // only the base lookup
    expect(h.callsFor('location_project_type_senders')).toHaveLength(0)
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ from: `${base.sender_name} <${base.send_from_email}>` })
  })

  it('missing base sender config → error unchanged, no override lookup', async () => {
    h.enqueue('locations', { send_from_email: null, sender_name: null, reply_to_email: null })

    const res = await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(res.success).toBe(false)
    expect(sendSpy).not.toHaveBeenCalled()
    expect(h.callsFor('locations')).toHaveLength(1)
  })
})
