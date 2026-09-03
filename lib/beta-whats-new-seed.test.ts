// @vitest-environment node
//
// WHAT'S NEW — MARKING FIXED SEEDS ONE LINE, ONCE, AND CHANGES NOTHING ELSE.
//
// The feedback PATCH route gained one extra insert on the transition INTO
// shipped. These pin that the insert is exactly that and nothing more:
//
//   · into shipped → ONE help_release_items row: the entry's title verbatim,
//     the group from its type, an empty body, the entry id as provenance,
//     edited_at NULL ("their words"); this week's draft is opened if none
//   · re-saving an already-shipped item seeds nothing
//   · a reply with no status move seeds nothing; a middle status seeds nothing
//   · an owner marking their own location's item Fixed seeds nothing
//   · an internal item seeds nothing
//   · a duplicate (unique index) is a no-op; a missing table is a no-op; a
//     throw is a no-op — the save is 200 and the Fixed email still goes
//   · the feedback row gets the same single update it always did, and the
//     response shape (reply_email) is untouched
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, any>,
    updates: [] as { table: string; arg: any; filters: any }[],
    inserts: [] as { table: string; arg: any }[],
    insertError: null as any,
    insertThrows: false,
    draftRow: null as any,
  }
  const reset = () => { state.rows = {}; state.updates = []; state.inserts = []; state.insertError = null; state.insertThrows = false; state.draftRow = null }
  const makeBuilder = (table: string) => {
    const b: any = {}
    const filters: any = {}
    for (const m of ['select', 'in', 'order', 'limit', 'is', 'not']) b[m] = () => b
    b.eq = (c: string, v: any) => { filters[c] = v; return b }
    b.update = (arg: any) => { state.updates.push({ table, arg, filters }); b.__update = arg; return b }
    b.insert = (arg: any) => {
      if (state.insertThrows && table.startsWith('help_release')) throw new Error('network down')
      state.inserts.push({ table, arg }); b.__insert = arg; return b
    }
    const resolve = () => {
      if (b.__insert) {
        if (state.insertError && table.startsWith('help_release')) return { data: null, error: state.insertError }
        return { data: { id: `${table}-new`, ...b.__insert }, error: null }
      }
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

const ITEM = {
  id: 'fb-1', location_id: 'loc-1', user_id: 'owner-9', type: 'bug',
  title: 'Inbox has a circle 1', status: 'planned', admin_response: null as string | null, is_internal: false,
}
const SUBMITTER = { email: 'lynette@kcbees.com', full_name: 'Lynette Ewy', first_name: 'Lynette' }

const patch = async (body: any) => {
  const req = { json: async () => body } as any
  const res = await PATCH(req, { params: { id: 'fb-1' } })
  return { status: res.status, body: await res.json() }
}
const seedInserts = () => h.state.inserts.filter(i => i.table === 'help_release_items')
const draftInserts = () => h.state.inserts.filter(i => i.table === 'help_releases')

beforeEach(() => {
  h.reset()
  direct.fn.mockClear()
  direct.fn.mockImplementation(async () => ({ success: true, id: 'msg_1' }))
  authUser.current = { id: 'admin-1' }
  h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null, ...SUBMITTER }
  h.state.rows.feedback_items = { ...ITEM }
  h.state.draftRow = { id: 'r-draft', status: 'draft', week_start: '2026-08-28', publish_on: '2026-09-03' }
})

describe('into shipped seeds one line', () => {
  it('inserts the line in the owner’s words with the entry as provenance', async () => {
    const { status, body } = await patch({ status: 'shipped' })
    expect(status).toBe(200)
    expect(seedInserts()).toHaveLength(1)
    expect(seedInserts()[0].arg).toEqual({
      release_id: 'r-draft', group: 'fixed', title: 'Inbox has a circle 1', body: null,
      feedback_item_id: 'fb-1', edited_at: null, created_by: 'admin-1', updated_by: 'admin-1',
    })
    // the draft already existed — nothing opened
    expect(draftInserts()).toEqual([])
    // the announcement still goes, and the response is what it always was
    expect(direct.fn).toHaveBeenCalledTimes(1)
    expect(body.reply_email).toEqual({ sent: true, to: SUBMITTER.email, kind: 'shipped' })
    expect(body.status).toBe('shipped')
  })

  it('a feature becomes a New line; a question becomes Changed', async () => {
    h.state.rows.feedback_items = { ...ITEM, type: 'feature', title: 'A way to export the list' }
    await patch({ status: 'shipped' })
    expect(seedInserts()[0].arg).toMatchObject({ group: 'new', title: 'A way to export the list' })
    h.reset(); h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', ...SUBMITTER }
    h.state.draftRow = { id: 'r-draft', status: 'draft' }
    h.state.rows.feedback_items = { ...ITEM, type: 'question' }
    await patch({ status: 'shipped' })
    expect(seedInserts()[0].arg.group).toBe('changed')
  })

  it('reclassified in the same save, the line takes the NEW type', async () => {
    await patch({ status: 'shipped', type: 'feature' })
    expect(seedInserts()[0].arg.group).toBe('new')
  })

  it('opens this week’s draft when none is open — Friday to Thursday', async () => {
    h.state.draftRow = null
    await patch({ status: 'shipped' })
    expect(draftInserts()).toHaveLength(1)
    const d = draftInserts()[0].arg
    expect(d.status).toBe('draft')
    expect(new Date(`${d.week_start}T00:00:00Z`).getUTCDay()).toBe(5)
    expect(new Date(`${d.publish_on}T00:00:00Z`).getUTCDay()).toBe(4)
    expect(seedInserts()[0].arg.release_id).toBe('help_releases-new')
  })
})

describe('into answered seeds a QUESTION line', () => {
  it('title as the question, the latest reply as the answer, in their words — and no name anywhere', async () => {
    h.state.rows.feedback_items = { ...ITEM, type: 'question', title: 'Do archived Jobber quotes close the deal?', admin_response: 'Yes — see 4b526e6, archiving now closes it. Told Janet on the phone too.' }
    const { status, body } = await patch({ status: 'answered' })
    expect(status).toBe(200)
    expect(body.status).toBe('answered')
    expect(seedInserts()).toHaveLength(1)
    const arg = seedInserts()[0].arg
    expect(arg).toEqual({
      release_id: 'r-draft', group: 'question',
      title: 'Do archived Jobber quotes close the deal?',
      body: 'Yes — see 4b526e6, archiving now closes it. Told Janet on the phone too.',
      feedback_item_id: 'fb-1', edited_at: null, created_by: 'admin-1', updated_by: 'admin-1',
    })
    // the reply is a STARTING POINT: it lands raw (edited_at null) so it is never shown or posted as-is
    expect(arg.edited_at).toBeNull()
    // no owner identity of any kind rides along
    expect(Object.keys(arg).sort()).toEqual(['body', 'created_by', 'edited_at', 'feedback_item_id', 'group', 'release_id', 'title', 'updated_by'])
    expect(JSON.stringify(arg)).not.toMatch(/owner-9|lynette|Lynette|kcbees|user_id/)
    // answered sends no email on its own (issue 233 rule 2) — unchanged
    expect(direct.fn).not.toHaveBeenCalled()
  })
  it('a reply written in the same save is the answer', async () => {
    h.state.rows.feedback_items = { ...ITEM, type: 'question', title: 'Can I see which drips went out?', admin_response: null }
    await patch({ status: 'answered', admin_response: 'Open the client and look at the Timeline.' })
    expect(seedInserts()[0].arg).toMatchObject({ group: 'question', body: 'Open the client and look at the Timeline.' })
    expect(direct.fn).toHaveBeenCalledTimes(1) // the reply email, exactly as before
  })
  it('re-saving an already-answered item seeds nothing', async () => {
    h.state.rows.feedback_items = { ...ITEM, status: 'answered' }
    await patch({ status: 'answered', admin_response: 'more words' })
    expect(seedInserts()).toEqual([])
  })
  it('an owner marking their own location’s question Answered seeds nothing', async () => {
    authUser.current = { id: 'owner-2' }
    h.state.rows.hub_users = { id: 'owner-2', role: 'owner', location_id: 'loc-1', ...SUBMITTER }
    const { status } = await patch({ status: 'answered' })
    expect(status).toBe(200)
    expect(seedInserts()).toEqual([])
  })
  it('an internal item marked Answered seeds nothing', async () => {
    h.state.rows.feedback_items = { ...ITEM, is_internal: true }
    await patch({ status: 'answered' })
    expect(seedInserts()).toEqual([])
  })
  it('answered, then later fixed: the second seed is refused by the unique index and the save is fine', async () => {
    h.state.rows.feedback_items = { ...ITEM, status: 'answered' }
    h.state.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "help_release_items_feedback_idx"' }
    const { status, body } = await patch({ status: 'shipped' })
    expect(status).toBe(200)
    expect(body.reply_email.sent).toBe(true)
  })
})

describe('nothing else seeds', () => {
  it('re-saving an already-shipped item', async () => {
    h.state.rows.feedback_items = { ...ITEM, status: 'shipped' }
    const { status } = await patch({ status: 'shipped', admin_response: 'a note' })
    expect(status).toBe(200)
    expect(seedInserts()).toEqual([])
  })
  it('a reply with no status move; a move to a middle status; a decline', async () => {
    await patch({ admin_response: 'Thanks, looking at it.' })
    await patch({ status: 'in_progress' })
    await patch({ status: 'declined' })
    expect(seedInserts()).toEqual([])
  })
  it('an owner marking their own location’s item Fixed', async () => {
    authUser.current = { id: 'owner-2' }
    h.state.rows.hub_users = { id: 'owner-2', role: 'owner', location_id: 'loc-1', ...SUBMITTER }
    const { status, body } = await patch({ status: 'shipped' })
    expect(status).toBe(200)
    expect(body.status).toBe('shipped')
    expect(seedInserts()).toEqual([])
  })
  it('an internal item', async () => {
    h.state.rows.feedback_items = { ...ITEM, is_internal: true }
    const { status } = await patch({ status: 'shipped' })
    expect(status).toBe(200)
    expect(seedInserts()).toEqual([])
  })
})

describe('the seed is never fatal', () => {
  it('a duplicate (already seeded) is a quiet no-op — 200, email sent', async () => {
    h.state.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "help_release_items_feedback_idx"' }
    const { status, body } = await patch({ status: 'shipped' })
    expect(status).toBe(200)
    expect(body.reply_email.sent).toBe(true)
    expect(direct.fn).toHaveBeenCalledTimes(1)
  })
  it('the migration not yet run is a quiet no-op — 200, email sent', async () => {
    h.state.insertError = { code: 'PGRST205', message: "Could not find the table 'public.help_release_items' in the schema cache" }
    h.state.draftRow = null
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { status, body } = await patch({ status: 'shipped' })
    expect(status).toBe(200)
    expect(body.status).toBe('shipped')
    expect(direct.fn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
  it('a throw inside the seed is swallowed — 200, email sent', async () => {
    h.state.insertThrows = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { status, body } = await patch({ status: 'shipped' })
    expect(status).toBe(200)
    expect(body.reply_email.sent).toBe(true)
    warn.mockRestore()
  })
  it('the feedback row gets exactly the one update it always got, and no insert', async () => {
    await patch({ status: 'shipped' })
    const fb = h.state.updates.filter(u => u.table === 'feedback_items')
    expect(fb).toHaveLength(1)
    expect(fb[0].arg).toEqual({ status: 'shipped' })
    expect(h.state.inserts.filter(i => i.table === 'feedback_items')).toEqual([])
  })
})
