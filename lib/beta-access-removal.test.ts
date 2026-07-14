// @vitest-environment node
//
// Reversible "Remove access" offboard — pins the whole contract:
//   • Pure guards (lib/access-removal): permission (manager rejected),
//     self-removal, last-owner.
//   • POST /api/hub_users/[id]/access — ONE call disables the flag, bans
//     auth, frees the seat, AND unsubscribes from lead notifications.
//   • Layer 1 is PRIMARY: an auth-ban failure does NOT prevent the lockout
//     (the disabled flag is still written; the call still succeeds).
//   • PATCH — reactivation restores login (clears flag + unbans) but does
//     NOT auto-add a seat.
//   • A manager is rejected even on a direct API hit.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  canManageAccess,
  isSelfRemoval,
  wouldOrphanLastOwner,
  checkAccessGuards,
  BAN_DURATION,
  UNBAN_DURATION,
} from '@/lib/access-removal'

// ── Mock the two Supabase clients. A single recording query-builder backs
//    both; `client` ('session' | 'service') + table + op + head disambiguate
//    which read/write it is, and every terminal call is logged to state.calls
//    for write assertions. Responses come from a per-test `respond(ctx)`.
const h = vi.hoisted(() => {
  const state: any = {
    getUser: { data: { user: { id: 'owner1' } } },
    respond: (_ctx: any) => ({ data: null, error: null }),
    banResult: { error: null },
    banThrows: false,
    banCalls: [] as any[],
    calls: [] as any[],
  }
  const reset = () => {
    state.getUser = { data: { user: { id: 'owner1' } } }
    state.respond = (_ctx: any) => ({ data: null, error: null })
    state.banResult = { error: null }
    state.banThrows = false
    state.banCalls = []
    state.calls = []
  }
  const makeBuilder = (table: string, client: 'session' | 'service') => {
    const ctx: any = { table, client, op: 'select', filters: {}, head: false, count: false, payload: null, onConflict: null }
    const b: any = {}
    b.select = (_cols?: any, opts?: any) => {
      if (opts?.head) ctx.head = true
      if (opts?.count) ctx.count = true
      return b
    }
    b.update = (payload: any) => { ctx.op = 'update'; ctx.payload = payload; return b }
    b.upsert = (payload: any, opts: any) => { ctx.op = 'upsert'; ctx.payload = payload; ctx.onConflict = opts?.onConflict; return b }
    b.insert = (payload: any) => { ctx.op = 'insert'; ctx.payload = payload; return b }
    b.eq = (col: string, val: any) => { ctx.filters[col] = val; return b }
    b.is = (col: string, val: any) => { ctx.filters[col] = val; return b }
    const resolve = () => { state.calls.push(ctx); return Promise.resolve(state.respond(ctx)) }
    b.single = resolve
    b.maybeSingle = resolve
    b.then = (res: any, rej: any) => resolve().then(res, rej)
    return b
  }
  return { state, reset, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (t: string) => h.makeBuilder(t, 'service'),
    auth: {
      admin: {
        updateUserById: async (id: string, opts: any) => {
          h.state.banCalls.push({ id, opts })
          if (h.state.banThrows) throw new Error('auth down')
          return h.state.banResult
        },
      },
    },
  },
}))

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => h.state.getUser },
    from: (t: string) => h.makeBuilder(t, 'session'),
  }),
}))

import { POST, PATCH } from '@/app/api/hub_users/[id]/access/route'

// Build a respond() from a happy-path config, overridable per test.
function scenario(cfg: any = {}) {
  return (ctx: any) => {
    const { table, op, head, client } = ctx
    if (table === 'hub_users' && op === 'select' && head) {
      return { data: null, error: null, count: cfg.enabledOwners ?? 0 }
    }
    if (table === 'hub_users' && op === 'select' && client === 'session') {
      return { data: cfg.caller ?? { id: 'owner1', role: 'owner', location_id: 'locA' }, error: null }
    }
    if (table === 'hub_users' && op === 'select' && client === 'service') {
      return {
        data: cfg.target ?? { id: 'mgr1', role: 'manager', location_id: 'locA', email: 'm@x.com', disabled_at: null },
        error: null,
      }
    }
    if (table === 'hub_users' && op === 'update') return { data: null, error: cfg.flagError ?? null }
    if (table === 'subscription_seats' && op === 'select') return { data: cfg.seat ?? { id: 'seat1' }, error: null }
    if (table === 'subscription_seats' && op === 'update') return { data: null, error: cfg.seatError ?? null }
    if (table === 'lead_notification_prefs' && op === 'select') return { data: cfg.pref ?? { category: 'moving' }, error: null }
    if (table === 'lead_notification_prefs' && op === 'upsert') return { data: null, error: cfg.prefError ?? null }
    return { data: null, error: null }
  }
}

const req = {} as any
const ctx = (id: string) => ({ params: { id } })

beforeEach(() => h.reset())

describe('pure guards', () => {
  it('canManageAccess: elevated any location; owner own location; manager/lite never', () => {
    expect(canManageAccess('super_admin', null, 'locA')).toBe(true)
    expect(canManageAccess('admin', 'locZ', 'locA')).toBe(true)
    expect(canManageAccess('owner', 'locA', 'locA')).toBe(true)
    expect(canManageAccess('owner', 'locA', 'locB')).toBe(false)
    expect(canManageAccess('manager', 'locA', 'locA')).toBe(false)
    expect(canManageAccess('lite_user', 'locA', 'locA')).toBe(false)
  })

  it('isSelfRemoval + wouldOrphanLastOwner', () => {
    expect(isSelfRemoval('u1', 'u1')).toBe(true)
    expect(isSelfRemoval('u1', 'u2')).toBe(false)
    // Only owners can orphan; the last enabled owner (count<=1) is protected.
    expect(wouldOrphanLastOwner('owner', 1)).toBe(true)
    expect(wouldOrphanLastOwner('owner', 2)).toBe(false)
    expect(wouldOrphanLastOwner('manager', 1)).toBe(false)
  })

  it('checkAccessGuards short-circuits in order (permission → self → last-owner)', () => {
    const base = {
      callerRole: 'owner', callerUserId: 'o1', callerLocationId: 'locA',
      targetUserId: 't1', targetRole: 'manager', targetLocationId: 'locA', enabledOwnerCount: 0,
    }
    expect(checkAccessGuards(base, 'remove')).toBeNull()
    expect(checkAccessGuards({ ...base, callerRole: 'manager' }, 'remove')?.code).toBe('forbidden')
    expect(checkAccessGuards({ ...base, targetUserId: 'o1' }, 'remove')?.code).toBe('self_removal')
    expect(checkAccessGuards({ ...base, targetRole: 'owner', enabledOwnerCount: 1 }, 'remove')?.code).toBe('last_owner')
    // restore mode skips the last-owner guard.
    expect(checkAccessGuards({ ...base, targetRole: 'owner', enabledOwnerCount: 1 }, 'restore')).toBeNull()
  })
})

describe('POST — full offboard in one call', () => {
  it('disables the flag, bans auth, frees the seat, and unsubscribes', async () => {
    h.state.respond = scenario()
    const res = await POST(req, ctx('mgr1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, disabled: true, authBanned: true, seatFreed: true, unsubscribed: true })

    // Flag write carries disabled_at + disabled_by=caller.
    const flag = h.state.calls.find((c: any) => c.table === 'hub_users' && c.op === 'update')
    expect(flag.payload.disabled_at).toBeTruthy()
    expect(flag.payload.disabled_by).toBe('owner1')
    // Auth banned with the ~permanent duration.
    expect(h.state.banCalls).toHaveLength(1)
    expect(h.state.banCalls[0].opts.ban_duration).toBe(BAN_DURATION)
    // Seat freed (user_id=null) — pool return, not delete.
    const seat = h.state.calls.find((c: any) => c.table === 'subscription_seats' && c.op === 'update')
    expect(seat.payload.user_id).toBeNull()
    // Notif unsub preserves existing category, flips subscribed=false.
    const pref = h.state.calls.find((c: any) => c.table === 'lead_notification_prefs' && c.op === 'upsert')
    expect(pref.payload.subscribed).toBe(false)
    expect(pref.payload.category).toBe('moving')
    expect(pref.onConflict).toBe('location_id,hub_user_id')
  })

  it('auth-ban FAILURE does not prevent lockout — flag still written, call still ok', async () => {
    h.state.respond = scenario()
    h.state.banThrows = true
    const res = await POST(req, ctx('mgr1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.disabled).toBe(true)
    expect(body.authBanned).toBe(false) // Layer 2 failed…
    // …but Layer 1 (the flag) was written regardless.
    const flag = h.state.calls.find((c: any) => c.table === 'hub_users' && c.op === 'update')
    expect(flag.payload.disabled_at).toBeTruthy()
  })

  it('a disable-flag write FAILURE aborts (never report removed while still writable)', async () => {
    h.state.respond = scenario({ flagError: { message: 'db down' } })
    const res = await POST(req, ctx('mgr1'))
    expect(res.status).toBe(500)
    // Never proceeds to ban when the primary lockout could not be recorded.
    expect(h.state.banCalls).toHaveLength(0)
  })

  it('rejects a MANAGER caller on a direct API hit (403)', async () => {
    h.state.respond = scenario({ caller: { id: 'mgrCaller', role: 'manager', location_id: 'locA' } })
    const res = await POST(req, ctx('mgr1'))
    const body = await res.json()
    expect(res.status).toBe(403)
    expect(body.code).toBe('forbidden')
    expect(h.state.calls.some((c: any) => c.op === 'update')).toBe(false)
  })

  it('rejects self-removal (400)', async () => {
    h.state.respond = scenario({
      caller: { id: 'owner1', role: 'owner', location_id: 'locA' },
      target: { id: 'owner1', role: 'owner', location_id: 'locA', email: 'o@x.com', disabled_at: null },
      enabledOwners: 2,
    })
    const res = await POST(req, ctx('owner1'))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.code).toBe('self_removal')
  })

  it('rejects removing the LAST owner (409)', async () => {
    h.state.getUser = { data: { user: { id: 'admin1' } } }
    h.state.respond = scenario({
      caller: { id: 'admin1', role: 'super_admin', location_id: null },
      target: { id: 'owner1', role: 'owner', location_id: 'locA', email: 'o@x.com', disabled_at: null },
      enabledOwners: 1,
    })
    const res = await POST(req, ctx('owner1'))
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('last_owner')
    expect(h.state.calls.some((c: any) => c.op === 'update')).toBe(false)
  })

  it('allows removing a NON-last owner (co-owner present)', async () => {
    h.state.getUser = { data: { user: { id: 'admin1' } } }
    h.state.respond = scenario({
      caller: { id: 'admin1', role: 'super_admin', location_id: null },
      target: { id: 'owner2', role: 'owner', location_id: 'locA', email: 'o2@x.com', disabled_at: null },
      enabledOwners: 2,
    })
    const res = await POST(req, ctx('owner2'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.disabled).toBe(true)
  })
})

describe('PATCH — reactivate restores login only', () => {
  it('clears the flag and unbans, but does NOT re-add a seat', async () => {
    h.state.respond = scenario({
      target: { id: 'mgr1', role: 'manager', location_id: 'locA', email: 'm@x.com', disabled_at: '2026-07-14T00:00:00Z' },
    })
    const res = await PATCH(req, ctx('mgr1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, disabled: false, seatReadded: false })
    // Flag cleared.
    const flag = h.state.calls.find((c: any) => c.table === 'hub_users' && c.op === 'update')
    expect(flag.payload.disabled_at).toBeNull()
    expect(flag.payload.disabled_by).toBeNull()
    // Unbanned.
    expect(h.state.banCalls[0].opts.ban_duration).toBe(UNBAN_DURATION)
    // Crucially: NO seat insert/update — reactivation never bills.
    expect(h.state.calls.some((c: any) => c.table === 'subscription_seats')).toBe(false)
  })

  it('rejects a manager caller (403)', async () => {
    h.state.respond = scenario({ caller: { id: 'm', role: 'manager', location_id: 'locA' } })
    const res = await PATCH(req, ctx('mgr1'))
    expect(res.status).toBe(403)
  })
})
