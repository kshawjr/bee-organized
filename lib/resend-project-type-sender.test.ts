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

  it('PERSON MODE with no reply-to → replies go to THAT PERSON, not the location', async () => {
    // Kevin, 2026-09-03: if an email sends as someone, replies come back to
    // them. Before this, a person-mode row (which never stores a reply-to)
    // fell back to the location's reply_to_email — so every Moving email at
    // loc_kc said "From: Carol Kern" and every reply landed with Lynette.
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', [{ ...movingSender, sender_reply_to: null, sender_is_custom: false }])
    h.enqueue('hub_users', BREE)

    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: 'Bree Mover <bree@boulder.beeorganized.com>',
      replyTo: 'bree@boulder.beeorganized.com',
    })
    expect(sendSpy.mock.calls[0][0].replyTo).not.toBe(base.reply_to_email)
  })

  it('a person-mode row whose sender_is_custom column is absent (pre-296 shape) is still person mode', async () => {
    enqueueBase(); enqueueVocab()
    const { sender_reply_to: _drop, ...noReplyTo } = movingSender
    h.enqueue('location_project_type_senders', [noReplyTo])
    h.enqueue('hub_users', BREE)

    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(sendSpy.mock.calls[0][0].replyTo).toBe('bree@boulder.beeorganized.com')
  })

  it('a location with NO per-type sender behaves exactly as today — base From AND base reply-to', async () => {
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', [])

    const res = await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(res).toEqual({ success: true, id: 're-1' })
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: `${base.sender_name} <${base.send_from_email}>`,
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

// ─── issue 296 · WHAT A JOB TYPE SENDS AS ────────────────────────────────────
//
// A row's identity used to be, by convention, a copy of its handler's hub_users
// record. sender_is_custom lets it be a hand-typed one instead — a shared
// mailbox — with its own reply-to, while source_user_id still names the person
// who HANDLES the type. These pin the two facts staying apart on the send path.
//
// Real shape being modelled: loc_kc's Moving/Relocation is handled by Carol but
// should send from moving@beeorganized-kc.com, with replies reaching Carol. Six
// of the twenty configured locations already do this at LOCATION level, and
// loc_lakenorman runs exactly this From/Reply-To split today.
describe('sendEmail — a typed sending identity (issue 296)', () => {
  const groupInbox = {
    project_type: 'Local Move',
    sender_name: 'Bee Organized Moving',
    sender_email: 'moving@boulder.beeorganized.com',
    sender_reply_to: 'bree@boulder.beeorganized.com',
    sender_is_custom: true,
    source_user_id: 'u-bree',
  }

  it('person mode sends as the handler, exactly as before', async () => {
    // The default, stated explicitly rather than left to the absence of a flag.
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', [{ ...movingSender, sender_is_custom: false }])
    h.enqueue('hub_users', BREE)

    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: 'Bree Mover <bree@boulder.beeorganized.com>',
      replyTo: 'bree-reply@boulder.beeorganized.com',
    })
  })

  it('typed mode sends as the typed name and address, not the handler', async () => {
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', [groupInbox])
    h.enqueue('hub_users', BREE)

    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: 'Bee Organized Moving <moving@boulder.beeorganized.com>',
    })
  })

  it("typed mode's reply-to reaches the person, NOT the location default", async () => {
    // The whole reason sender_reply_to had to become writable. Before issue 296
    // every row's reply_to was null, so replies to Carol's moving emails went to
    // the location's reply_to_email — Lynette — which is live and wrong.
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', [groupInbox])
    h.enqueue('hub_users', BREE)

    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      replyTo: 'bree@boulder.beeorganized.com',
    })
    expect(sendSpy.mock.calls[0][0].replyTo).not.toBe(base.reply_to_email)
  })

  it('a typed reply-to left blank still falls back to the location default', async () => {
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', [{ ...groupInbox, sender_reply_to: null }])
    h.enqueue('hub_users', BREE)

    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: 'Bee Organized Moving <moving@boulder.beeorganized.com>',
      replyTo: base.reply_to_email,
    })
  })

  // ── THE LIVENESS SPLIT ────────────────────────────────────────────────────
  // A shared mailbox has no liveness to lose. Dropping the row when its handler
  // is offboarded would silently revert a location's group-inbox mail to the
  // base sender on the day someone leaves — a config change nobody made.
  it('a DISABLED handler does NOT drop a typed sender — the mailbox survives', async () => {
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', [groupInbox])
    h.enqueue('hub_users', [{ id: 'u-bree', is_active: true, disabled_at: '2026-08-01T00:00:00Z' }])

    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: 'Bee Organized Moving <moving@boulder.beeorganized.com>',
      replyTo: 'bree@boulder.beeorganized.com',
    })
  })

  it('a DEACTIVATED handler does NOT drop a typed sender either', async () => {
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', [groupInbox])
    h.enqueue('hub_users', [{ id: 'u-bree', is_active: false, disabled_at: null }])

    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: 'Bee Organized Moving <moving@boulder.beeorganized.com>',
    })
  })

  it('but a DISABLED handler in PERSON mode still falls back to base', async () => {
    // The contrast that makes the rule a rule rather than "keep everything":
    // a person-mode row's identity IS the person, so an offboarded handler must
    // not keep sending client mail under their own name.
    enqueueBase(); enqueueVocab()
    h.enqueue('location_project_type_senders', [{ ...movingSender, sender_is_custom: false }])
    h.enqueue('hub_users', [{ id: 'u-bree', is_active: true, disabled_at: '2026-08-01T00:00:00Z' }])

    await sendEmail({ ...sendArgs, senderProjectType: 'Local Move' })

    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      from: `${base.sender_name} <${base.send_from_email}>`,
    })
  })
})
