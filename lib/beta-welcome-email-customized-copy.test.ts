// @vitest-environment node
//
// issue 206 (follow-up) — the Welcome email sends the owner's customized copy.
//
// sendWelcomeEmail (lib/welcome-email.ts) had the SAME latent gap the stage
// emails did: it read only the Welcome master (legacy_id = 'welcome' AND
// location_uuid IS NULL), so an owner's edits to a duplicated Welcome copy
// never reached the client. It now prefers the location's active fork —
// reached via cloned_from_id → master.id — and falls back to the master.
//
// Mirrors lib/beta-stage-email-customized-copy.test.ts: queued fake DB keyed
// by table (FIFO per table, so the two `templates` reads resolve as
// [master, fork]); rate-guard and booking-link stay REAL for the hold tests.

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
    for (const m of ['select', 'insert', 'update', 'upsert', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const callToTable = (table: string, n: number) =>
    state.calls.filter(c => c.table === table)[n]
  return { state, reset, enqueue, makeBuilder, callToTable }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
const sendEmailMock = vi.hoisted(() => vi.fn(async () => ({ success: true, id: 're-1' })))
vi.mock('@/lib/resend', () => ({
  sendEmail: sendEmailMock,
  renderTemplate: vi.fn((tpl: any) => ({ subject: tpl.subject ?? '', body: tpl.body ?? '' })),
}))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => null),
}))
// Welcome is COMMERCIAL — the footer is unconditional. Spy stamps a sentinel so
// we can prove it ran on the customized body; its own fail-closed logic is
// pinned in beta-can-spam-footer.test.ts.
const appendFooterMock = vi.hoisted(() =>
  vi.fn(async (html: string, text: string) => ({
    ok: true as const,
    html: `${html}\n<!--canspam-footer-->`,
    text: `${text}\ncanspam-footer`,
  })),
)
vi.mock('@/lib/marketing-unsubscribe', () => ({ appendCanSpamFooter: appendFooterMock }))

import { sendWelcomeEmail } from '@/lib/welcome-email'

const LOC_UUID = 'loc-uuid-1'
const MASTER_ID = 'welcome-master-1'

const leadRow = (over: Partial<any> = {}) => ({
  id: 'lead-1', name: 'Sarah Doe', first_name: 'Sarah', email: 'sarah@example.com',
  location_uuid: LOC_UUID, assigned_to: null, welcome_email_sent_at: null,
  is_junk: false, paused: false, marketing_opt_out: false, ...over,
})
const locRow = (over: Partial<any> = {}) => ({
  id: LOC_UUID, name: 'Boulder', sender_name: 'Bee Boulder', phone: '555',
  calendar_link: 'https://book.example.com/boulder', reviews_link: null,
  rate_per_hour: '95', city: 'Boulder', state: 'CO', ...over,
})
const masterRow = (over: Partial<any> = {}) => ({
  id: MASTER_ID, subject: 'MASTER WELCOME', body: 'master welcome body', ...over,
})

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('issue 206 — Welcome send prefers the location fork, falls back to master', () => {
  it('a location WITH an active fork sends the fork subject + body', async () => {
    h.enqueue('leads', leadRow())
    h.enqueue('locations', locRow())
    h.enqueue('templates', masterRow())
    h.enqueue('templates', [{ subject: 'FORK WELCOME', body: 'fork welcome body customized' }])

    const res = await sendWelcomeEmail('lead-1')

    expect(res.sent).toBe(true)
    const arg = sendEmailMock.mock.calls[0][0] as any
    expect(arg.subject).toBe('FORK WELCOME')
    expect(arg.html).toContain('fork welcome body customized')
    expect(arg.html).not.toContain('master welcome body')

    const forkCall = h.callToTable('templates', 1)
    expect(forkCall.ops).toContainEqual(['eq', ['cloned_from_id', MASTER_ID]])
    expect(forkCall.ops).toContainEqual(['eq', ['location_uuid', LOC_UUID]])
    expect(forkCall.ops).toContainEqual(['eq', ['is_active', true]])
  })

  it('a location WITHOUT a fork sends the master (unchanged from before 206)', async () => {
    h.enqueue('leads', leadRow())
    h.enqueue('locations', locRow())
    h.enqueue('templates', masterRow())
    h.enqueue('templates', [])

    const res = await sendWelcomeEmail('lead-1')

    expect(res.sent).toBe(true)
    const arg = sendEmailMock.mock.calls[0][0] as any
    expect(arg.subject).toBe('MASTER WELCOME')
    expect(arg.html).toContain('master welcome body')
  })

  it('an inactive fork falls back to the master (filtered out by is_active)', async () => {
    h.enqueue('leads', leadRow())
    h.enqueue('locations', locRow())
    h.enqueue('templates', masterRow())
    h.enqueue('templates', [])

    const res = await sendWelcomeEmail('lead-1')

    expect(res.sent).toBe(true)
    expect((sendEmailMock.mock.calls[0][0] as any).subject).toBe('MASTER WELCOME')
    expect(h.callToTable('templates', 1).ops).toContainEqual(['eq', ['is_active', true]])
  })
})

describe('issue 206 — Welcome compliance and holds apply to a customized body', () => {
  it('the CAN-SPAM footer appends on top of the customized body', async () => {
    h.enqueue('leads', leadRow())
    h.enqueue('locations', locRow())
    h.enqueue('templates', masterRow())
    h.enqueue('templates', [{ subject: 'FORK WELCOME', body: 'customized welcome body' }])

    const res = await sendWelcomeEmail('lead-1')

    expect(res.sent).toBe(true)
    expect(appendFooterMock).toHaveBeenCalledTimes(1)
    expect(appendFooterMock.mock.calls[0][0] as string).toContain('customized welcome body')
    const arg = sendEmailMock.mock.calls[0][0] as any
    expect(arg.html).toContain('customized welcome body')
    expect(arg.html).toContain('<!--canspam-footer-->')
  })

  it('a customized body with an unfilled booking token HOLDS, not sends', async () => {
    h.enqueue('leads', leadRow())
    h.enqueue('locations', locRow({ calendar_link: null }))
    h.enqueue('templates', masterRow({ body: 'no tokens here' }))
    h.enqueue('templates', [{ subject: 'FORK', body: 'Click {{owner_booking_link}} to book.' }])

    const res = await sendWelcomeEmail('lead-1')

    expect(res.sent).toBe(false)
    expect(res.error).toBe('missing_booking_link')
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('a customized body quoting {{rate_per_hour}} with no rate HOLDS, not sends', async () => {
    h.enqueue('leads', leadRow())
    h.enqueue('locations', locRow({ rate_per_hour: null }))
    h.enqueue('templates', masterRow({ body: 'no tokens here' }))
    h.enqueue('templates', [{ subject: 'FORK', body: 'Our rate is {{rate_per_hour}} per hour.' }])

    const res = await sendWelcomeEmail('lead-1')

    expect(res.sent).toBe(false)
    expect(res.error).toBe('missing_rate')
    expect(sendEmailMock).not.toHaveBeenCalled()
  })
})
