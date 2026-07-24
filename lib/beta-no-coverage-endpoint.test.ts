// @vitest-environment node
//
// POST /api/leads/:id/no-coverage — corp/admin emails an unroutable lead to
// say we don't serve their area, with a mailing-list opt-in link, and (per
// Kevin's rule) dismisses the lead ON SEND. Pins:
//   • Gate: non-admin → 403 (the UI gating is cosmetic under view-as).
//   • Happy path: token minted, email sent via sendEmailDirect, inbox_dismissed_at
//     written, system touchpoint logged.
//   • WRITE ORDER: a FAILED send never dismisses the lead — it stays visible
//     and recoverable (dismissed:false, 502), and no touchpoint is written.
//   • A lead with no email is refused before anything is minted or sent.
//   • A post-send dismiss failure returns success with dismissed:false + a
//     warning (email is out, row stays visible — the safe direction).
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Recording supabase mock: chainable builder + per-table FIFO queue, plus
// captured update/insert payloads. Same shape as the transfer endpoint test.
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = {
    queue: [] as { table: string; resp: Resp }[],
    updates: [] as { table: string; arg: any }[],
    inserts: [] as { table: string; arg: any }[],
  }
  const reset = () => { state.queue = []; state.updates = []; state.inserts = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0
      ? state.queue.splice(idx, 1)[0].resp
      : { data: null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'neq', 'or', 'not', 'is', 'in', 'order', 'limit']) {
      b[m] = () => b
    }
    b.update = (arg: any) => { state.updates.push({ table, arg }); return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); return b }
    b.single = () => Promise.resolve(resp)
    b.maybeSingle = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

const authUser = vi.hoisted(() => ({ current: { id: 'u1' } as any }))
const sendMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
// Mock the send rail — we assert on the endpoint's ORCHESTRATION (order, gating,
// dismissal), not on Resend. sendNoCoverageEmail returns the SendResult shape.
vi.mock('@/lib/no-coverage-email', () => ({
  sendNoCoverageEmail: sendMock,
  firstNameOf: (l: any) => (l?.name || '').trim().split(/\s+/)[0] || null,
}))

import { POST } from '@/app/api/leads/[id]/no-coverage/route'

const LEAD = (over: any = {}) => ({
  id: 'lead-1',
  name: 'Sarah Mitchell',
  first_name: 'Sarah',
  email: 'sarah@email.com',
  city: 'Austin',
  state: 'TX',
  location_id: 'loc_other',
  location_uuid: 'loc-other-uuid',
  inbox_dismissed_at: null,
  marketing_consented_at: null,
  ...over,
})

// Order the endpoint consumes: hub_users (server auth) → leads (load) →
// leads (token update) → [send] → leads (dismiss update) → touchpoints.
const arm = (opts: {
  role?: string
  lead?: any
  tokenError?: any
  dismissError?: any
} = {}) => {
  h.enqueue('hub_users', { id: 'u1', role: opts.role ?? 'admin', location_id: null })
  h.enqueue('leads', opts.lead ?? LEAD())
  h.enqueue('leads', {}, opts.tokenError ?? null)  // token update
  h.enqueue('leads', {}, opts.dismissError ?? null) // dismiss update
  h.enqueue('touchpoints', { id: 'tp-1' })          // touchpoint insert
}

const call = (id = 'lead-1') =>
  POST(
    new Request(`http://test/api/leads/${id}/no-coverage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }) as any,
    { params: Promise.resolve({ id }) },
  )

beforeEach(() => {
  h.reset()
  authUser.current = { id: 'u1' }
  sendMock.mockReset()
  sendMock.mockResolvedValue({ success: true, id: 'email-abc', subject: 's', text: 't' })
})

describe('no-coverage endpoint — gate', () => {
  it('401 when unauthenticated', async () => {
    authUser.current = null
    const res = await call()
    expect(res.status).toBe(401)
  })

  it('403 for a non-admin (franchise) caller — the UI gate is cosmetic', async () => {
    arm({ role: 'owner' })
    const res = await call()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden_admin_only')
    // Nothing was minted or sent behind a rejected gate.
    expect(sendMock).not.toHaveBeenCalled()
    expect(h.state.updates).toHaveLength(0)
  })

  it('allows super_admin', async () => {
    arm({ role: 'super_admin' })
    const res = await call()
    expect(res.status).toBe(200)
  })
})

describe('no-coverage endpoint — happy path', () => {
  it('mints a token, sends, dismisses ON SEND, and logs a touchpoint', async () => {
    arm({ role: 'admin' })
    const res = await call()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.sent).toBe(true)
    expect(json.dismissed).toBe(true)

    // token minted before the send
    const tokenUpdate = h.state.updates.find(u => u.table === 'leads' && 'optin_token' in u.arg)
    expect(tokenUpdate).toBeTruthy()
    expect(tokenUpdate!.arg.optin_token).toMatch(/^[0-9a-f]{48}$/)
    expect(tokenUpdate!.arg.optin_token_expires_at).toBeTruthy()

    // sent with a /mailing-list/<token> URL (no PII in the link)
    expect(sendMock).toHaveBeenCalledTimes(1)
    const sendArg = sendMock.mock.calls[0][0]
    expect(sendArg.to).toBe('sarah@email.com')
    expect(sendArg.optInUrl).toContain('/mailing-list/')
    expect(sendArg.optInUrl).toContain(tokenUpdate!.arg.optin_token)
    expect(sendArg.optInUrl).not.toContain('lead-1')
    expect(sendArg.optInUrl).not.toContain('sarah@email.com')

    // dismissed ON SEND
    const dismissUpdate = h.state.updates.find(u => u.table === 'leads' && 'inbox_dismissed_at' in u.arg)
    expect(dismissUpdate).toBeTruthy()
    expect(dismissUpdate!.arg.inbox_dismissed_at).toBeTruthy()

    // system touchpoint
    const tp = h.state.inserts.find(i => i.table === 'touchpoints')
    expect(tp).toBeTruthy()
    expect(tp!.arg.kind).toBe('system')
  })
})

describe('no-coverage endpoint — a failed send does NOT hide the lead', () => {
  it('returns 502 dismissed:false and never writes inbox_dismissed_at or a touchpoint', async () => {
    sendMock.mockResolvedValue({ success: false, error: 'resend boom', subject: 's', text: 't' })
    arm({ role: 'admin' })
    const res = await call()
    const json = await res.json()
    expect(res.status).toBe(502)
    expect(json.error).toBe('send_failed')
    expect(json.dismissed).toBe(false)

    // token was minted (harmless, inert without an email) but the lead was
    // NEVER dismissed and NO touchpoint claims the person was contacted.
    const dismissUpdate = h.state.updates.find(u => u.table === 'leads' && 'inbox_dismissed_at' in u.arg)
    expect(dismissUpdate).toBeUndefined()
    expect(h.state.inserts.find(i => i.table === 'touchpoints')).toBeUndefined()
  })
})

describe('no-coverage endpoint — preconditions', () => {
  it('refuses a lead with no email before minting or sending', async () => {
    arm({ role: 'admin', lead: LEAD({ email: '' }) })
    const res = await call()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('lead_has_no_email')
    expect(sendMock).not.toHaveBeenCalled()
    expect(h.state.updates).toHaveLength(0)
  })
})

describe('no-coverage endpoint — dismiss failure after a good send', () => {
  it('reports success with dismissed:false + a warning (email is out; safe direction)', async () => {
    arm({ role: 'admin', dismissError: { message: 'update blew up' } })
    const res = await call()
    const json = await res.json()
    // The send succeeded, so this is NOT an error response — but the client is
    // told the row was NOT cleared, so it leaves it on screen.
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.sent).toBe(true)
    expect(json.dismissed).toBe(false)
    expect(json.warnings?.some((w: string) => w.startsWith('dismiss_write_failed_after_send'))).toBe(true)
  })
})
