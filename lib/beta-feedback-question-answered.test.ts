// @vitest-environment node
//
// THE QUESTION TYPE AND THE ANSWERED STATUS — the write paths and the
// arithmetic.
//
// A question filed as a bug ends up "Fixed", which tells the owner something
// false about something that was never broken. These pin the new vocabulary at
// every layer the brief names:
//
//   1. a question can be SUBMITTED (owner POST) and STORED as one
//   2. a question can be marked ANSWERED — and 'answered' is a CLOSED status,
//      so an answered question leaves the open count instead of ringing it
//      forever for lack of an ending
//   3. bugs and features are UNAFFECTED: their statuses all still validate,
//      and 'answered' is deliberately legal on them too (owners mislabel; an
//      admin answers whatever came in)
//   4. the read-side filter accepts the third type instead of 400ing
//   5. an admin can CHANGE an entry's type; an owner cannot; the internal-only
//      types stay unreachable; a refiling emails nobody
//   6. the triage work order gives questions a deliberate slot: after broken
//      things (bug, hazard), before decision and feature
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, any>,
    listData: [] as any[],
    inserts: [] as { table: string; arg: any }[],
    updates: [] as { table: string; arg: any }[],
    eqs: [] as { table: string; col: string; val: any }[],
  }
  const reset = () => {
    state.rows = {}; state.listData = []; state.inserts = []; state.updates = []; state.eqs = []
  }
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ['select', 'order', 'in', 'is', 'not', 'limit']) b[m] = () => b
    b.eq = (col: string, val: any) => { state.eqs.push({ table, col, val }); return b }
    b.update = (arg: any) => { state.updates.push({ table, arg }); b.__update = arg; return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); b.__insert = arg; return b }
    const resolve = () => {
      if (b.__insert) return { data: { id: 'row-1', created_at: '2026-08-30T12:00:00Z', ...b.__insert }, error: null }
      if (b.__update) return { data: { ...(state.rows[table] || {}), ...b.__update }, error: null }
      if (state.rows[table] !== undefined) return { data: state.rows[table], error: null }
      return { data: state.listData, error: null }
    }
    b.single = () => Promise.resolve(resolve())
    b.maybeSingle = () => Promise.resolve(resolve())
    b.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej)
    return b
  }
  return { state, reset, makeBuilder }
})

const authUser = vi.hoisted(() => ({ current: { id: 'owner-9' } as any }))
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

import { POST as ownerPost } from '@/app/api/feedback/route'
import { PATCH as adminPatch } from '@/app/api/admin/feedback/[id]/route'
import { GET as adminList } from '@/app/api/admin/feedback/route'
import { isClosedFeedback, sortForTriage, FEEDBACK_STATUS_PLAIN, summarizeFeedbackQueues } from '@/lib/feedback-queues'
import { buildFeedbackReplyEmail } from '@/lib/feedback-reply-email'

const ITEM = {
  id: 'fb-1', location_id: 'loc-1', user_id: 'owner-9', type: 'bug',
  title: 'How do I move her out of nurturing?', status: 'submitted', admin_response: null,
}

beforeEach(() => {
  h.reset()
  direct.fn.mockClear()
  authUser.current = { id: 'owner-9' }
  h.state.rows.hub_users = { id: 'owner-9', role: 'owner', location_id: 'loc-1', email: 'o@x.com', full_name: 'Owner Nine' }
  h.state.rows.feedback_items = { ...ITEM }
})

// ─── 1. submitting a question ─────────────────────────────────────────

describe('a question can be submitted and stored', () => {
  it('the owner POST accepts type=question and stores it', async () => {
    const req = { json: async () => ({ type: 'question', title: 'Will editing an address mess up Jobber?', description: 'She moved.' }) } as any
    const res = await ownerPost(req)
    expect(res.status).toBe(201)
    const ins = h.state.inserts.find(i => i.table === 'feedback_items')
    expect(ins).toBeTruthy()
    expect(ins!.arg.type).toBe('question')
    expect(ins!.arg.status).toBe('submitted')
  })

  it('the internal-only types are still refused at the owner door, loudly', async () => {
    for (const type of ['decision', 'hazard', 'chore']) {
      const req = { json: async () => ({ type, title: 't', description: 'd' }) } as any
      const res = await ownerPost(req)
      expect(res.status).toBe(400)
    }
  })
})

// ─── 2 + 3. the answered status ───────────────────────────────────────

describe('answered is a real ending', () => {
  const patchAs = async (role: string, body: any) => {
    authUser.current = { id: 'admin-1' }
    h.state.rows.hub_users = { id: 'admin-1', role, location_id: role === 'owner' ? 'loc-1' : null, email: 'a@x.com' }
    const req = { json: async () => body } as any
    return await adminPatch(req, { params: { id: 'fb-1' } })
  }

  it('a question can be marked answered', async () => {
    h.state.rows.feedback_items = { ...ITEM, type: 'question' }
    const res = await patchAs('super_admin', { status: 'answered' })
    expect(res.status).toBe(200)
    const upd = h.state.updates.find(u => u.table === 'feedback_items')
    expect(upd!.arg.status).toBe('answered')
  })

  it('a bug can be marked answered too — deliberately unrestricted, owners mislabel', async () => {
    const res = await patchAs('super_admin', { status: 'answered' })
    expect(res.status).toBe(200)
  })

  it('answered is CLOSED: it leaves the open count and never goes stale', () => {
    expect(isClosedFeedback('answered')).toBe(true)
    const summary = summarizeFeedbackQueues([
      { status: 'answered', created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z' },
      { status: 'submitted', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
    ])
    expect(summary.open).toBe(1)
    expect(summary.closed).toBe(1)
  })

  it('every pre-existing status still validates — bugs and features are unaffected', async () => {
    for (const status of ['submitted', 'under_review', 'planned', 'in_progress', 'shipped', 'declined']) {
      h.state.rows.feedback_items = { ...ITEM }
      const res = await patchAs('super_admin', { status })
      expect(res.status, `status ${status} should still save`).toBe(200)
    }
  })

  it('marking answered ALONE emails nobody; answered WITH words emails the words', async () => {
    // Alone: rule 2 — a bare middle/closing move says nothing (only Fixed
    // announces itself). Answering IS words, so a wordless 'answered' is an
    // admin bookkeeping act, not news.
    let res = await patchAs('super_admin', { status: 'answered' })
    expect(res.status).toBe(200)
    expect(direct.fn).not.toHaveBeenCalled()

    // With words: the reply email goes, carrying the plain-word status line.
    h.state.rows.feedback_items = { ...ITEM, type: 'question' }
    res = await patchAs('super_admin', { status: 'answered', admin_response: 'Editing the address is safe — Jobber keeps its history.' })
    expect(res.status).toBe(200)
    expect(direct.fn).toHaveBeenCalledTimes(1)
    const call = direct.fn.mock.calls[0][0] as any
    expect(call.text).toContain('Answered')
    // …and the email calls a question a question, not a report.
    expect(call.text).toContain('question')
  })
})

// ─── 4. the read-side filter ──────────────────────────────────────────

describe('filters know the third type', () => {
  it('?type=question is a real predicate now, not a 400', async () => {
    authUser.current = { id: 'admin-1' }
    h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null }
    delete h.state.rows.feedback_items
    h.state.listData = []
    const req = { nextUrl: { searchParams: new URLSearchParams('type=question') } } as any
    const res = await adminList(req)
    expect(res.status).toBe(200)
    expect(h.state.eqs).toContainEqual({ table: 'feedback_items', col: 'type', val: 'question' })
  })

  it('?status=answered filters too', async () => {
    authUser.current = { id: 'admin-1' }
    h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null }
    delete h.state.rows.feedback_items
    h.state.listData = []
    const req = { nextUrl: { searchParams: new URLSearchParams('status=answered') } } as any
    const res = await adminList(req)
    expect(res.status).toBe(200)
    expect(h.state.eqs).toContainEqual({ table: 'feedback_items', col: 'status', val: 'answered' })
  })
})

// ─── 5. reclassification ──────────────────────────────────────────────

describe('an admin can change an entry type', () => {
  const patchAs = async (id: string, role: string, locationId: string | null, body: any) => {
    authUser.current = { id }
    h.state.rows.hub_users = { id, role, location_id: locationId, email: 'x@y.com' }
    const req = { json: async () => body } as any
    return await adminPatch(req, { params: { id: 'fb-1' } })
  }

  it('elevated: bug → question saves, and emails nobody', async () => {
    const res = await patchAs('admin-1', 'super_admin', null, { type: 'question' })
    expect(res.status).toBe(200)
    const upd = h.state.updates.find(u => u.table === 'feedback_items')
    expect(upd!.arg.type).toBe('question')
    expect(direct.fn).not.toHaveBeenCalled()
  })

  it('an owner cannot reclassify — 403 naming the rule, nothing written', async () => {
    const res = await patchAs('owner-9', 'owner', 'loc-1', { type: 'question' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('type_change_requires_admin')
    expect(h.state.updates).toHaveLength(0)
  })

  it('the internal-only types are not reachable through the app, even for an admin', async () => {
    for (const type of ['decision', 'hazard', 'chore']) {
      const res = await patchAs('admin-1', 'super_admin', null, { type })
      expect(res.status, `type ${type} must be refused`).toBe(400)
    }
    expect(h.state.updates).toHaveLength(0)
  })
})

// ─── 6. the work order ────────────────────────────────────────────────

describe('questions have a deliberate slot in the triage order', () => {
  it('after broken things, before decisions and ideas — oldest first within the band', () => {
    const items = [
      { type: 'feature', created_at: '2026-06-01T00:00:00Z' },
      { type: 'question', created_at: '2026-08-02T00:00:00Z' },
      { type: 'bug', created_at: '2026-08-01T00:00:00Z' },
      { type: 'question', created_at: '2026-07-01T00:00:00Z' },
      { type: 'hazard', created_at: '2026-08-03T00:00:00Z' },
    ]
    const sorted = sortForTriage(items as any)
    expect(sorted.map(i => i.type)).toEqual(['bug', 'hazard', 'question', 'question', 'feature'])
    // Oldest question first inside the band — the person waiting longest.
    expect(sorted[2].created_at < sorted[3].created_at).toBe(true)
  })

  it('the plain word for answered exists — the email and pills read from it', () => {
    expect(FEEDBACK_STATUS_PLAIN.answered).toBe('Answered')
    const built = buildFeedbackReplyEmail({
      itemTitle: 'Can we see opens?', itemType: 'question',
      replyText: 'Not yet — here is what we track.', statusLabel: 'Answered', link: '',
    })
    expect(built.text).toContain('the question you sent in')
  })
})
