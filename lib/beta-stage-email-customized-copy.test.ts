// @vitest-environment node
//
// issue 206 — stage emails send the owner's customized copy.
//
// sendStageEmail (lib/stage-emails.ts) used to read ONLY the master
// (legacy_id = key AND location_uuid IS NULL), so an owner's edits to a
// duplicated copy never reached the client. It now prefers the location's
// active fork — reached via cloned_from_id → master.id, since a fork carries
// location_uuid set AND legacy_id NULL and so matches neither master predicate
// — and falls back to the master.
//
// This suite pins the resolution and its invariants:
//   - a location WITH an active fork sends the fork's subject + body
//   - a location WITHOUT one sends the master (unchanged from before 206)
//   - an inactive fork falls back to the master (query filters is_active)
//   - the CAN-SPAM footer still appends on top of a customized commercial body
//   - the rate / booking-link holds fire against the CUSTOMIZED body
//
// DB access is a queued fake keyed by table name (FIFO per table), so the two
// `templates` reads resolve in order: [master, fork]. rate-guard and
// booking-link stay REAL — the whole point of the last two tests.

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
  // Every op recorded for the nth call to a given table (0-indexed).
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
  // Passthrough render so the fork's subject/body reach sendEmail verbatim —
  // token substitution is not what these tests pin.
  renderTemplate: vi.fn((tpl: any) => ({ subject: tpl.subject ?? '', body: tpl.body ?? '' })),
}))
vi.mock('@/lib/owner-resolution', () => ({
  getPrimaryOwnerForLocation: vi.fn(async () => null),
}))
// CAN-SPAM footer is a spy that stamps a sentinel — its own fail-closed logic
// is pinned elsewhere (#115). Here we only assert it runs on the customized body.
const appendFooterMock = vi.hoisted(() =>
  vi.fn(async (html: string, text: string) => ({
    ok: true as const,
    html: `${html}\n<!--canspam-footer-->`,
    text: `${text}\ncanspam-footer`,
  })),
)
vi.mock('@/lib/marketing-unsubscribe', () => ({ appendCanSpamFooter: appendFooterMock }))

import { sendStageEmail } from '@/lib/stage-emails'

const ROW_ID = 'sched-1'
const LOC_UUID = 'loc-uuid-1'
const MASTER_ID = 'master-1'

const rowFor = (key: string) => ({
  id: ROW_ID, lead_id: 'lead-1', stage_email_key: key, sent_at: null, cancelled_at: null,
})
const masterRow = (key: string, over: Partial<any> = {}) => ({
  id: MASTER_ID, subject: 'MASTER SUBJ', body: 'master body copy', name: key, ...over,
})
const leadRow = (over: Partial<any> = {}) => ({
  id: 'lead-1', name: 'Sarah Doe', first_name: 'Sarah', email: 'sarah@example.com',
  location_uuid: LOC_UUID, assigned_to: null, marketing_opt_out: false, ...over,
})
const locRow = (over: Partial<any> = {}) => ({
  id: LOC_UUID, name: 'Boulder', sender_name: 'Bee Boulder', phone: '555',
  calendar_link: 'https://book.example.com/boulder', reviews_link: null,
  rate_per_hour: '95', city: 'Boulder', state: 'CO', ...over,
})

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('issue 206 — send path prefers the location fork, falls back to master', () => {
  it('a location WITH an active fork sends the fork subject + body', async () => {
    h.enqueue('scheduled_stage_emails', rowFor('opp_organizing_estimate_3d'))
    h.enqueue('templates', masterRow('opp_organizing_estimate_3d'))
    h.enqueue('leads', leadRow())
    // fork lookup returns an array (.limit(1))
    h.enqueue('templates', [{ subject: 'FORK SUBJ', body: 'fork body customized' }])
    h.enqueue('locations', locRow())

    const res = await sendStageEmail(ROW_ID)

    expect(res.sent).toBe(true)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    const arg = sendEmailMock.mock.calls[0][0] as any
    expect(arg.subject).toBe('FORK SUBJ')
    expect(arg.html).toContain('fork body customized')
    expect(arg.html).not.toContain('master body copy')

    // The fork query resolves via cloned_from_id → master.id, scoped to the
    // location and to ACTIVE rows only.
    const forkCall = h.callToTable('templates', 1)
    expect(forkCall.ops).toContainEqual(['eq', ['cloned_from_id', MASTER_ID]])
    expect(forkCall.ops).toContainEqual(['eq', ['location_uuid', LOC_UUID]])
    expect(forkCall.ops).toContainEqual(['eq', ['is_active', true]])
  })

  it('a location WITHOUT a fork sends the master (unchanged from before 206)', async () => {
    h.enqueue('scheduled_stage_emails', rowFor('opp_organizing_estimate_3d'))
    h.enqueue('templates', masterRow('opp_organizing_estimate_3d'))
    h.enqueue('leads', leadRow())
    h.enqueue('templates', []) // no fork rows
    h.enqueue('locations', locRow())

    const res = await sendStageEmail(ROW_ID)

    expect(res.sent).toBe(true)
    const arg = sendEmailMock.mock.calls[0][0] as any
    expect(arg.subject).toBe('MASTER SUBJ')
    expect(arg.html).toContain('master body copy')
  })

  it('an inactive fork falls back to the master (filtered out by is_active)', async () => {
    h.enqueue('scheduled_stage_emails', rowFor('opp_organizing_estimate_3d'))
    h.enqueue('templates', masterRow('opp_organizing_estimate_3d'))
    h.enqueue('leads', leadRow())
    // The DB filters the inactive fork out, so the query returns []. We assert
    // both the master result AND that the query carried the is_active filter.
    h.enqueue('templates', [])
    h.enqueue('locations', locRow())

    const res = await sendStageEmail(ROW_ID)

    expect(res.sent).toBe(true)
    const arg = sendEmailMock.mock.calls[0][0] as any
    expect(arg.subject).toBe('MASTER SUBJ')
    const forkCall = h.callToTable('templates', 1)
    expect(forkCall.ops).toContainEqual(['eq', ['is_active', true]])
  })
})

describe('issue 206 — compliance and holds still apply to a customized body', () => {
  it('the CAN-SPAM footer appends on top of a customized COMMERCIAL body', async () => {
    h.enqueue('scheduled_stage_emails', rowFor('opp_closed_job_3mo'))
    h.enqueue('templates', masterRow('opp_closed_job_3mo'))
    h.enqueue('leads', leadRow())
    h.enqueue('templates', [{ subject: 'FORK SUBJ', body: 'customized closed-job body' }])
    h.enqueue('locations', locRow())

    const res = await sendStageEmail(ROW_ID)

    expect(res.sent).toBe(true)
    // Footer ran, and it ran on the customized body…
    expect(appendFooterMock).toHaveBeenCalledTimes(1)
    expect((appendFooterMock.mock.calls[0][0] as string)).toContain('customized closed-job body')
    // …and the footered output is what actually shipped.
    const arg = sendEmailMock.mock.calls[0][0] as any
    expect(arg.html).toContain('customized closed-job body')
    expect(arg.html).toContain('<!--canspam-footer-->')
  })

  it('a customized body referencing an unfilled booking token HOLDS, not sends', async () => {
    // Master body has no booking token; the customized fork does. The location
    // has no calendar_link and the lead is unassigned, so the tag resolves
    // blank — proving the hold is checked against the CUSTOMIZED body.
    h.enqueue('scheduled_stage_emails', rowFor('opp_organizing_estimate_3d'))
    h.enqueue('templates', masterRow('opp_organizing_estimate_3d', { body: 'no tokens here' }))
    h.enqueue('leads', leadRow())
    h.enqueue('templates', [{ subject: 'FORK SUBJ', body: 'Click {{owner_booking_link}} to book.' }])
    h.enqueue('locations', locRow({ calendar_link: null }))

    const res = await sendStageEmail(ROW_ID)

    expect(res.sent).toBe(false)
    expect(res.error).toBe('missing_booking_link')
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('a customized body quoting {{rate_per_hour}} with no rate HOLDS, not sends', async () => {
    h.enqueue('scheduled_stage_emails', rowFor('opp_organizing_estimate_3d'))
    h.enqueue('templates', masterRow('opp_organizing_estimate_3d', { body: 'no tokens here' }))
    h.enqueue('leads', leadRow())
    h.enqueue('templates', [{ subject: 'FORK SUBJ', body: 'Our rate is {{rate_per_hour}} per hour.' }])
    h.enqueue('locations', locRow({ rate_per_hour: null }))

    const res = await sendStageEmail(ROW_ID)

    expect(res.sent).toBe(false)
    expect(res.error).toBe('missing_rate')
    expect(sendEmailMock).not.toHaveBeenCalled()
  })
})
