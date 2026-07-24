// @vitest-environment node
//
// Invite accept → seeded-external twin cleanup. When a person becomes a
// hub_user, any lead_notification_externals row carrying their address AT THAT
// LOCATION is deleted — the Zoho seed left owner/manager emails there, and the
// resolver auto-includes interface users, so the row is a pure duplicate.
// Pins the whole contract through the REAL route handler (mounted, not source
// pins):
//   • accept with a seeded twin at the invite's location → external deleted,
//     lead_notification_prefs untouched, accept succeeds
//   • same address seeded at a DIFFERENT location → that row survives
//   • case mismatch (Seeded@X vs seeded@x) → still removed (seeds predate
//     lowercased storage)
//   • cleanup failure (select OR delete) → accept still returns success
//   • lite_user invite → external kept (it's the only thing notifying them)
//   • corporate (tier='admin') invite → cleanup never runs (no location)
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Recording query-builder backing both Supabase clients. Response comes
//    from a per-test respond(ctx); every terminal call lands in state.calls.
const h = vi.hoisted(() => {
  const state: any = {
    getUser: { data: { user: { id: 'new-user', email: 'seeded@x.com' } } },
    respond: (_ctx: any) => ({ data: null, error: null }),
    calls: [] as any[],
  }
  const reset = () => {
    state.getUser = { data: { user: { id: 'new-user', email: 'seeded@x.com' } } }
    state.respond = (_ctx: any) => ({ data: null, error: null })
    state.calls = []
  }
  const makeBuilder = (table: string, client: 'session' | 'service') => {
    const ctx: any = { table, client, op: 'select', filters: [] as any[], payload: null }
    const b: any = {}
    b.select = (_cols?: any, _opts?: any) => b
    b.insert = (payload: any) => { ctx.op = 'insert'; ctx.payload = payload; return b }
    b.update = (payload: any) => { ctx.op = 'update'; ctx.payload = payload; return b }
    b.delete = () => { ctx.op = 'delete'; return b }
    b.eq = (col: string, val: any) => { ctx.filters.push(['eq', col, val]); return b }
    b.is = (col: string, val: any) => { ctx.filters.push(['is', col, val]); return b }
    b.in = (col: string, vals: any[]) => { ctx.filters.push(['in', col, vals]); return b }
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

import { POST } from '@/app/api/hub_users/accept/route'

const f = (ctx: any, col: string) => ctx.filters.find((x: any[]) => x[1] === col)?.[2]

// Externals live at two locations; the DB filter is what scopes the read, so
// the fake honors the location_id eq like the real table would.
const EXTERNALS = [
  { id: 'ext-A', location_id: 'locA', email: 'Seeded@X.com' },
  { id: 'ext-A2', location_id: 'locA', email: 'other@x.com' },
  { id: 'ext-B', location_id: 'locB', email: 'seeded@x.com' },
]

function scenario(cfg: any = {}) {
  return (ctx: any) => {
    const { table, op } = ctx
    if (table === 'pending_invites' && op === 'select') {
      return {
        data: {
          id: 'inv1',
          email: 'seeded@x.com',
          full_name: 'Newly Seeded',
          role: cfg.role ?? 'manager',
          tier: cfg.tier ?? 'manager',
          location_id: cfg.inviteLocation ?? 'locA',
          invite_token: 'tok1',
          invite_expires_at: new Date(Date.now() + 86400000).toISOString(),
          accepted_at: null,
          invited_by: 'owner1',
          ...(cfg.invite || {}),
        },
        error: null,
      }
    }
    if (table === 'hub_users' && op === 'select') {
      return { data: cfg.existingHubUser ?? null, error: null }
    }
    if (table === 'hub_users' && op === 'insert') return { data: null, error: null }
    if (table === 'lead_notification_externals' && op === 'select') {
      if (cfg.externalsSelectError) return { data: null, error: { message: 'externals read down' } }
      const loc = f(ctx, 'location_id')
      return { data: EXTERNALS.filter((e) => e.location_id === loc), error: null }
    }
    if (table === 'lead_notification_externals' && op === 'delete') {
      if (cfg.externalsDeleteError) return { data: null, error: { message: 'externals delete down' } }
      return { data: null, error: null }
    }
    if (table === 'subscription_seats' && op === 'select') {
      return { data: [{ id: 'seat1' }], error: null }
    }
    if (table === 'subscription_seats' && op === 'update') return { data: null, error: null }
    if (table === 'pending_invites' && op === 'update') return { data: null, error: null }
    return { data: null, error: null }
  }
}

const req = (body: any = { invite_token: 'tok1' }) =>
  ({ json: async () => body }) as any

beforeEach(() => h.reset())

describe('POST /api/hub_users/accept — seeded-external twin cleanup', () => {
  it('deletes the twin at the invite location; prefs untouched; accept succeeds', async () => {
    h.state.respond = scenario()
    const res = await POST(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)

    // The externals read is scoped to the invite's location.
    const read = h.state.calls.find(
      (c: any) => c.table === 'lead_notification_externals' && c.op === 'select',
    )
    expect(f(read, 'location_id')).toBe('locA')

    // Exactly the matching row is deleted — by id, matched case-insensitively
    // (stored 'Seeded@X.com' vs auth 'seeded@x.com'). The non-matching locA
    // row and the locB twin are not in the delete set.
    const del = h.state.calls.find(
      (c: any) => c.table === 'lead_notification_externals' && c.op === 'delete',
    )
    expect(del).toBeTruthy()
    expect(f(del, 'id')).toEqual(['ext-A'])

    // lead_notification_prefs is NEVER touched — the twin cleanup is about the
    // externals table, not the user's own subscription.
    expect(h.state.calls.some((c: any) => c.table === 'lead_notification_prefs')).toBe(false)
  })

  it('the same address seeded at a DIFFERENT location survives', async () => {
    h.state.respond = scenario({ inviteLocation: 'locB' })
    const res = await POST(req())
    expect((await res.json()).ok).toBe(true)
    const del = h.state.calls.find(
      (c: any) => c.table === 'lead_notification_externals' && c.op === 'delete',
    )
    // locB's own twin goes; locA's row was never read, let alone deleted.
    expect(f(del, 'id')).toEqual(['ext-B'])
  })

  it('cleanup select failure does not fail the accept', async () => {
    h.state.respond = scenario({ externalsSelectError: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await POST(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    // Failure is logged, not swallowed silently.
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('twin cleanup failed')
    warn.mockRestore()
  })

  it('cleanup delete failure does not fail the accept (row read succeeded)', async () => {
    h.state.respond = scenario({ externalsDeleteError: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    warn.mockRestore()
  })

  it('a lite_user invite does NOT delete the external — that row is what notifies them', async () => {
    h.state.respond = scenario({ role: 'lite_user', tier: 'light' })
    const res = await POST(req())
    expect((await res.json()).ok).toBe(true)
    expect(
      h.state.calls.some(
        (c: any) => c.table === 'lead_notification_externals' && c.op === 'delete',
      ),
    ).toBe(false)
  })

  it("a corporate (tier='admin') accept never touches externals", async () => {
    h.state.respond = scenario({ role: 'admin', tier: 'admin', inviteLocation: null })
    const res = await POST(req())
    expect((await res.json()).ok).toBe(true)
    expect(h.state.calls.some((c: any) => c.table === 'lead_notification_externals')).toBe(false)
  })

  it('re-accept (existing hub_user at the invite location) still tidies — retry-safe', async () => {
    h.state.respond = scenario({
      existingHubUser: { id: 'new-user', location_id: 'locA', role: 'manager' },
    })
    const res = await POST(req())
    expect((await res.json()).ok).toBe(true)
    // No second hub_users insert…
    expect(h.state.calls.some((c: any) => c.table === 'hub_users' && c.op === 'insert')).toBe(false)
    // …but the cleanup still ran, so a retry after a transient failure heals.
    const del = h.state.calls.find(
      (c: any) => c.table === 'lead_notification_externals' && c.op === 'delete',
    )
    expect(f(del, 'id')).toEqual(['ext-A'])
  })
})
