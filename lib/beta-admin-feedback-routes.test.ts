// @vitest-environment node
//
// THE ADMIN FEEDBACK REDESIGN — the server half.
//
//   · assigned_to: a claim. Elevated callers only; the caller's own id or null,
//     nothing else; written to assigned_to and to no other column.
//   · looks_shipped: a boolean tick, elevated only, and it persists.
//   · neither one is news — no email, no status move, no release-note seed.
//   · STUCK IS NOT A STATUS: a hand-set move INTO 'submitted' on a replied item
//     is refused; the reply floor from ee2cc9e still works exactly as before.
//   · the list route names the assignee for the team, and strips both fields
//     for an owner.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, any>,
    listRows: [] as any[],
    updates: [] as { table: string; arg: any }[],
    inserts: [] as { table: string; arg: any }[],
  }
  const reset = () => { state.rows = {}; state.listRows = []; state.updates = []; state.inserts = [] }
  const makeBuilder = (table: string) => {
    const b: any = {}
    const filters: any = {}
    let inIds: any[] | null = null
    for (const m of ['select', 'order', 'limit', 'is', 'not']) b[m] = () => b
    b.in = (_c: string, v: any[]) => { inIds = v; return b }
    b.eq = (c: string, v: any) => { filters[c] = v; return b }
    b.update = (arg: any) => { state.updates.push({ table, arg }); b.__update = arg; return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); b.__insert = arg; return b }
    const resolve = () => {
      if (b.__insert) return { data: { id: `${table}-new`, ...b.__insert }, error: null }
      if (b.__update) return { data: { ...(state.rows[table] || {}), ...b.__update }, error: null }
      if (table === 'feedback_items' && state.listRows.length && !filters.id) return { data: state.listRows, error: null }
      if (table === 'hub_users' && inIds) return { data: (state.rows.people || []).filter((p: any) => inIds!.includes(p.id)), error: null }
      if (table === 'hub_users' && filters.id && state.rows.people) {
        const p = (state.rows.people as any[]).find(x => x.id === filters.id)
        if (p && filters.id !== state.rows.hub_users?.id) return { data: p, error: null }
      }
      return { data: state.rows[table] ?? null, error: null }
    }
    b.single = () => Promise.resolve(resolve())
    b.maybeSingle = () => Promise.resolve(resolve())
    b.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej)
    return b
  }
  return { state, reset, makeBuilder }
})

const authUser = vi.hoisted(() => ({ current: { id: 'admin-1' } as any }))
const direct = vi.hoisted(() => ({ fn: vi.fn(async () => ({ success: true, id: 'msg_1' })) }))

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/resend', () => ({ sendEmailDirect: direct.fn }))

import { PATCH } from '@/app/api/admin/feedback/[id]/route'
import { GET } from '@/app/api/admin/feedback/route'

const ITEM = {
  id: 'fb-1', location_id: 'loc-1', user_id: 'owner-9', type: 'feature',
  title: 'Snooze Button', status: 'planned',
  admin_response: 'Yes — on the list.' as string | null, is_internal: false,
  assigned_to: null as string | null, looks_shipped: false,
}
const ADMIN = { id: 'admin-1', role: 'super_admin', location_id: null, email: 'kevin@bmave.com', full_name: 'Kevin Brown', first_name: 'Kevin' }
const OWNER = { id: 'owner-9', role: 'owner', location_id: 'loc-1', email: 'ankur@pb.com', full_name: 'Ankur Patel', first_name: 'Ankur' }

const patch = async (body: any) => {
  const req = { json: async () => body } as any
  const res = await PATCH(req, { params: { id: 'fb-1' } })
  return { status: res.status, body: await res.json() }
}
const stored = () => h.state.updates.filter(u => u.table === 'feedback_items').map(u => u.arg)

beforeEach(() => {
  h.reset()
  direct.fn.mockClear()
  authUser.current = { id: 'admin-1' }
  h.state.rows.hub_users = { ...ADMIN }
  h.state.rows.people = [ADMIN, { id: 'admin-2', full_name: 'Leslie Mullins', first_name: 'Leslie', email: 'leslie@x.com' }]
  h.state.rows.feedback_items = { ...ITEM }
})

// ─── the claim ──────────────────────────────────────────────────────

describe('claiming and releasing', () => {
  it('claiming writes the caller’s id to assigned_to — and only to assigned_to', async () => {
    const { status, body } = await patch({ assigned_to: 'admin-1' })
    expect(status).toBe(200)
    expect(stored()).toEqual([{ assigned_to: 'admin-1' }])
    expect(body.assigned_to).toBe('admin-1')
    expect(body.assigned_to_name).toBe('Kevin Brown')
  })

  it('releasing writes null to assigned_to', async () => {
    h.state.rows.feedback_items = { ...ITEM, assigned_to: 'admin-2' }
    const { status } = await patch({ assigned_to: null })
    expect(status).toBe(200)
    expect(stored()).toEqual([{ assigned_to: null }])
  })

  it('nobody assigns work to somebody else from here', async () => {
    const { status, body } = await patch({ assigned_to: 'admin-2' })
    expect(status).toBe(400)
    expect(body.error).toBe('assign_self_or_null_only')
    expect(stored()).toEqual([])
  })

  it('an owner cannot claim — 403 naming the field, not a silent drop', async () => {
    authUser.current = { id: 'owner-9' }
    h.state.rows.hub_users = { ...OWNER }
    const { status, body } = await patch({ assigned_to: 'owner-9' })
    expect(status).toBe(403)
    expect(body.error).toBe('assignment_requires_admin')
    expect(stored()).toEqual([])
  })

  it('a claim is not news: no email, no status, no seed', async () => {
    await patch({ assigned_to: 'admin-1' })
    expect(direct.fn).not.toHaveBeenCalled()
    expect(stored()[0].status).toBeUndefined()
    expect(h.state.inserts).toEqual([])
  })
})

// ─── the tick ───────────────────────────────────────────────────────

describe('looks_shipped', () => {
  it('ticking persists true, and the row comes back ticked', async () => {
    const { status, body } = await patch({ looks_shipped: true })
    expect(status).toBe(200)
    expect(stored()).toEqual([{ looks_shipped: true }])
    expect(body.looks_shipped).toBe(true)
  })

  it('unticking persists false', async () => {
    h.state.rows.feedback_items = { ...ITEM, looks_shipped: true }
    await patch({ looks_shipped: false })
    expect(stored()).toEqual([{ looks_shipped: false }])
  })

  it('only a real boolean — the string "true" is a bug upstream', async () => {
    const { status } = await patch({ looks_shipped: 'true' })
    expect(status).toBe(400)
    expect(stored()).toEqual([])
  })

  it('owners cannot tick it', async () => {
    authUser.current = { id: 'owner-9' }
    h.state.rows.hub_users = { ...OWNER }
    const { status } = await patch({ looks_shipped: true })
    expect(status).toBe(403)
  })

  it('ticking sends nothing', async () => {
    await patch({ looks_shipped: true })
    expect(direct.fn).not.toHaveBeenCalled()
  })
})

// ─── Stuck ──────────────────────────────────────────────────────────

describe('Stuck cannot be set by hand', () => {
  it('moving a replied item back to submitted is refused', async () => {
    for (const from of ['planned', 'under_review', 'in_progress', 'answered', 'shipped', 'declined']) {
      h.reset()
      h.state.rows.hub_users = { ...ADMIN }
      h.state.rows.feedback_items = { ...ITEM, status: from }
      const { status, body } = await patch({ status: 'submitted' })
      expect(status, from).toBe(400)
      expect(body.error).toBe('stuck_is_not_settable')
      expect(stored()).toEqual([])
    }
  })

  it('…even alongside a new reply, when the item was not at submitted', async () => {
    const { status } = await patch({ status: 'submitted', admin_response: 'More words.' })
    expect(status).toBe(400)
  })

  it('an UNREPLIED item may still go back to submitted — that is not Stuck', async () => {
    h.state.rows.feedback_items = { ...ITEM, admin_response: null, status: 'under_review' }
    const { status } = await patch({ status: 'submitted' })
    expect(status).toBe(200)
    expect(stored()[0].status).toBe('submitted')
  })

  it('clearing the reply in the same save makes it not-Stuck, so it is allowed', async () => {
    const { status } = await patch({ status: 'submitted', admin_response: null })
    expect(status).toBe(200)
  })

  it('the reply floor (ee2cc9e) is untouched: a reply with "submitted" on a submitted item stores answered', async () => {
    h.state.rows.feedback_items = { ...ITEM, status: 'submitted', admin_response: null }
    const { status, body } = await patch({ status: 'submitted', admin_response: 'Here is how.' })
    expect(status).toBe(200)
    expect(body.status).toBe('answered')
  })
})

// ─── the list route ─────────────────────────────────────────────────

describe('the list names who has it for the team, and hides both fields from owners', () => {
  const ROWS = [
    { ...ITEM, id: 'a', assigned_to: 'admin-2', looks_shipped: true, submitter: { full_name: 'Ankur Patel', email: 'a@x' }, location: { name: 'Palm Beach' } },
    { ...ITEM, id: 'b', assigned_to: null, submitter: { full_name: 'Ankur Patel', email: 'a@x' }, location: { name: 'Palm Beach' } },
  ]
  const get = async () => {
    const req = { nextUrl: new URL('http://x/api/admin/feedback') } as any
    const res = await GET(req)
    return { status: res.status, body: await res.json() }
  }

  it('elevated: assigned_to, its name, and looks_shipped ride on each row', async () => {
    h.state.listRows = ROWS
    const { status, body } = await get()
    expect(status).toBe(200)
    const a = body.items.find((i: any) => i.id === 'a')
    expect(a.assigned_to).toBe('admin-2')
    expect(a.assigned_to_name).toBe('Leslie Mullins')
    expect(a.looks_shipped).toBe(true)
    expect(body.items.find((i: any) => i.id === 'b').assigned_to_name).toBeNull()
  })

  it('owner: neither field reaches the browser', async () => {
    authUser.current = { id: 'owner-9' }
    h.state.rows.hub_users = { ...OWNER }
    h.state.listRows = ROWS
    const { status, body } = await get()
    expect(status).toBe(200)
    for (const it of body.items) {
      expect('assigned_to' in it).toBe(false)
      expect('assigned_to_name' in it).toBe(false)
      expect('looks_shipped' in it).toBe(false)
    }
  })
})
