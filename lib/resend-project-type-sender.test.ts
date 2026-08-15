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
// A HANDLER row (issue 246 step 2): it carries the type it handles and the
// person who handles it, because the same row now decides the assignee too.
const movingSender = {
  project_type: 'Local Move',
  sender_name: 'Bree Mover',
  sender_email: 'bree@boulder.beeorganized.com',
  sender_reply_to: 'bree-reply@boulder.beeorganized.com',
  source_user_id: 'u-bree',
}
const VOCAB = [
  { label: 'Local Move', sort_order: 10, attrs: { drip_category: 'move' } },
  { label: 'Estate Cleanout', sort_order: 20, attrs: { drip_category: 'general' } },
]
const BREE = [{ id: 'u-bree', is_active: true, disabled_at: null }]
const sendArgs = { locationId: LOC_ID, to: 'sarah@email.com', subject: 'Hi', html: '<p>hi</p>', text: 'hi' }

// Enqueue the base-sender lookup, then the vocabulary the canonicalizer reads.
// There is no split-enabled gate any more (issue 246 step 2) — "no handler row"
// is the off state.
const enqueueBase = () => h.enqueue('locations', base)
const enqueueVocab = () => h.enqueue('lookups', VOCAB)

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('sendEmail — per-project-type sender', () => {
  it('a handler for the type → sends AS them, with no flag involved', async () => {
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', [movingSender])
    h.enqueue('hub_users', BREE)

    const res = await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(res).toEqual({ success: true, id: 're-1' })
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: 'Bree Mover <bree@boulder.beeorganized.com>',
      replyTo: 'bree-reply@boulder.beeorganized.com',
    })
  })

  it('handler with null reply-to → reply-to falls back to base', async () => {
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', [{ ...movingSender, sender_reply_to: null }])
    h.enqueue('hub_users', BREE)

    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: 'Bree Mover <bree@boulder.beeorganized.com>',
      replyTo: base.reply_to_email,
    })
  })

  it('no handler for the type → base sender, still sends', async () => {
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', []) // no handler rows

    const res = await sendEmail({ ...sendArgs, senderProjectType: 'Estate Cleanout' })

    expect(res).toEqual({ success: true, id: 're-1' })
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: `${base.sender_name} <${base.send_from_email}>`,
    })
  })

  it('a DISABLED handler → base sender, never sends as an offboarded person', async () => {
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', [movingSender])
    h.enqueue('hub_users', [{ id: 'u-bree', is_active: true, disabled_at: '2026-08-01T00:00:00Z' }])

    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: `${base.sender_name} <${base.send_from_email}>`,
    })
  })

  it('a project type that canonicalizes to NOTHING → base sender', async () => {
    // 'Client' — 53 real leads carry it; it is not a project type at all.
    enqueueBase(); enqueueVocab()

    const res = await sendEmail({ ...sendArgs, senderProjectType: 'Client' })

    expect(res).toEqual({ success: true, id: 're-1' })
    expect(h.callsFor('location_project_type_senders')).toHaveLength(0)
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ from: `${base.sender_name} <${base.send_from_email}>` })
  })

  it('a CASE-VARIANT project type still finds the handler — one matching rule', async () => {
    // The send path used to do .eq('project_type', raw): exact and
    // case-sensitive, while assignment canonicalized. Same table, same
    // question, two answers — so a lead could be assigned to Bree and still
    // send as the location default.
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', [movingSender])
    h.enqueue('hub_users', BREE)

    await sendEmail({ ...sendArgs, senderProjectType: '  local MOVE ' })

    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: 'Bree Mover <bree@boulder.beeorganized.com>',
    })
  })

  it('migration not run — assignments table errors → base sender, never drops', async () => {
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', null, { message: 'relation "location_project_type_senders" does not exist' })

    const res = await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(res).toEqual({ success: true, id: 're-1' })
    expect(sendSpy.mock.calls[0][0]).toMatchObject({ from: `${base.sender_name} <${base.send_from_email}>` })
  })

  it('one person handling MULTIPLE types → every type routes to them', async () => {
    // Lynette's real shape at loc_kc: three of the four types.
    const both = [
      movingSender,
      { ...movingSender, project_type: 'Estate Cleanout' },
    ]
    // Type A
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', both)
    h.enqueue('hub_users', BREE)
    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })
    // Type B → same person, second handler row
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', both)
    h.enqueue('hub_users', BREE)
    await sendEmail({ ...sendArgs, senderProjectType: 'Estate Cleanout' })

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
