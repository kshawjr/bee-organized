// @vitest-environment node
//
// AN OWNER MAY TAKE BACK THEIR OWN REPORT — and only their own.
//
// Entry ede746a9, in Ankur Patel's words: "I submitted a couple because I
// thought they were bugs, but after taking a minute or two navigating around
// the CRM, I was just looking in the wrong place."
//
// What is pinned here, and why each pin matters:
//
//   1. THE EDIT WINDOW IS THE REPLY BOX'S SHADOW. Edit is open exactly while
//      the reply box is shut, and shuts exactly when it opens — so a submitter
//      is never left with neither. Pinned as an INVARIANT over every shape a
//      card can be in, not as a handful of examples, because "until the team
//      replies" is one moment and this is the assertion that it stays one.
//   2. THE 48 LEGACY REPLIES LOCK IT. Production has 48 answered entries whose
//      reply lives only in admin_response — feedback_replies is newer than
//      they are. A gate that read the thread table alone would hand every one
//      of those owners an Edit button on a conversation. The mirror case — a
//      cleared admin_response with the authored thread row still standing —
//      locks too.
//   3. THE ROUTE REFUSES, NOT THE SCREEN. Every refusal below is asserted
//      against the handler with a forged request, because a hidden button is
//      not a rule. Someone else's report is 403 for a colleague at the SAME
//      location — the wall is user_id, never location_id.
//   4. A DELETE LEAVES NOTHING DANGLING. The named list: the thread (cascade),
//      the Storage objects (removed here — nothing else points at them), the
//      unedited draft What's new line (swept), the tombstone (written), and
//      the published line (LEFT ALONE, deliberately).
//   5. CLEANUP CANNOT FAIL THE DELETE. The row is gone before any of it runs;
//      a missing tombstone table or a Storage hiccup must not tell the owner
//      their delete failed when it did not.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, any>,
    inserts: [] as { table: string; arg: any }[],
    updates: [] as { table: string; arg: any; filters: Record<string, any> }[],
    deletes: [] as { table: string; filters: Record<string, any> }[],
    storageRemoved: [] as string[][],
    storageError: null as any,
    insertError: {} as Record<string, any>,
    updateResult: null as any,
  }
  const reset = () => {
    state.rows = {}; state.inserts = []; state.updates = []; state.deletes = []
    state.storageRemoved = []; state.storageError = null; state.insertError = {}
    state.updateResult = null
  }
  const makeBuilder = (table: string) => {
    const b: any = {}
    const filters: Record<string, any> = {}
    b.__filters = filters
    b.select = () => b
    b.order = () => b
    b.limit = () => b
    b.in = () => b
    b.is = (col: string, val: any) => { filters[col] = val; return b }
    b.eq = (col: string, val: any) => { filters[col] = val; return b }
    b.update = (arg: any) => { state.updates.push({ table, arg, filters }); b.__update = arg; return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); b.__insert = arg; return b }
    b.delete = () => { b.__delete = true; return b }
    const resolve = () => {
      if (b.__insert) {
        const err = state.insertError[table]
        return err ? { data: null, error: err } : { data: { id: 'new-1', ...b.__insert }, error: null }
      }
      if (b.__delete) { state.deletes.push({ table, filters }); return { data: null, error: null } }
      if (b.__update) {
        if (state.updateResult !== undefined && state.updateResult !== null && table === 'feedback_items') {
          return state.updateResult
        }
        return { data: { ...(state.rows[table] || {}), ...b.__update }, error: null }
      }
      return { data: state.rows[table] ?? null, error: null }
    }
    b.single = () => Promise.resolve(resolve())
    b.maybeSingle = () => Promise.resolve(resolve())
    b.then = (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej)
    return b
  }
  const storage = {
    from: () => ({
      remove: async (paths: string[]) => {
        state.storageRemoved.push(paths)
        return { data: null, error: state.storageError }
      },
    }),
  }
  return { state, reset, makeBuilder, storage }
})

const authUser = vi.hoisted(() => ({ current: { id: 'owner-9' } as any }))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t), storage: h.storage },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: authUser.current } })) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))

import { PATCH, DELETE } from '@/app/api/feedback/[id]/route'
import {
  ownerCanEdit, ownerCanDelete, feedbackEditLocked, EDIT_LOCKED,
} from '@/lib/feedback-edit'
import { ownerCanReply, threadInvitesReply } from '@/lib/feedback-replies'
import { deleteConfirmSentence } from '@/components/feedback/OwnerFeedbackScreen'

// ─── 1. where the line is ─────────────────────────────────────────────

const teamRow = (over: any = {}) => ({
  id: 'r1', author_id: 'admin-1', author_role: 'team',
  body: 'We are on it.', created_at: '2026-08-20T10:00:00Z', ...over,
})
const ownerRow = (over: any = {}) => teamRow({ id: 'r2', author_id: 'owner-9', author_role: 'owner', body: 'Still broken.', ...over })

describe('the edit window', () => {
  it('is open on a fresh report and shut once the team has spoken', () => {
    const fresh = { user_id: 'owner-9', status: 'submitted', admin_response: null, replies: [] }
    expect(ownerCanEdit(fresh, 'owner-9')).toBe(true)

    // A thread reply from the team.
    expect(ownerCanEdit({ ...fresh, replies: [teamRow()] }, 'owner-9')).toBe(false)
  })

  it('LOCKS on a legacy reply that exists only in admin_response — the 48', () => {
    // 48 production entries are answered with no thread row at all: their reply
    // predates feedback_replies. A thread-only gate would unlock every one.
    const legacy = {
      user_id: 'owner-9', status: 'under_review',
      admin_response: 'We fixed this last week.', admin_response_at: '2026-07-31T09:00:00Z',
      replies: [],
    }
    expect(feedbackEditLocked(legacy)).toBe(true)
    expect(ownerCanEdit(legacy, 'owner-9')).toBe(false)
  })

  it('LOCKS when a cleared reply leaves the authored thread row standing', () => {
    // Triage rule 3: clearing the box nulls admin_response. The team's words
    // are still on the owner's card, from the thread row — so it is still
    // "the team replied".
    const cleared = { user_id: 'owner-9', status: 'submitted', admin_response: null, replies: [teamRow()] }
    expect(feedbackEditLocked(cleared)).toBe(true)
  })

  it('does NOT lock on a status move on its own', () => {
    // Triage moves statuses far more often than it writes words. A middle
    // status is the team filing, not the team replying.
    for (const status of ['under_review', 'planned', 'in_progress']) {
      expect(feedbackEditLocked({ user_id: 'owner-9', status, admin_response: null, replies: [] })).toBe(false)
    }
  })

  it('DOES lock once the item is closed, even with no words on it', () => {
    // An ending is the team saying something, and the bare-Fixed email
    // explicitly invites a reply — so there is a box to use instead.
    for (const status of ['shipped', 'answered', 'declined']) {
      expect(feedbackEditLocked({ user_id: 'owner-9', status, admin_response: null, replies: [] })).toBe(true)
    }
  })

  it("is another person's business on somebody else's report", () => {
    const mine = { user_id: 'owner-9', status: 'submitted', admin_response: null, replies: [] }
    expect(ownerCanEdit(mine, 'colleague-2')).toBe(false)
    expect(ownerCanDelete(mine, 'colleague-2')).toBe(false)
    expect(ownerCanDelete(mine, 'owner-9')).toBe(true)
  })

  // THE INVARIANT. Not an example — every shape a card can be in.
  it('never leaves the submitter with neither an Edit nor a Reply', () => {
    const statuses = ['submitted', 'under_review', 'planned', 'in_progress', 'answered', 'shipped', 'declined']
    const threads = [[], [teamRow()], [ownerRow()], [teamRow(), ownerRow()]]
    const responses = [null, '', 'We are on it.']
    for (const status of statuses) {
      for (const replies of threads) {
        for (const admin_response of responses) {
          const item = { user_id: 'owner-9', status, admin_response, admin_response_at: null, replies }
          const canEdit = ownerCanEdit(item, 'owner-9')
          const canReply = ownerCanReply(item, 'owner-9')
          // Exactly one, always. Never both, never neither.
          expect([canEdit, canReply].filter(Boolean)).toHaveLength(1)
          // And the reply box is the mirror of the lock, by construction.
          expect(canEdit).toBe(!threadInvitesReply(item))
        }
      }
    }
  })
})

// ─── 2 & 3. the route ─────────────────────────────────────────────────

const ITEM = {
  id: 'fb-1', user_id: 'owner-9', location_id: 'loc-1', type: 'bug',
  title: 'Sort not permanent', status: 'submitted',
  created_at: '2026-08-21T21:15:42Z',
  attachments: [{ path: '7ac341f2/1ffe82ca-shot.png', name: 'shot.png' }],
  admin_response: null, admin_response_at: null, is_internal: false, replies: [],
}

const patch = async (body: any, id = 'fb-1') => {
  const res = await PATCH({ json: async () => body } as any, { params: { id } })
  return { status: res.status, body: await res.json() }
}
const del = async (id = 'fb-1') => {
  const res = await DELETE({} as any, { params: { id } })
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  h.reset()
  authUser.current = { id: 'owner-9' }
  h.state.rows.hub_users = { id: 'owner-9', role: 'owner', location_id: 'loc-1' }
  h.state.rows.feedback_items = { ...ITEM }
  h.state.rows.help_releases = null
})

describe('PATCH /api/feedback/[id] — editing your own report', () => {
  it('saves a new title and description before any reply', async () => {
    const { status } = await patch({
      title: '  Sort does not stick  ',
      description: '  The A-Z sort resets on refresh.  ',
    })
    expect(status).toBe(200)
    const up = h.state.updates.find(u => u.table === 'feedback_items')
    expect(up!.arg).toEqual({ title: 'Sort does not stick', description: 'The A-Z sort resets on refresh.' })
    // Belt and braces: the write itself is scoped to the owner's own row.
    expect(up!.filters).toMatchObject({ id: 'fb-1', user_id: 'owner-9' })
  })

  it('REFUSES after a reply — at the route, with nothing written', async () => {
    h.state.rows.feedback_items = { ...ITEM, replies: [teamRow()] }
    const { status, body } = await patch({ title: 'Sneaking a change in' })
    expect(status).toBe(409)
    expect(body.error).toBe(EDIT_LOCKED)
    expect(h.state.updates.filter(u => u.table === 'feedback_items')).toHaveLength(0)
  })

  it('REFUSES after a legacy reply too — the 48-entry case, server-side', async () => {
    h.state.rows.feedback_items = {
      ...ITEM, admin_response: 'Fixed last week.', admin_response_at: '2026-07-31T09:00:00Z',
    }
    const { status, body } = await patch({ description: 'Actually never mind' })
    expect(status).toBe(409)
    expect(body.error).toBe(EDIT_LOCKED)
    expect(h.state.updates.filter(u => u.table === 'feedback_items')).toHaveLength(0)
  })

  it("REFUSES a colleague at the SAME location — the wall is user_id, not location_id", async () => {
    authUser.current = { id: 'colleague-2' }
    h.state.rows.hub_users = { id: 'colleague-2', role: 'manager', location_id: 'loc-1' }
    const { status, body } = await patch({ title: 'Not mine to change' })
    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
    expect(h.state.updates.filter(u => u.table === 'feedback_items')).toHaveLength(0)
  })

  it('REFUSES a corporate admin too — no elevated override on this door', async () => {
    authUser.current = { id: 'admin-1' }
    h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null }
    const { status } = await patch({ title: 'Putting words in their mouth' })
    expect(status).toBe(403)
  })

  it('accepts neither type nor status — those are triage’s, not the owner’s', async () => {
    const { status, body } = await patch({ type: 'feature', status: 'shipped' })
    expect(status).toBe(400)
    expect(body.error).toBe('no_fields_to_update')
    expect(h.state.updates.filter(u => u.table === 'feedback_items')).toHaveLength(0)
  })

  it('refuses an empty or oversized title and description', async () => {
    expect((await patch({ title: '   ' })).status).toBe(400)
    expect((await patch({ title: 'x'.repeat(101) })).status).toBe(400)
    expect((await patch({ description: '' })).status).toBe(400)
    expect((await patch({ description: 'x'.repeat(2001) })).status).toBe(400)
    expect(h.state.updates.filter(u => u.table === 'feedback_items')).toHaveLength(0)
  })

  it('401s a signed-out caller and 404s an id that is not there', async () => {
    authUser.current = null
    expect((await patch({ title: 'hello' })).status).toBe(401)
    authUser.current = { id: 'owner-9' }
    h.state.rows.feedback_items = null
    expect((await patch({ title: 'hello' })).status).toBe(404)
  })

  it('answers 404 — never 403 — on an internal item, so a guess learns nothing', async () => {
    // An internal item may carry this owner's location tag. A 403 would confirm
    // that engineering work about their franchise exists.
    h.state.rows.feedback_items = { ...ITEM, user_id: 'admin-1', is_internal: true }
    const { status, body } = await patch({ title: 'probing' })
    expect(status).toBe(404)
    expect(body.error).toBe('not_found')
  })
})

// ─── 4 & 5. the delete ────────────────────────────────────────────────

describe('DELETE /api/feedback/[id] — taking it back', () => {
  it('really deletes the row, scoped to the owner’s own id', async () => {
    const { status, body } = await del()
    expect(status).toBe(200)
    expect(body).toEqual({ deleted: true, id: 'fb-1' })
    const d = h.state.deletes.find(x => x.table === 'feedback_items')
    expect(d).toBeTruthy()
    expect(d!.filters).toMatchObject({ id: 'fb-1', user_id: 'owner-9' })
  })

  it('has NO reply gate — an answered report can still be withdrawn', async () => {
    h.state.rows.feedback_items = {
      ...ITEM, status: 'shipped', admin_response: 'Fixed in this week’s release.',
      admin_response_at: '2026-08-30T09:00:00Z',
    }
    expect((await del()).status).toBe(200)
    expect(h.state.deletes.some(x => x.table === 'feedback_items')).toBe(true)
  })

  it('takes the Storage objects with it — nothing else points at them', async () => {
    await del()
    expect(h.state.storageRemoved).toEqual([['7ac341f2/1ffe82ca-shot.png']])
  })

  it('sweeps an UNEDITED line out of the open What’s new draft, and only that one', async () => {
    h.state.rows.help_releases = { id: 'rel-draft' }
    await del()
    const sweep = h.state.updates.find(u => u.table === 'help_release_items')
    expect(sweep).toBeTruthy()
    expect(sweep!.arg.deleted_at).toBeTruthy()
    // The four filters are the whole rule: this draft, this entry, never
    // edited, not already removed. A PUBLISHED release is not the draft, so it
    // is never reached; an EDITED line fails edited_at IS NULL.
    expect(sweep!.filters).toMatchObject({
      release_id: 'rel-draft', feedback_item_id: 'fb-1',
      edited_at: null, deleted_at: null,
    })
  })

  it('leaves the What’s new line alone when there is no open draft', async () => {
    h.state.rows.help_releases = null
    await del()
    expect(h.state.updates.filter(u => u.table === 'help_release_items')).toHaveLength(0)
  })

  it('writes the tombstone — who, what, and whether we had replied', async () => {
    h.state.rows.feedback_items = {
      ...ITEM, admin_response: 'We are on it.', admin_response_at: '2026-08-30T09:00:00Z',
    }
    await del()
    const tomb = h.state.inserts.find(i => i.table === 'feedback_deletions')
    expect(tomb!.arg).toMatchObject({
      feedback_item_id: 'fb-1', user_id: 'owner-9', location_id: 'loc-1',
      type: 'bug', title: 'Sort not permanent', status: 'submitted',
      had_reply: true, deleted_by: 'owner-9',
    })
    // The words themselves are NOT kept. This is a real delete.
    expect(tomb!.arg).not.toHaveProperty('description')
    expect(tomb!.arg).not.toHaveProperty('attachments')
  })

  it('records had_reply false when nobody ever answered', async () => {
    await del()
    const tomb = h.state.inserts.find(i => i.table === 'feedback_deletions')
    expect(tomb!.arg.had_reply).toBe(false)
  })

  it('STILL SUCCEEDS when the tombstone table is not there yet', async () => {
    // The migration is held; Kevin runs it. The report is already gone by the
    // time this runs, so a 500 here would be a lie.
    h.state.insertError.feedback_deletions = {
      code: '42P01', message: 'relation "feedback_deletions" does not exist',
    }
    const { status, body } = await del()
    expect(status).toBe(200)
    expect(body.deleted).toBe(true)
  })

  it('STILL SUCCEEDS when the Storage cleanup fails', async () => {
    h.state.storageError = { message: 'bucket unreachable' }
    expect((await del()).status).toBe(200)
  })

  it("REFUSES someone else's report — same location, server-side, nothing deleted", async () => {
    authUser.current = { id: 'colleague-2' }
    h.state.rows.hub_users = { id: 'colleague-2', role: 'manager', location_id: 'loc-1' }
    const { status, body } = await del()
    expect(status).toBe(403)
    expect(body.error).toBe('forbidden')
    expect(h.state.deletes).toHaveLength(0)
    expect(h.state.storageRemoved).toHaveLength(0)
    expect(h.state.inserts.filter(i => i.table === 'feedback_deletions')).toHaveLength(0)
  })

  it('REFUSES a corporate admin on an owner’s report', async () => {
    authUser.current = { id: 'admin-1' }
    h.state.rows.hub_users = { id: 'admin-1', role: 'admin', location_id: null }
    expect((await del()).status).toBe(403)
    expect(h.state.deletes).toHaveLength(0)
  })

  it('401s a signed-out caller and deletes nothing', async () => {
    authUser.current = null
    expect((await del()).status).toBe(401)
    expect(h.state.deletes).toHaveLength(0)
  })
})

// ─── the words on the confirmation ────────────────────────────────────

describe('the delete confirmation', () => {
  it('leads with the irreversible part, not "are you sure?"', () => {
    const s = deleteConfirmSentence({ attachments: [], replies: [] })
    expect(s).toBe('This deletes your report for good — we can’t get it back.')
    expect(s.toLowerCase()).not.toContain('are you sure')
  })

  it('names the files when there are files to lose', () => {
    expect(deleteConfirmSentence({ attachments: [{ path: 'a' }], replies: [] }))
      .toContain('and the file you sent goes with it')
    expect(deleteConfirmSentence({ attachments: [{ path: 'a' }, { path: 'b' }], replies: [] }))
      .toContain('and the 2 files you sent go with it')
  })

  it('says the answer goes too when the team has written back', () => {
    expect(deleteConfirmSentence({ attachments: [], admin_response: 'We fixed it.' }))
      .toContain('along with what the team wrote back')
    expect(deleteConfirmSentence({ attachments: [], replies: [teamRow()] }))
      .toContain('along with what the team wrote back')
  })
})
