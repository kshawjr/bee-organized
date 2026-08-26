// @vitest-environment node
//
// Three companion pieces to the silent-sends ops alerting:
//
//   1. SLACK TEST BUTTON — POST /api/locations/[id]/slack-test posts a plain
//      "this is a test" message through the SAME transport a real lead alert
//      uses, so one click proves token + channel + bot access. The message is
//      unmistakably a test (no lead card, no buttons, no log_call contract);
//      a failure comes back as owner-actionable words, not a raw Slack code.
//
//   2. DUPLICATE GUARD (preventive) — POST /api/templates/[id]/duplicate
//      refuses to copy an email template whose subject is missing/whitespace,
//      same subject_required/400 shape as the POST /api/templates guard (316).
//
//   3. DRIP-STEPS GUARDS — both step-write routes refuse an EMAIL step that
//      ends up with no subject from ANY source, mirroring the sender's exact
//      `step.subject ?? template.subject` rule — so the 10 active steps that
//      inherit a real template subject through an inline NULL keep saving.
//
// Mocking style follows lib/beta-email-subject-hold-316.test.ts (recording
// query-builder with per-table FIFO response queues).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

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
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'or', 'not', 'in', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'gt']) {
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
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(),
}))
const postToSlackMock = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as any))
vi.mock('@/lib/slack-bot', async (importOriginal) => {
  const actual = await importOriginal<any>()
  return { ...actual, postToSlack: postToSlackMock }
})

import { buildSlackTestMessage, slackTestFailureMessage } from '@/lib/slack-test'
import { POST as slackTestPOST } from '@/app/api/locations/[id]/slack-test/route'
import { POST as duplicatePOST } from '@/app/api/templates/[id]/duplicate/route'
import { PATCH as stepsPATCH } from '@/app/api/drip-paths/[id]/steps/route'
import { PATCH as stepPATCH } from '@/app/api/drip-path-steps/[stepId]/route'
import { createServerSupabaseClient } from '@/lib/supabase-server'

const callsFor = (table: string) => h.state.calls.filter(c => c.table === table)
const opsOf = (call: { ops: [string, any[]][] }, m: string) => call.ops.filter(o => o[0] === m)
const insertPayloads = (table: string) =>
  callsFor(table).flatMap(c => opsOf(c, 'insert').map(o => o[1][0]))

const authAs = (role: string, locationId: string | null = 'loc-uuid-1') => {
  ;(createServerSupabaseClient as any).mockResolvedValue({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'u1' } } })) },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { id: 'u1', role, location_id: locationId }, error: null }),
        }),
      }),
    }),
  })
}
const jsonReq = (body: any) => ({ json: async () => body }) as any

beforeEach(() => {
  h.reset()
  vi.clearAllMocks()
  postToSlackMock.mockResolvedValue({ ok: true })
})

// ═══ 1a. The test message itself ═══

describe('buildSlackTestMessage — obviously a test, never mistakable for a lead', () => {
  const msg = buildSlackTestMessage('Portland')

  it('is plain text only: no attachments, no blocks, no buttons', () => {
    expect(Object.keys(msg)).toEqual(['text'])
  })

  it('says it is a test in the first sentence, and that nothing needs doing', () => {
    expect(msg.text).toMatch(/^🔔 This is a test message/)
    expect(msg.text).toContain('nothing to do')
    expect(msg.text).toContain('Portland')
  })

  it("looks nothing like the lead card: no '🐝 New lead' summary, no log_call, no Log call button", () => {
    // The real card's notification line starts '🐝 New lead…' — the test must
    // never render or push-preview like one. ("New lead alerts will arrive"
    // in the body copy is fine; the card marker is the 🐝 summary.)
    expect(msg.text).not.toContain('🐝')
    expect(msg.text).not.toMatch(/^.{0,5}New lead/)
    expect(msg.text).not.toContain('log_call')
    expect(msg.text).not.toContain('Log call')
  })

  it('a nameless location still reads cleanly', () => {
    expect(buildSlackTestMessage(null).text).toMatch(/^🔔 This is a test message from Bee Hub —/)
  })
})

describe('slackTestFailureMessage — owner-actionable words, never a bare code', () => {
  it('channel_not_found → invite the app to the private channel, or reconnect public', () => {
    const m = slackTestFailureMessage({ error: 'channel_not_found' })
    expect(m).toMatch(/private channel/)
    expect(m).toMatch(/invite/i)
    expect(m).toMatch(/Reconnect/i)
    expect(m).not.toBe('channel_not_found')
  })

  it('dead token codes → reconnect via Add to Slack', () => {
    for (const error of ['invalid_auth', 'token_revoked', 'account_inactive']) {
      expect(slackTestFailureMessage({ error })).toMatch(/Add to Slack/)
    }
  })

  it('not connected → points at Add to Slack', () => {
    expect(slackTestFailureMessage({ skipped: 'not_connected' })).toMatch(/Add to Slack/)
  })

  it('an unknown code is quoted inside a readable sentence', () => {
    const m = slackTestFailureMessage({ error: 'fatal_wobble' })
    expect(m).toContain('fatal_wobble')
    expect(m).toMatch(/didn’t arrive/)
  })
})

// ═══ 1b. The route ═══

describe('POST /api/locations/[id]/slack-test', () => {
  const params = { params: { id: 'loc-uuid-1' } }
  const LOC = { id: 'loc-uuid-1', name: 'Portland', location_id: 'loc_portland', slack_channel_name: 'leads' }

  it('posts the test through postToSlack and names the channel in the success reply', async () => {
    authAs('owner')
    h.enqueue('locations', LOC)
    const res = await slackTestPOST({} as any, params)
    expect(res.status).toBe(200)
    expect((await res.json()).message).toContain('#leads')
    expect(postToSlackMock).toHaveBeenCalledTimes(1)
    const [locId, message] = postToSlackMock.mock.calls[0] as any[]
    expect(locId).toBe('loc-uuid-1')
    expect(message.text).toMatch(/test message/)
    expect(message.attachments).toBeUndefined()
    expect(message.blocks).toBeUndefined()
  })

  it('a broken channel fails VISIBLY with actionable copy (channel_not_found → invite/reconnect), 502', async () => {
    authAs('owner')
    h.enqueue('locations', LOC)
    postToSlackMock.mockResolvedValue({ ok: false, error: 'channel_not_found' })
    const res = await slackTestPOST({} as any, params)
    expect(res.status).toBe(502)
    const j = await res.json()
    expect(j.error).toMatch(/private channel/)
    expect(j.error).toMatch(/invite/i)
    expect(j.error).not.toBe('channel_not_found')
  })

  it('not connected → 400 with Add-to-Slack copy, not a raw skip code', async () => {
    authAs('owner')
    h.enqueue('locations', LOC)
    postToSlackMock.mockResolvedValue({ ok: false, skipped: 'not_connected' })
    const res = await slackTestPOST({} as any, params)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Add to Slack/)
  })

  it("an owner of a DIFFERENT location is refused before any post", async () => {
    authAs('owner', 'loc-uuid-other')
    const res = await slackTestPOST({} as any, params)
    expect(res.status).toBe(403)
    expect(postToSlackMock).not.toHaveBeenCalled()
  })

  it('admin may test any location', async () => {
    authAs('admin', null)
    h.enqueue('locations', LOC)
    const res = await slackTestPOST({} as any, params)
    expect(res.status).toBe(200)
  })

  it('never writes notification_log (a failed test must not feed the ops alert rail)', async () => {
    authAs('owner')
    h.enqueue('locations', LOC)
    postToSlackMock.mockResolvedValue({ ok: false, error: 'channel_not_found' })
    await slackTestPOST({} as any, params)
    expect(callsFor('notification_log')).toHaveLength(0)
    const src = fs.readFileSync(path.join(process.cwd(), 'app/api/locations/[id]/slack-test/route.ts'), 'utf8')
    expect(src).not.toContain('logSlackNotification')
    expect(src).not.toContain('notification-log')
  })
})

// ═══ 2. Duplicate guard (preventive — zero bad masters exist today) ═══

describe('POST /api/templates/[id]/duplicate — blank email subject refused', () => {
  const params = { params: { id: 'welcome' } }
  const MASTER = (over: any = {}) => ({
    id: '11111111-2222-3333-4444-555555555555',
    legacy_id: 'welcome', name: 'Welcome', type: 'email', tag: null,
    subject: 'Welcome!', body: 'Hi {{first_name}}', is_active: true,
    location_uuid: null, cloned_from_id: null, created_by: 'u0',
    created_at: 'x', updated_at: 'x',
    ...over,
  })

  it('email master with NULL subject → 400 subject_required, nothing inserted', async () => {
    authAs('owner')
    h.enqueue('templates', MASTER({ subject: null }))
    const res = await duplicatePOST(jsonReq({}), params)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'subject_required' })
    expect(insertPayloads('templates')).toHaveLength(0)
  })

  it('email master with whitespace subject → 400 subject_required', async () => {
    authAs('owner')
    h.enqueue('templates', MASTER({ subject: '   ' }))
    const res = await duplicatePOST(jsonReq({}), params)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'subject_required' })
  })

  it('a normal email master still duplicates (201, subject copied)', async () => {
    authAs('owner')
    h.enqueue('templates', MASTER())
    h.enqueue('templates', MASTER({ id: '22222222-2222-3333-4444-555555555555', legacy_id: null, location_uuid: 'loc-uuid-1', name: 'Welcome (Copy)' }))
    const res = await duplicatePOST(jsonReq({}), params)
    expect(res.status).toBe(201)
    expect(insertPayloads('templates')).toHaveLength(1)
    expect(insertPayloads('templates')[0].subject).toBe('Welcome!')
  })

  it('a call template with no subject duplicates fine (no subject by design)', async () => {
    authAs('owner')
    h.enqueue('templates', MASTER({ type: 'call', subject: null }))
    h.enqueue('templates', MASTER({ id: '22222222-2222-3333-4444-555555555555', type: 'call', subject: null, legacy_id: null, location_uuid: 'loc-uuid-1' }))
    const res = await duplicatePOST(jsonReq({}), params)
    expect(res.status).toBe(201)
  })
})

// ═══ 3a. Bulk step replace — PATCH /api/drip-paths/[id]/steps ═══

describe('PATCH /api/drip-paths/[id]/steps — email steps need a subject from SOME source', () => {
  const params = { params: { id: 'path-1' } }
  const PATH = { id: 'path-1', location_uuid: 'loc-uuid-1', is_master: false }
  const emailStep = (over: any = {}) => ({
    step_order: 1, delay_days: 0, channel: 'email',
    master_template_id: null, subject: null, body: 'Hi', origin: 'added',
    ...over,
  })

  it('INHERITANCE KEPT: inline-NULL subject + template with a real subject saves (the 10 live steps)', async () => {
    authAs('owner')
    h.enqueue('drip_paths', PATH)
    h.enqueue('templates', [{ id: 'tpl-1', subject: 'Real template subject' }])
    h.enqueue('drip_path_steps', null)   // delete
    h.enqueue('drip_path_steps', [emailStep({ master_template_id: 'tpl-1', id: 'st-1' })]) // insert…select
    const res = await stepsPATCH(jsonReq({ steps: [emailStep({ master_template_id: 'tpl-1' })] }), params)
    expect(res.status).toBe(200)
    expect(insertPayloads('drip_path_steps')).toHaveLength(1)
  })

  it('NULL subject + NO template → 400 subject_required, and the existing steps are NOT deleted', async () => {
    authAs('owner')
    h.enqueue('drip_paths', PATH)
    const res = await stepsPATCH(jsonReq({ steps: [emailStep()] }), params)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'subject_required', step_order: 1 })
    // The destructive delete-then-insert never ran — a refused save is a no-op.
    expect(callsFor('drip_path_steps')).toHaveLength(0)
  })

  it("EMPTY-STRING subject SHADOWS the template ('' ?? never falls through) → 400 even with a good template", async () => {
    authAs('owner')
    h.enqueue('drip_paths', PATH)
    const res = await stepsPATCH(jsonReq({ steps: [emailStep({ subject: '', master_template_id: 'tpl-1' })] }), params)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('subject_required')
    expect(callsFor('drip_path_steps')).toHaveLength(0)
  })

  it('NULL subject + template whose own subject is NULL → 400 (no subject from any source)', async () => {
    authAs('owner')
    h.enqueue('drip_paths', PATH)
    h.enqueue('templates', [{ id: 'tpl-1', subject: null }])
    const res = await stepsPATCH(jsonReq({ steps: [emailStep({ master_template_id: 'tpl-1' })] }), params)
    expect(res.status).toBe(400)
    expect(callsFor('drip_path_steps')).toHaveLength(0)
  })

  it('an inline REAL subject needs no template and saves', async () => {
    authAs('owner')
    h.enqueue('drip_paths', PATH)
    h.enqueue('drip_path_steps', null)
    h.enqueue('drip_path_steps', [emailStep({ subject: 'Hello there', id: 'st-1' })])
    const res = await stepsPATCH(jsonReq({ steps: [emailStep({ subject: 'Hello there' })] }), params)
    expect(res.status).toBe(200)
  })

  it('an SMS step has no subject by design and saves untouched', async () => {
    authAs('owner')
    h.enqueue('drip_paths', PATH)
    h.enqueue('drip_path_steps', null)
    h.enqueue('drip_path_steps', [emailStep({ channel: 'sms', id: 'st-1' })])
    const res = await stepsPATCH(jsonReq({ steps: [emailStep({ channel: 'sms' })] }), params)
    expect(res.status).toBe(200)
  })
})

// ═══ 3b. Single-step edit — PATCH /api/drip-path-steps/[stepId] ═══

describe('PATCH /api/drip-path-steps/[stepId] — a subject edit cannot strand an email step', () => {
  const params = { params: { stepId: 'st-1' } }
  const STEP = (over: any = {}) => ({
    id: 'st-1', drip_path_id: 'path-1', channel: 'email', master_template_id: null,
    drip_paths: { id: 'path-1', is_master: false, location_uuid: 'loc-uuid-1' },
    ...over,
  })
  const UPDATED = { id: 'st-1', drip_path_id: 'path-1', step_order: 1, delay_days: 0, channel: 'email', subject: null, body: 'Hi', is_active: true, updated_at: 'x' }

  it('subject → NULL with a real template subject RESTORES inheritance (200)', async () => {
    authAs('owner')
    h.enqueue('drip_path_steps', STEP({ master_template_id: 'tpl-1' }))
    h.enqueue('templates', { subject: 'Real template subject' })
    h.enqueue('drip_path_steps', UPDATED)
    const res = await stepPATCH(jsonReq({ subject: null }), params)
    expect(res.status).toBe(200)
  })

  it('subject → NULL with NO template → 400 subject_required, no update', async () => {
    authAs('owner')
    h.enqueue('drip_path_steps', STEP())
    const res = await stepPATCH(jsonReq({ subject: null }), params)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'subject_required' })
    expect(callsFor('drip_path_steps').flatMap(c => opsOf(c, 'update'))).toHaveLength(0)
  })

  it("subject → '' (shadows any template) → 400 subject_required", async () => {
    authAs('owner')
    h.enqueue('drip_path_steps', STEP({ master_template_id: 'tpl-1' }))
    const res = await stepPATCH(jsonReq({ subject: '   ' }), params)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'subject_required' })
  })

  it('a real subject edit passes (200)', async () => {
    authAs('owner')
    h.enqueue('drip_path_steps', STEP())
    h.enqueue('drip_path_steps', { ...UPDATED, subject: 'New subject' })
    const res = await stepPATCH(jsonReq({ subject: 'New subject' }), params)
    expect(res.status).toBe(200)
  })

  it('a body-only edit never trips the subject guard (200, no template read)', async () => {
    authAs('owner')
    h.enqueue('drip_path_steps', STEP({ master_template_id: 'tpl-1' }))
    h.enqueue('drip_path_steps', { ...UPDATED, body: 'New body' })
    const res = await stepPATCH(jsonReq({ body: 'New body' }), params)
    expect(res.status).toBe(200)
    expect(callsFor('templates')).toHaveLength(0)
  })
})
