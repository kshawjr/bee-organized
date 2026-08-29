// @vitest-environment node
//
// THE CONVERSATION ON A FEEDBACK ITEM — thread storage, both write doors, and
// the location wall the thread rides on.
//
// What is pinned, and why each pin matters:
//
//   1. buildFeedbackThread merges the 47 legacy single replies (admin_response,
//      no thread row) into the thread WITHOUT double-showing a reply that was
//      dual-written — and shows a freshly-saved reply immediately even while
//      the embedded rows are a stale snapshot from list load.
//   2. The triage PATCH appends an AUTHORED thread row (who + when) alongside
//      the admin_response it has always written — the test the brief names:
//      "an admin can reply and the reply is stored with author and timestamp".
//   3. POST /api/feedback/[id]/replies is the SUBMITTER's door and nobody
//      else's — a caller from another location (or the same one) gets 403, an
//      internal item answers 404, and the pre-migration state fails calm (503)
//      rather than pretending the words were saved.
//   4. The admin list read scopes a location-bound caller to their own
//      location server-side — the wall that makes "an owner from a different
//      location cannot see it" true for threads, which ride the item rows.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, any>,
    listData: [] as any[],
    inserts: [] as { table: string; arg: any }[],
    updates: [] as { table: string; arg: any }[],
    insertError: null as any,
    eqs: [] as { table: string; col: string; val: any }[],
  }
  const reset = () => {
    state.rows = {}; state.listData = []; state.inserts = []; state.updates = []
    state.insertError = null; state.eqs = []
  }
  const makeBuilder = (table: string) => {
    const b: any = {}
    b.select = () => b
    b.order = () => b
    b.in = () => b
    b.is = () => b
    b.not = () => b
    b.limit = () => b
    b.eq = (col: string, val: any) => { state.eqs.push({ table, col, val }); return b }
    b.update = (arg: any) => { state.updates.push({ table, arg }); b.__update = arg; return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); b.__insert = arg; return b }
    const resolve = () => {
      if (b.__insert) {
        if (state.insertError) return { data: null, error: state.insertError }
        return { data: { id: 'reply-1', created_at: '2026-08-29T12:00:00Z', ...b.__insert }, error: null }
      }
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

import { POST as postReply } from '@/app/api/feedback/[id]/replies/route'
import { PATCH as adminPatch } from '@/app/api/admin/feedback/[id]/route'
import { GET as adminList } from '@/app/api/admin/feedback/route'
import { buildFeedbackThread, awaitingTeamReply, ownerCanReply, isMissingRepliesTable } from '@/lib/feedback-replies'

const replyRow = (over: any) => ({
  id: 'r1', author_id: 'admin-1', author_role: 'team',
  body: 'We are on it.', created_at: '2026-08-20T10:00:00Z', ...over,
})

// ─── the thread builder ───────────────────────────────────────────────

describe('buildFeedbackThread', () => {
  it('folds a legacy admin_response (no thread rows) in as a team entry', () => {
    const thread = buildFeedbackThread({
      admin_response: 'Fixed last week.', admin_response_at: '2026-07-31T09:00:00Z', replies: [],
    })
    expect(thread).toHaveLength(1)
    expect(thread[0]).toMatchObject({ authorRole: 'team', body: 'Fixed last week.', legacy: true })
  })

  it('does NOT double-show a dual-written reply, and orders oldest first', () => {
    const thread = buildFeedbackThread({
      admin_response: 'Second answer.', admin_response_at: '2026-08-21T10:00:00Z',
      replies: [
        replyRow({ id: 'r2', body: 'Second answer.', created_at: '2026-08-21T10:00:00Z' }),
        replyRow({ id: 'r1', body: 'First answer.', created_at: '2026-08-20T10:00:00Z' }),
      ],
    })
    expect(thread.map(e => e.body)).toEqual(['First answer.', 'Second answer.'])
    expect(thread.every(e => !e.legacy)).toBe(true)
  })

  it('shows a freshly-saved reply even while the embedded rows are stale', () => {
    // The just-saved state: admin_response was updated by PATCH, but the row
    // object still carries the replies snapshot from list load.
    const thread = buildFeedbackThread({
      admin_response: 'Brand new answer.', admin_response_at: '2026-08-29T09:00:00Z',
      replies: [replyRow({ body: 'Old answer.' })],
    })
    expect(thread.map(e => e.body)).toEqual(['Old answer.', 'Brand new answer.'])
  })

  it('an undated legacy reply sorts before dated rows', () => {
    const thread = buildFeedbackThread({
      admin_response: 'Ancient.', admin_response_at: null,
      replies: [replyRow({ author_role: 'owner', body: 'Still broken though.' })],
    })
    expect(thread.map(e => e.body)).toEqual(['Ancient.', 'Still broken though.'])
  })
})

describe('awaitingTeamReply / ownerCanReply', () => {
  it('is true exactly when the owner had the last word', () => {
    const item = {
      admin_response: 'We are on it.', admin_response_at: '2026-08-20T10:00:00Z',
      replies: [
        replyRow({}),
        replyRow({ id: 'r2', author_id: 'owner-9', author_role: 'owner', body: 'It happened again.', created_at: '2026-08-22T10:00:00Z' }),
      ],
    }
    expect(awaitingTeamReply(item)).toBe(true)
    expect(awaitingTeamReply({ ...item, replies: [replyRow({})] })).toBe(false)
    // No conversation at all is "unanswered", not "awaiting" — a different marker.
    expect(awaitingTeamReply({ admin_response: null, replies: [] })).toBe(false)
  })

  it('only the submitter may write back, once the team has spoken — or the item was closed', () => {
    const answered = { user_id: 'owner-9', admin_response: 'Hello.', admin_response_at: null, replies: [] }
    expect(ownerCanReply(answered, 'owner-9')).toBe(true)
    expect(ownerCanReply(answered, 'colleague-2')).toBe(false)
    // Open and never answered: still no box — "add more to my own report"
    // remains a different feature.
    expect(ownerCanReply({ user_id: 'owner-9', admin_response: null, replies: [] }, 'owner-9')).toBe(false)
    // But a CLOSED item invites a reply even with no words on it: the bare
    // Fixed announcement says "tap the button and tell us right on your
    // report", and that invitation must have a box behind it.
    expect(ownerCanReply({ user_id: 'owner-9', status: 'shipped', admin_response: null, replies: [] }, 'owner-9')).toBe(true)
    expect(ownerCanReply({ user_id: 'owner-9', status: 'shipped', admin_response: null, replies: [] }, 'colleague-2')).toBe(false)
  })
})

describe('isMissingRepliesTable', () => {
  it('requires the table to be NAMED — a stray 42P01 about another table is a real error', () => {
    expect(isMissingRepliesTable({ code: '42P01', message: 'relation "feedback_replies" does not exist' })).toBe(true)
    expect(isMissingRepliesTable({ code: 'PGRST200', message: "Could not find a relationship between 'feedback_items' and 'feedback_replies' in the schema cache" })).toBe(true)
    expect(isMissingRepliesTable({ code: '42P01', message: 'relation "other_table" does not exist' })).toBe(false)
  })
})

// ─── POST /api/feedback/[id]/replies — the submitter's door ───────────

const ITEM = { id: 'fb-1', user_id: 'owner-9', is_internal: false }

const post = async (body: any) => {
  const req = { json: async () => body } as any
  const res = await postReply(req, { params: { id: 'fb-1' } })
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  h.reset()
  direct.fn.mockClear()
  authUser.current = { id: 'owner-9' }
  h.state.rows.hub_users = { id: 'owner-9', role: 'owner', location_id: 'loc-1' }
  h.state.rows.feedback_items = { ...ITEM }
})

describe('the submitter replies', () => {
  it('stores the reply with author and timestamp, and stamps the thread seen', async () => {
    const { status, body } = await post({ body: '  It happened again this morning.  ' })
    expect(status).toBe(201)
    const ins = h.state.inserts.find(i => i.table === 'feedback_replies')
    expect(ins).toBeTruthy()
    expect(ins!.arg).toMatchObject({
      feedback_item_id: 'fb-1',
      author_id: 'owner-9',
      author_role: 'owner',
      body: 'It happened again this morning.',
    })
    expect(body.created_at).toBeTruthy()
    // Replying implies having read what was there — reply_seen_at is stamped,
    // scoped to the caller's own row like /api/feedback/seen.
    const seen = h.state.updates.find(u => u.table === 'feedback_items')
    expect(seen).toBeTruthy()
    expect(seen!.arg.reply_seen_at).toBeTruthy()
  })

  it('anyone who is not the submitter gets 403 and writes nothing', async () => {
    authUser.current = { id: 'other-owner' }
    h.state.rows.hub_users = { id: 'other-owner', role: 'owner', location_id: 'loc-2' }
    const { status } = await post({ body: 'Let me butt in.' })
    expect(status).toBe(403)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('an internal item answers 404 to a non-elevated caller — it does not exist for them', async () => {
    h.state.rows.feedback_items = { ...ITEM, is_internal: true }
    const { status } = await post({ body: 'What is this?' })
    expect(status).toBe(404)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('an empty or oversized body is a 400, not a truncation', async () => {
    expect((await post({ body: '   ' })).status).toBe(400)
    expect((await post({ body: 'x'.repeat(2001) })).status).toBe(400)
    expect(h.state.inserts).toHaveLength(0)
  })

  it('before the migration runs the write fails calm — 503, never a fake success', async () => {
    h.state.insertError = { code: 'PGRST205', message: "Could not find the table 'public.feedback_replies' in the schema cache" }
    const { status, body } = await post({ body: 'Words that must not vanish.' })
    expect(status).toBe(503)
    expect(body.error).toBe('replies_not_available_yet')
  })
})

// ─── PATCH /api/admin/feedback/[id] — the team's door ─────────────────

describe('a triage reply is recorded in the thread', () => {
  it('appends an authored team row alongside the admin_response it has always written', async () => {
    authUser.current = { id: 'admin-1' }
    h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null, email: 'lynette@kc.com', full_name: 'Lynette Ewy' }
    h.state.rows.feedback_items = {
      id: 'fb-1', location_id: 'loc-1', user_id: 'owner-9', type: 'bug',
      title: 'Sort not permanent', status: 'submitted', admin_response: null,
    }
    const req = { json: async () => ({ status: 'planned', admin_response: 'On the list for next week.' }) } as any
    const res = await adminPatch(req, { params: { id: 'fb-1' } })
    expect(res.status).toBe(200)

    const ins = h.state.inserts.find(i => i.table === 'feedback_replies')
    expect(ins).toBeTruthy()
    expect(ins!.arg).toMatchObject({
      feedback_item_id: 'fb-1',
      author_id: 'admin-1',
      author_role: 'team',
      body: 'On the list for next week.',
    })
    // The legacy column still carries the latest team reply — every existing
    // consumer (banner, queues, send rules) reads on unchanged.
    const upd = h.state.updates.find(u => u.table === 'feedback_items')
    expect(upd!.arg.admin_response).toBe('On the list for next week.')
    // And the reply still emails the submitter — the thread row is additive,
    // not a replacement for the issue 233 rail.
    expect(direct.fn).toHaveBeenCalledTimes(1)
  })

  it('a status-only save appends NO thread row', async () => {
    authUser.current = { id: 'admin-1' }
    h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null }
    h.state.rows.feedback_items = {
      id: 'fb-1', location_id: 'loc-1', user_id: 'owner-9', type: 'bug',
      title: 'Sort not permanent', status: 'submitted', admin_response: null,
    }
    const req = { json: async () => ({ status: 'under_review' }) } as any
    const res = await adminPatch(req, { params: { id: 'fb-1' } })
    expect(res.status).toBe(200)
    expect(h.state.inserts.filter(i => i.table === 'feedback_replies')).toHaveLength(0)
  })
})

// ─── the location wall the thread rides on ────────────────────────────

describe('the admin list read scopes a location-bound caller server-side', () => {
  it("adds the caller's own location_id as a query predicate — another location's items (and their threads) never reach the browser", async () => {
    authUser.current = { id: 'owner-9' }
    h.state.rows.hub_users = { id: 'owner-9', role: 'owner', location_id: 'loc-1' }
    delete h.state.rows.feedback_items // list read resolves from listData
    h.state.listData = []
    const req = { nextUrl: { searchParams: new URLSearchParams() } } as any
    const res = await adminList(req)
    expect(res.status).toBe(200)
    expect(h.state.eqs).toContainEqual({ table: 'feedback_items', col: 'location_id', val: 'loc-1' })
  })
})
