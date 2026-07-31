// @vitest-environment node
//
// Invite consume / single-use guard — issue #65. In prod the consume UPDATE
// carried accepted_user_id (a column missing from pending_invites), so
// PostgREST rejected the whole statement (PGRST204), accepted_at stayed null,
// the "already accepted" 410 guard never armed, and the route returned 200
// anyway — the invite link stayed claimable forever. Pins the fixed contract
// through the REAL route handler (mounted, not source pins):
//   • fresh invite → consumed via a {accepted_at}-ONLY write (no
//     accepted_user_id in that payload), user created, seat claimed, 200
//   • consumed invite reused by a different account → 410, no 2nd user/seat
//   • consume write fails → route returns 500, NOT a silent 200
//   • same invitee re-clicks their own consumed link → 200 already_accepted,
//     no 2nd user, no 2nd seat
//   • retry after a consume failure (invitee already seated) → no 2nd seat
//   • audit column still missing (PGRST204/42703 on the audit write) →
//     acceptance still succeeds — accepted_at is the load-bearing signal
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state: any = {
    getUser: { data: { user: { id: 'invitee-uid', email: 'carol@x.com' } } },
    respond: (_ctx: any) => ({ data: null, error: null }),
    calls: [] as any[],
  }
  const reset = () => {
    state.getUser = { data: { user: { id: 'invitee-uid', email: 'carol@x.com' } } }
    state.respond = (_ctx: any) => ({ data: null, error: null })
    state.calls = []
  }
  const makeBuilder = (table: string, client: 'session' | 'service') => {
    const ctx: any = { table, client, op: 'select', selectOpts: null, filters: [] as any[], payload: null }
    const b: any = {}
    b.select = (_cols?: any, opts?: any) => { ctx.selectOpts = opts || null; return b }
    b.insert = (payload: any) => { ctx.op = 'insert'; ctx.payload = payload; return b }
    b.update = (payload: any) => { ctx.op = 'update'; ctx.payload = payload; return b }
    b.delete = () => { ctx.op = 'delete'; return b }
    b.eq = (col: string, val: any) => { ctx.filters.push(['eq', col, val]); return b }
    b.is = (col: string, val: any) => { ctx.filters.push(['is', col, val]); return b }
    b.in = (col: string, vals: any[]) => { ctx.filters.push(['in', col, vals]); return b }
    b.not = (col: string, _op: string, val: any) => { ctx.filters.push(['not', col, val]); return b }
    b.order = () => b
    b.limit = () => b
    const resolve = () => {
      state.calls.push(ctx)
      return Promise.resolve(state.respond(ctx))
    }
    b.single = resolve
    b.maybeSingle = resolve
    b.then = (res: any, rej: any) => resolve().then(res, rej)
    return b
  }
  return { state, reset, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t, 'service') },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => h.state.getUser },
    from: (t: string) => h.makeBuilder(t, 'session'),
  }),
}))
vi.mock('@/lib/jobber-team-roster', () => ({
  matchHubUserFromCachedRoster: vi.fn(async () => null),
}))
vi.mock('@/lib/notification-recipients', () => ({
  removeExternalTwinsForHubUser: vi.fn(async () => ({ removed: 0 })),
}))

import { POST } from '@/app/api/hub_users/accept/route'

const eqFilter = (ctx: any, col: string) =>
  ctx.filters.find((x: any[]) => x[0] === 'eq' && x[1] === col)?.[2]
const hasIsNull = (ctx: any, col: string) =>
  ctx.filters.some((x: any[]) => x[0] === 'is' && x[1] === col && x[2] === null)

// A subscription_seats SELECT is the per-user held-check when it filters on
// user_id via eq; the available-seat scan filters user_id IS NULL instead.
const isHeldCheck = (ctx: any) =>
  ctx.filters.some((x: any[]) => x[0] === 'eq' && x[1] === 'user_id')
const isAvailableScan = (ctx: any) => hasIsNull(ctx, 'user_id')

// pending_invites UPDATE payloads: the consume writes accepted_at only; the
// audit stamp writes accepted_user_id only.
const isConsumeWrite = (ctx: any) =>
  ctx.table === 'pending_invites' && ctx.op === 'update' && 'accepted_at' in (ctx.payload || {})
const isAuditWrite = (ctx: any) =>
  ctx.table === 'pending_invites' && ctx.op === 'update' && 'accepted_user_id' in (ctx.payload || {})
const isSeatClaim = (ctx: any) =>
  ctx.table === 'subscription_seats' && ctx.op === 'update' && 'user_id' in (ctx.payload || {})

function scenario(cfg: any = {}) {
  return (ctx: any) => {
    const { table, op } = ctx
    if (table === 'pending_invites' && op === 'select') {
      return {
        data: {
          id: 'inv1',
          email: 'carol@x.com',
          full_name: 'Carol Invitee',
          role: cfg.role ?? 'manager',
          tier: cfg.tier ?? 'manager',
          location_id: cfg.inviteLocation ?? 'locA',
          invite_token: 'tok1',
          invite_expires_at: new Date(Date.now() + 86400000).toISOString(),
          accepted_at: cfg.acceptedAt ?? null,
          invited_by: 'owner1',
          ...(cfg.invite || {}),
        },
        error: null,
      }
    }
    if (table === 'hub_users' && op === 'select') {
      return { data: cfg.existingHubUser ?? null, error: cfg.existingHubUser ? null : { code: 'PGRST116' } }
    }
    if (table === 'hub_users' && op === 'insert') {
      return { data: null, error: cfg.hubInsertError ?? null }
    }
    if (table === 'subscription_seats' && op === 'select') {
      if (isHeldCheck(ctx)) return { data: cfg.heldSeats ?? [], error: null }
      if (isAvailableScan(ctx)) return { data: cfg.availableSeats ?? [{ id: 'seat1' }], error: null }
      // primary-owner head count
      return { data: null, count: cfg.primaryCount ?? 0, error: null }
    }
    if (table === 'subscription_seats' && op === 'update') return { data: null, error: null }
    if (table === 'pending_invites' && op === 'update') {
      if ('accepted_at' in (ctx.payload || {})) return { data: null, error: cfg.consumeError ?? null }
      if ('accepted_user_id' in (ctx.payload || {})) return { data: null, error: cfg.auditError ?? null }
    }
    return { data: null, error: null }
  }
}

const req = (body: any = { invite_token: 'tok1' }) => ({ json: async () => body }) as any

beforeEach(() => h.reset())

describe('POST /api/hub_users/accept — invite consume (#65)', () => {
  it('fresh accept: consumes via accepted_at-ONLY write, creates user, claims seat, 200', async () => {
    h.state.respond = scenario()
    const res = await POST(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)

    // The consume write happened and is scoped to the invite row.
    const consume = h.state.calls.find(isConsumeWrite)
    expect(consume).toBeTruthy()
    expect(eqFilter(consume, 'id')).toBe('inv1')
    // REGRESSION GUARD (#65): accepted_user_id must NOT ride the consume write —
    // that missing column is what rejected the whole UPDATE in prod.
    expect('accepted_user_id' in consume.payload).toBe(false)

    // A user was created and a seat was claimed.
    expect(h.state.calls.some((c: any) => c.table === 'hub_users' && c.op === 'insert')).toBe(true)
    expect(h.state.calls.some(isSeatClaim)).toBe(true)
  })

  it('consumed invite reused by a DIFFERENT account → 410, no 2nd user, no 2nd seat, no consume', async () => {
    // accepted_at already set; the clicker has no hub_users row (not the accepter).
    h.state.respond = scenario({ acceptedAt: new Date().toISOString(), existingHubUser: null })
    const res = await POST(req())
    expect(res.status).toBe(410)
    expect((await res.json()).error).toMatch(/already accepted/i)
    expect(h.state.calls.some((c: any) => c.table === 'hub_users' && c.op === 'insert')).toBe(false)
    expect(h.state.calls.some(isSeatClaim)).toBe(false)
    expect(h.state.calls.some(isConsumeWrite)).toBe(false)
  })

  it('consume write fails → 500, NOT a silent 200', async () => {
    h.state.respond = scenario({ consumeError: { code: 'XX000', message: 'db blip' } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await POST(req())
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body.ok).toBeUndefined()
    expect(body.code).toBe('consume_failed')
    // The failure is loud, not swallowed.
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/mark consumed/i)
    err.mockRestore()
  })

  it('same invitee re-clicks their own consumed link → 200 already_accepted, no 2nd user/seat/consume', async () => {
    h.state.respond = scenario({
      acceptedAt: new Date().toISOString(),
      existingHubUser: { id: 'invitee-uid', location_id: 'locA', role: 'manager' },
    })
    const res = await POST(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.already_accepted).toBe(true)
    expect(h.state.calls.some((c: any) => c.table === 'hub_users' && c.op === 'insert')).toBe(false)
    expect(h.state.calls.some(isSeatClaim)).toBe(false)
    expect(h.state.calls.some(isConsumeWrite)).toBe(false)
  })

  it('retry after consume failure (invitee already seated) → no 2nd seat claimed', async () => {
    // hub_users row exists (step 1 succeeded on the prior try) and the user
    // already holds a seat (step 2 succeeded) — the retry must not grab another.
    h.state.respond = scenario({
      existingHubUser: { id: 'invitee-uid', location_id: 'locA', role: 'manager' },
      heldSeats: [{ id: 'seat1' }],
    })
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    // No new hub_users insert and — crucially — no second seat claim.
    expect(h.state.calls.some((c: any) => c.table === 'hub_users' && c.op === 'insert')).toBe(false)
    expect(h.state.calls.some(isSeatClaim)).toBe(false)
    // The available-seat scan is skipped entirely when already seated.
    expect(h.state.calls.some((c: any) => c.table === 'subscription_seats' && c.op === 'select' && isAvailableScan(c))).toBe(false)
    // But the invite still gets consumed on the retry.
    expect(h.state.calls.some(isConsumeWrite)).toBe(true)
  })

  it('audit column still missing (PGRST204) → acceptance still succeeds', async () => {
    h.state.respond = scenario({ auditError: { code: 'PGRST204', message: 'no accepted_user_id' } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    // The missing-column signal is swallowed, not warned — it's the expected
    // pre-migration state, not an error.
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/audit/i)
    warn.mockRestore()
  })
})
