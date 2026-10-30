// lib/beta-email-test-send.test.ts
//
// "Send me a test" — POST /api/emails/test-send (2026-10-30).
//
//   • it goes to the SIGNED-IN person's own login address, and nobody else —
//     whatever the request says
//   • it is the real email: the location's chosen style, its real rate and
//     links, through the same sendEmail a client email takes
//   • it touches no client: no lead, no drip progress, no timeline
//   • an email that would be held is not sent; the answer says why
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
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'gt', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const callsFor = (t: string) => state.calls.filter(c => c.table === t)
  const updatePayloads = (t: string) =>
    callsFor(t).flatMap(c => c.ops.filter(o => o[0] === 'update').map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, callsFor, updatePayloads }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
const authUser = vi.hoisted(() => ({ current: { id: 'u1', email: 'lynette@beeorganized.com' } as any }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
const sendEmailMock = vi.hoisted(() => vi.fn(async (_a: any) => ({ success: true, id: 're-1' })))
// renderTemplate is replaced by a faithful stand-in (lib/resend.ts imports the
// Resend SDK, which tests never load): {{tag}} → ctx value or '', and the
// BODY's {{signature}} → the private marker when asked.
vi.mock('@/lib/resend', async () => {
  const { SIGNATURE_MARKER } = await vi.importActual<any>('@/lib/email-signature')
  const apply = (s: string | null | undefined, ctx: any) => String(s ?? '').replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => (ctx[k] == null ? '' : String(ctx[k])))
  return {
    sendEmail: sendEmailMock,
    renderTemplate: (tpl: any, ctx: any, opts: any = {}) => ({
      subject: apply(String(tpl.subject ?? '').replace(/\{\{signature\}\}/g, ''), ctx),
      body: apply(opts.signatureMarker ? String(tpl.body ?? '').replace(/\{\{signature\}\}/g, SIGNATURE_MARKER) : tpl.body, ctx),
    }),
  }
})
vi.mock('@/lib/owner-resolution', () => ({ getPrimaryOwnerForLocation: vi.fn(async () => null) }))
vi.mock('@/lib/template-fork', () => ({ resolveLocationTemplateFork: vi.fn(async () => null) }))

import { POST } from '@/app/api/emails/test-send/route'

const LOC = 'loc-uuid-1'
const me = { id: 'u1', role: 'owner', location_id: LOC, full_name: 'Lynette Ewy', first_name: 'Lynette' }
const loc = {
  id: LOC, name: 'Kansas City', sender_name: 'Bee KC', phone: '(816) 555-0100',
  calendar_link: 'https://cal.example.com/kc', reviews_link: null, rate_per_hour: '$95',
  city: 'Kansas City', state: 'MO', email_style: 'classic',
}
const stepRow = (over: any = {}) => ({
  id: 'st-2', step_order: 2, delay_days: 5, channel: 'email',
  subject: 'Following up', body: 'Hi {{first_name}}, our rate starts at {{rate_per_hour}} per hour.',
  button_text: 'Book a time', button_link: '{{booking_link}}',
  templates: null, drip_paths: { id: 'p1', location_uuid: LOC, is_master: false }, ...over,
})
const req = (body: any) => ({ json: async () => body }) as any
const run = async (body: any, { step = stepRow(), location = loc, hub = me }: any = {}) => {
  h.enqueue('hub_users', hub)
  h.enqueue('locations', location)
  h.enqueue('drip_path_steps', step)
  return POST(req(body))
}
const call = () => sendEmailMock.mock.calls[0]?.[0] as any
const wrote = (t: string) => h.callsFor(t).some(c => c.ops.some(([m]) => ['insert', 'update', 'upsert', 'delete'].includes(m)))

beforeEach(() => { h.reset(); vi.clearAllMocks(); authUser.current = { id: 'u1', email: 'lynette@beeorganized.com' } })

describe('who it goes to', () => {
  it('the signed-in person’s own address — a "to" in the request is ignored', async () => {
    const res = await run({ locationId: LOC, stepId: 'st-2', to: 'someone@else.com', recipient: 'x@y.z' })
    expect(res.status).toBe(200)
    expect(sendEmailMock).toHaveBeenCalledTimes(1)
    expect(call().to).toBe('lynette@beeorganized.com')
    expect(await res.json()).toEqual({ ok: true, to: 'lynette@beeorganized.com' })
  })

  it('another location is refused — an owner tests only their own', async () => {
    const res = await run({ locationId: 'someone-elses-loc', stepId: 'st-2' })
    expect(res.status).toBe(403)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })
})

describe('it is the real email', () => {
  it('in the location’s chosen style, with its real rate and booking link', async () => {
    await run({ locationId: LOC, stepId: 'st-2' })
    const { html, text, subject, locationId } = call()
    expect(locationId).toBe(LOC)                              // the location's own From and reply-to
    expect(html).toContain('font-family:Arvo')               // Classic
    expect(html).toContain('border:2px solid #C99B50')       // Classic button
    expect(html).toContain('href="https://cal.example.com/kc"')
    expect(text).toContain('our rate starts at $95 per hour')
    expect(text).toContain('Hi Lynette,')
    expect(subject).toBe('[Test] Following up')
  })

  it('a location with no style set gets Soft', async () => {
    await run({ locationId: LOC, stepId: 'st-2' }, { location: { ...loc, email_style: undefined } })
    expect(call().html).toContain('bgcolor="#A8C9C4"')
    expect(call().html).toContain('font-family:Corinthia')
  })
})

describe('it touches no client', () => {
  it('logged as a test with no lead; no lead, progress or timeline writes', async () => {
    await run({ locationId: LOC, stepId: 'st-2' })
    expect(call().email_kind).toBe('test')
    expect(call().lead_id).toBeUndefined()
    for (const t of ['leads', 'lead_drip_progress', 'touchpoints']) expect(wrote(t), t).toBe(false)
  })
})

describe('held is not sent', () => {
  it('waiting on a rate → refused, in words', async () => {
    const res = await run({ locationId: LOC, stepId: 'st-2' }, { location: { ...loc, rate_per_hour: null } })
    expect(res.status).toBe(409)
    expect((await res.json()).message).toContain('waiting on your hourly rate')
    expect(sendEmailMock).not.toHaveBeenCalled()
  })
})
