// @vitest-environment node
//
// REPLYING SETS THE STATUS — the server half.
//
// Four feedback items had a reply on them and still read "With the team": the
// triage modal echoed the status it opened with back on every save, and the
// PATCH route stored whatever status it was sent. The modal no longer does that
// (lib/beta-feedback-reply-sets-status-screens.test.tsx), and the route now has
// a floor of its own, because a stale tab or a forged request must not be able
// to leave a replied item at 'submitted':
//
//   · a team reply to someone else's 'submitted' item, with no status or with
//     an explicit 'submitted', stores 'answered'
//   · an explicit status past 'submitted' is stored as sent
//   · an item already past 'submitted' is never moved by a reply alone
//   · a note on your own item, or an owner's note, answers nothing
//   · the What's new question line still seeds on that move into answered
//   · the reply email names the status in the one shared vocabulary
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, any>,
    updates: [] as { table: string; arg: any }[],
    inserts: [] as { table: string; arg: any }[],
    draftRow: null as any,
  }
  const reset = () => { state.rows = {}; state.updates = []; state.inserts = []; state.draftRow = null }
  const makeBuilder = (table: string) => {
    const b: any = {}
    const filters: any = {}
    for (const m of ['select', 'in', 'order', 'limit', 'is', 'not']) b[m] = () => b
    b.eq = (c: string, v: any) => { filters[c] = v; return b }
    b.update = (arg: any) => { state.updates.push({ table, arg }); b.__update = arg; return b }
    b.insert = (arg: any) => { state.inserts.push({ table, arg }); b.__insert = arg; return b }
    const resolve = () => {
      if (b.__insert) return { data: { id: `${table}-new`, ...b.__insert }, error: null }
      if (b.__update) return { data: { ...(state.rows[table] || {}), ...b.__update }, error: null }
      if (table === 'help_releases' && filters.status === 'draft') return { data: state.draftRow, error: null }
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
import { FEEDBACK_STATUS_PLAIN } from '@/lib/feedback-queues'

const ITEM = {
  id: 'fb-1', location_id: 'loc-1', user_id: 'owner-9', type: 'question',
  title: 'How do I see which drips went out?', status: 'submitted',
  admin_response: null as string | null, is_internal: false,
}
const PEOPLE = { email: 'lynette@kcbees.com', full_name: 'Lynette Ewy', first_name: 'Lynette' }

const patch = async (body: any) => {
  const req = { json: async () => body } as any
  const res = await PATCH(req, { params: { id: 'fb-1' } })
  return { status: res.status, body: await res.json() }
}
// The one write to the feedback row — what the route asked the database to store.
const stored = () => h.state.updates.filter(u => u.table === 'feedback_items').map(u => u.arg)
const seedInserts = () => h.state.inserts.filter(i => i.table === 'help_release_items')

beforeEach(() => {
  h.reset()
  direct.fn.mockClear()
  authUser.current = { id: 'admin-1' }
  h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null, ...PEOPLE }
  h.state.rows.feedback_items = { ...ITEM }
  h.state.draftRow = { id: 'r-draft', status: 'draft' }
})

describe('a reply on a submitted item stores answered', () => {
  it('a reply with NO status stores answered, not submitted', async () => {
    const { status, body } = await patch({ admin_response: 'Open the client and look at the Timeline.' })
    expect(status).toBe(200)
    expect(stored()).toHaveLength(1)
    expect(stored()[0].status).toBe('answered')
    expect(body.status).toBe('answered')
  })

  it('a reply with an explicit "submitted" — the old modal, a stale tab, a forged call — still stores answered', async () => {
    await patch({ status: 'submitted', admin_response: 'Open the client and look at the Timeline.' })
    expect(stored()[0].status).toBe('answered')
  })

  it('a reply with an explicit status that is not submitted stores THAT status', async () => {
    for (const s of ['under_review', 'planned', 'in_progress', 'shipped', 'declined']) {
      h.reset()
      h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null, ...PEOPLE }
      h.state.rows.feedback_items = { ...ITEM }
      h.state.draftRow = { id: 'r-draft', status: 'draft' }
      await patch({ status: s, admin_response: 'Some words.' })
      expect(stored()[0].status, s).toBe(s)
    }
  })

  it('an empty or whitespace reply is not a reply — the status is untouched', async () => {
    await patch({ admin_response: '   ' })
    expect(stored()[0].status).toBeUndefined()
  })
})

describe('an item already past submitted is not moved by a reply', () => {
  for (const s of ['under_review', 'planned', 'in_progress', 'answered', 'shipped', 'declined']) {
    it(`a reply on a ${s} item leaves it ${s}`, async () => {
      h.state.rows.feedback_items = { ...ITEM, status: s }
      await patch({ admin_response: 'More words.' })
      expect(stored()[0].status).toBeUndefined()
    })
  }
})

describe('a note answers nothing', () => {
  it('writing on your OWN item leaves it submitted', async () => {
    h.state.rows.feedback_items = { ...ITEM, user_id: 'admin-1' }
    await patch({ admin_response: 'Note to self: check the cron log.' })
    expect(stored()[0].status).toBeUndefined()
  })

  it('an owner writing on their location’s item leaves it submitted', async () => {
    authUser.current = { id: 'owner-2' }
    h.state.rows.hub_users = { id: 'owner-2', role: 'owner', location_id: 'loc-1', ...PEOPLE }
    await patch({ admin_response: 'Adding: it happens on the phone too.' })
    expect(stored()[0].status).toBeUndefined()
  })
})

describe('the What’s new seed still fires on the move into answered', () => {
  it('a reply-only save on a submitted question seeds the question line with that reply as the answer', async () => {
    await patch({ admin_response: 'Open the client and look at the Timeline.' })
    expect(seedInserts()).toHaveLength(1)
    expect(seedInserts()[0].arg).toMatchObject({
      group: 'question', title: ITEM.title, body: 'Open the client and look at the Timeline.', feedback_item_id: 'fb-1',
    })
  })

  it('the old modal’s explicit "submitted" seeds it too', async () => {
    await patch({ status: 'submitted', admin_response: 'Open the client and look at the Timeline.' })
    expect(seedInserts()).toHaveLength(1)
  })

  it('a reply on an item already answered seeds nothing more', async () => {
    h.state.rows.feedback_items = { ...ITEM, status: 'answered', admin_response: 'Earlier words.' }
    await patch({ admin_response: 'More words.' })
    expect(seedInserts()).toEqual([])
  })
})

describe('the reply email names the status in the shared vocabulary', () => {
  it('the floor’s move is named: "We’ve also marked it: Answered."', async () => {
    await patch({ admin_response: 'Open the client and look at the Timeline.' })
    expect(direct.fn).toHaveBeenCalledTimes(1)
    expect((direct.fn.mock.calls[0][0] as any).text).toContain(`We've also marked it: ${FEEDBACK_STATUS_PLAIN.answered}.`)
  })

  it('every status, moved in the same save as a reply, is named with the shared word', async () => {
    for (const s of Object.keys(FEEDBACK_STATUS_PLAIN)) {
      h.reset()
      direct.fn.mockClear()
      h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null, ...PEOPLE }
      h.state.rows.feedback_items = { ...ITEM, status: s === 'under_review' ? 'planned' : 'under_review' }
      h.state.draftRow = { id: 'r-draft', status: 'draft' }
      await patch({ status: s, admin_response: 'Some words.' })
      const text = (direct.fn.mock.calls[0][0] as any).text
      expect(text, s).toContain(`We've also marked it: ${FEEDBACK_STATUS_PLAIN[s]}.`)
    }
  })

  it('the shared words are the agreed ones', () => {
    expect(FEEDBACK_STATUS_PLAIN).toEqual({
      submitted: 'With the team',
      under_review: 'Looking at it',
      planned: 'On the list',
      in_progress: 'Building it now',
      answered: 'Answered',
      shipped: 'Fixed',
      declined: 'Not planned',
    })
  })
})
