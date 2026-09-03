// @vitest-environment node
//
// THE QUEUES REDESIGN — the route-level half of "the screen only changed".
//
// The screen moved the corporate-only material into a block the owner mount
// never renders. That is a rendering choice; the guarantee has to hold on the
// server too, so this pins:
//
//   · GET /api/admin/feedback/analysis is 403 for owner and manager, and 401
//     with no session — the analysis never reaches a non-elevated caller,
//     whatever the UI does
//   · PATCH /api/admin/feedback/:id still sends EXACTLY ONE email for a new
//     reply, and NOTHING for a status change alone — Answered included — or
//     for a type change alone. A reply saved together with a status move is
//     still one email, not two.
//
// These mirror lib/beta-feedback-reply-send-233.test.ts on purpose: the
// redesign must leave that contract exactly where it found it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, any>,
    updates: [] as { table: string; arg: any }[],
    inserts: [] as { table: string; arg: any }[],
  }
  const reset = () => { state.rows = {}; state.updates = []; state.inserts = [] }
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'is', 'not', 'ilike']) b[m] = () => b
    b.update = (arg: any) => { state.updates.push({ table, arg }); b.__update = arg; return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); return b }
    const resolve = () => {
      if (b.__update) return { data: { ...(state.rows[table] || {}), ...b.__update }, error: null }
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

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))
vi.mock('@/lib/resend', () => ({ sendEmailDirect: direct.fn }))

import { PATCH } from '@/app/api/admin/feedback/[id]/route'
import { GET as analysisGET } from '@/app/api/admin/feedback/analysis/route'

const ITEM = {
  id: 'fb-1', location_id: 'loc-1', user_id: 'owner-9', type: 'bug',
  title: 'Client not moving in system correctly', status: 'submitted',
  admin_response: null as string | null,
}
const SUBMITTER = { email: 'lynette@kcbees.com', full_name: 'Lynette Ewy', first_name: 'Lynette' }

const patch = async (body: any) => {
  const req = { json: async () => body } as any
  const res = await PATCH(req, { params: { id: 'fb-1' } })
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  h.reset()
  direct.fn.mockClear()
  direct.fn.mockImplementation(async () => ({ success: true, id: 'msg_1' }))
  authUser.current = { id: 'admin-1' }
  h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null, ...SUBMITTER }
  h.state.rows.feedback_items = { ...ITEM }
})

// ─── the analysis is elevated-only on the server ──────────────────────

describe('the corporate analysis never reaches an owner — server side', () => {
  it('403 for an owner', async () => {
    h.state.rows.hub_users = { id: 'admin-1', role: 'owner', location_id: 'loc-1' }
    const res = await analysisGET({} as any)
    expect(res.status).toBe(403)
  })

  it('403 for a manager', async () => {
    h.state.rows.hub_users = { id: 'admin-1', role: 'manager', location_id: 'loc-1' }
    const res = await analysisGET({} as any)
    expect(res.status).toBe(403)
  })

  it('401 with no session', async () => {
    authUser.current = null
    const res = await analysisGET({} as any)
    expect(res.status).toBe(401)
  })
})

// ─── the send rules are exactly where the redesign found them ─────────

describe('a reply still sends exactly one email', () => {
  it('a new reply emails the submitter once', async () => {
    const { status, body } = await patch({ status: 'submitted', admin_response: 'Can you send a screenshot?' })
    expect(status).toBe(200)
    expect(direct.fn).toHaveBeenCalledTimes(1)
    const call = direct.fn.mock.calls[0][0] as any
    expect(call.to).toBe(SUBMITTER.email)
    expect(call.email_kind).toBe('feedback_reply')
    expect(body.reply_email).toEqual({ sent: true, to: SUBMITTER.email, kind: 'reply' })
  })

  it('a reply saved together with a status move is ONE email, not two', async () => {
    await patch({ status: 'planned', admin_response: 'Queued for next week.' })
    expect(direct.fn).toHaveBeenCalledTimes(1)
  })

  it('a reply saved together with a type change is still one email', async () => {
    await patch({ status: 'submitted', type: 'question', admin_response: 'Good question — yes.' })
    expect(direct.fn).toHaveBeenCalledTimes(1)
  })
})

describe('nothing that was silent before now sends', () => {
  it('Answered alone sends nothing', async () => {
    const { status, body } = await patch({ status: 'answered' })
    expect(status).toBe(200)
    expect(direct.fn).not.toHaveBeenCalled()
    expect(body.reply_email).toBeNull()
  })

  it('the middle statuses alone send nothing', async () => {
    for (const s of ['under_review', 'planned', 'in_progress']) {
      h.state.rows.feedback_items = { ...ITEM }
      await patch({ status: s })
    }
    expect(direct.fn).not.toHaveBeenCalled()
  })

  it('Declined alone sends nothing', async () => {
    await patch({ status: 'declined' })
    expect(direct.fn).not.toHaveBeenCalled()
  })

  it('a type change alone sends nothing', async () => {
    const { status, body } = await patch({ status: 'submitted', type: 'question' })
    expect(status).toBe(200)
    expect(direct.fn).not.toHaveBeenCalled()
    expect(body.reply_email).toBeNull()
  })

  it('re-saving the identical reply sends nothing', async () => {
    h.state.rows.feedback_items = { ...ITEM, admin_response: 'Already said this.' }
    await patch({ status: 'planned', admin_response: 'Already said this.' })
    expect(direct.fn).not.toHaveBeenCalled()
  })
})

// Fixed is the ONE status that emails on its own (issue 236). The redesign's
// reply-box line names that exception, and this pins that it is still true —
// removing it would be a behaviour change this build was told not to make.
describe('the one exception is unchanged', () => {
  it('moving INTO Fixed alone still announces itself', async () => {
    const { body } = await patch({ status: 'shipped' })
    expect(direct.fn).toHaveBeenCalledTimes(1)
    expect(body.reply_email).toEqual({ sent: true, to: SUBMITTER.email, kind: 'shipped' })
  })

  it('re-saving an already-Fixed item sends nothing', async () => {
    h.state.rows.feedback_items = { ...ITEM, status: 'shipped' }
    await patch({ status: 'shipped' })
    expect(direct.fn).not.toHaveBeenCalled()
  })
})
