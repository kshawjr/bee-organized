// @vitest-environment node
//
// issue 233 — THE REPLY ACTUALLY SENDS.
//
// The triage box has always been labelled "shown to the submitter on their
// item". Nothing was ever sent. The only surface that rendered a reply was a My
// Items tab reachable from a footer link inside the help panel, so 47 replies
// written into production reached nobody — one owner had been answered 31 times
// and told zero times.
//
// These pin the send DECISION, which is the part that can quietly go wrong:
//
//   1. a new reply sends
//   2. a status change with NO new reply sends nothing        ← Kevin's call
//   3. re-saving the identical reply does not re-send it
//   4. clearing a reply sends nothing
//   5. replying to your own item sends nothing (owners can patch their own
//      location's items, and one already used the box as a self-note)
//   6. a mail failure does NOT fail the save, and is REPORTED, not swallowed
//   7. the send rides sendEmailDirect, so notification_log records it by
//      construction — the assertion is on the rail, not on a re-implementation
//      of the logging
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  const state = {
    rows: {} as Record<string, any>,
    updates: [] as { table: string; arg: any }[],
    updateError: null as any,
  }
  const reset = () => { state.rows = {}; state.updates = []; state.updateError = null }
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'is', 'not']) b[m] = () => b
    b.update = (arg: any) => { state.updates.push({ table, arg }); b.__update = arg; return b }
    b.insert = () => b
    const resolve = () => {
      if (b.__update) {
        if (state.updateError) return { data: null, error: state.updateError }
        return { data: { ...(state.rows[table] || {}), ...b.__update }, error: null }
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
// THE SEAM. sendEmailDirect is the last thing before the Resend SDK and the ONLY
// place notification_log is written — asserting here is asserting both on what
// was sent and on what the notebook will record.
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
import { buildFeedbackReplyEmail, firstNameOf } from '@/lib/feedback-reply-email'

const ITEM = {
  id: 'fb-1',
  location_id: 'loc-1',
  user_id: 'owner-9',
  type: 'bug',
  title: 'Client not moving in system correctly',
  status: 'submitted',
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
  // The caller (an elevated admin) and the item/submitter reads all land on
  // their own tables, so one row each is enough.
  h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null, ...SUBMITTER }
  h.state.rows.feedback_items = { ...ITEM }
})

describe('a new reply sends', () => {
  it('emails the submitter and reports the address back to triage', async () => {
    const { status, body } = await patch({ status: 'planned', admin_response: 'Good catch — fixing this next week.' })
    expect(status).toBe(200)
    expect(direct.fn).toHaveBeenCalledTimes(1)
    const call = direct.fn.mock.calls[0][0] as any
    expect(call.to).toBe(SUBMITTER.email)
    expect(call.email_kind).toBe('feedback_reply')      // the notification_log label
    expect(call.location_id).toBe('loc-1')              // …filed under the right franchise
    expect(call.html).toContain('Good catch')
    expect(body.reply_email).toEqual({ sent: true, to: SUBMITTER.email })
  })

  it('names the new status only when it moved in the same save', async () => {
    await patch({ status: 'planned', admin_response: 'Queued for next week.' })
    expect((direct.fn.mock.calls[0][0] as any).text).toContain('Planned')

    direct.fn.mockClear()
    h.state.rows.feedback_items = { ...ITEM }
    await patch({ status: 'submitted', admin_response: 'Looking into it.' })
    const text = (direct.fn.mock.calls[0][0] as any).text
    expect(text).not.toContain("We've also marked it")
  })
})

describe('a status change with NO new reply sends nothing', () => {
  it('moving submitted → planned on its own mints no email', async () => {
    const { status, body } = await patch({ status: 'planned' })
    expect(status).toBe(200)
    expect(direct.fn).not.toHaveBeenCalled()
    expect(body.reply_email).toBeNull()
  })

  it('even a move all the way to Fixed stays silent', async () => {
    await patch({ status: 'shipped' })
    expect(direct.fn).not.toHaveBeenCalled()
  })
})

describe('the same reply is not re-sent', () => {
  it('re-saving identical text (only whitespace differs) sends nothing', async () => {
    h.state.rows.feedback_items = { ...ITEM, admin_response: 'Already told you this.' }
    const { body } = await patch({ status: 'planned', admin_response: '  Already told you this.  ' })
    expect(direct.fn).not.toHaveBeenCalled()
    expect(body.reply_email).toBeNull()
  })

  it('but genuinely CHANGED text does send', async () => {
    h.state.rows.feedback_items = { ...ITEM, admin_response: 'First answer.' }
    await patch({ admin_response: 'Second answer, with more detail.' })
    expect(direct.fn).toHaveBeenCalledTimes(1)
    expect((direct.fn.mock.calls[0][0] as any).html).toContain('Second answer')
  })
})

describe('the silent cases', () => {
  it('clearing a reply is not a message', async () => {
    h.state.rows.feedback_items = { ...ITEM, admin_response: 'Never mind.' }
    await patch({ admin_response: '' })
    expect(direct.fn).not.toHaveBeenCalled()
    expect(h.state.updates.find(u => u.table === 'feedback_items')!.arg).toMatchObject({
      admin_response: null, admin_response_at: null,
    })
  })

  it('replying to your OWN item mails nobody and says why', async () => {
    // An owner patching their own report — this happens in production.
    authUser.current = { id: 'owner-9' }
    h.state.rows.hub_users = { id: 'owner-9', role: 'owner', location_id: 'loc-1', ...SUBMITTER }
    const { body } = await patch({ admin_response: 'Note to self: I worked out the answer.' })
    expect(direct.fn).not.toHaveBeenCalled()
    expect(body.reply_email).toEqual({ sent: false, skipped: 'replied_to_own_item' })
  })

  it('a submitter with no email on file is reported, not silently dropped', async () => {
    h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null, email: null }
    const { body } = await patch({ admin_response: 'Here you go.' })
    expect(direct.fn).not.toHaveBeenCalled()
    expect(body.reply_email).toEqual({ sent: false, skipped: 'no_submitter_email' })
  })
})

describe('a mail failure never costs the admin their reply', () => {
  it('the save still succeeds, the row is still written, and the failure is reported', async () => {
    direct.fn.mockImplementation(async () => ({ success: false, error: 'Resend rejected the recipient' }))
    const { status, body } = await patch({ status: 'planned', admin_response: 'Fixed in tonight’s release.' })
    expect(status).toBe(200)
    expect(h.state.updates.find(u => u.table === 'feedback_items')!.arg).toMatchObject({
      status: 'planned',
      admin_response: 'Fixed in tonight’s release.',
    })
    expect(body.reply_email).toEqual({ sent: false, error: 'Resend rejected the recipient' })
  })

  it('a thrown send is caught too — the route never 500s over email', async () => {
    direct.fn.mockImplementation(async () => { throw new Error('socket hang up') })
    const { status, body } = await patch({ admin_response: 'Sorry for the wait.' })
    expect(status).toBe(200)
    expect(body.reply_email.sent).toBe(false)
    expect(body.reply_email.error).toContain('socket hang up')
  })

  it('a genuine DATABASE failure still fails the request — only mail is non-fatal', async () => {
    h.state.updateError = { message: 'permission denied' }
    const { status } = await patch({ status: 'planned', admin_response: 'Hello' })
    expect(status).toBe(500)
    expect(direct.fn).not.toHaveBeenCalled()
  })
})

describe('the copy an owner actually receives', () => {
  const built = buildFeedbackReplyEmail({
    recipientName: 'Lynette Ewy',
    itemTitle: 'Clients with archived quotes still showing',
    itemType: 'bug',
    replyText: 'You were right — archived quotes now close the record.',
    link: 'https://hub.example.com/?feedback=1',
  })

  it('says who it is for, what they reported, and what was said back', () => {
    expect(built.subject).toBe('We replied about "Clients with archived quotes still showing"')
    expect(built.text).toContain('Hi Lynette,')
    expect(built.text).toContain('Clients with archived quotes still showing')
    expect(built.text).toContain('You were right')
    expect(built.text).toContain('https://hub.example.com/?feedback=1')
  })

  it('speaks plainly — no status vocabulary, no product jargon, in either part', () => {
    const all = `${built.subject} ${built.text} ${built.html}`.toLowerCase()
    for (const jargon of ['under_review', 'in_progress', 'feedback_items', 'ticket', 'status update', 'triage']) {
      expect(all).not.toContain(jargon)
    }
  })

  it('escapes the reply — a submitter cannot inject markup through triage', () => {
    const evil = buildFeedbackReplyEmail({
      itemTitle: '<script>alert(1)</script>',
      replyText: 'watch out for <b>this</b>',
      link: 'https://x.test/?feedback=1',
    })
    expect(evil.html).not.toContain('<script>')
    expect(evil.html).not.toContain('<b>this</b>')
    expect(evil.html).toContain('&lt;script&gt;')
  })

  it('degrades to a warm greeting rather than addressing someone by their email', () => {
    expect(firstNameOf('lynette@kcbees.com')).toBeNull()
    expect(firstNameOf('Lynette Ewy')).toBe('Lynette')
    expect(buildFeedbackReplyEmail({ itemTitle: 't', replyText: 'r', recipientName: 'a@b.com' }).text)
      .toContain('Hi there,')
  })

  it('an idea gets the word "idea", a bug gets "report"', () => {
    expect(buildFeedbackReplyEmail({ itemTitle: 't', replyText: 'r', itemType: 'feature' }).text)
      .toContain('idea you sent in')
    expect(buildFeedbackReplyEmail({ itemTitle: 't', replyText: 'r', itemType: 'bug' }).text)
      .toContain('report you sent in')
  })
})
