// @vitest-environment node
//
// issue 236 — MARKING SOMETHING FIXED TELLS THE PERSON WHO REPORTED IT.
//
// Issue 233 decided a status change alone sends nothing, and for the middle
// states that is right: "Planned" arriving with no words around it is noise.
// Fixed is the exception. It is the news the reporter has been waiting for, it
// explains itself in a way no middle status does, and it is the one status
// where staying quiet is itself the wrong message — the reporter goes on
// believing the bug is live and learns that reporting leads nowhere.
//
// What these pin:
//
//   1. a transition INTO shipped sends, with NO reply written
//   2. …and re-saving an already-shipped item does not send again
//   3. the middle statuses still send nothing (issue 233's rule 2, intact)
//   4. DECLINED still sends nothing on its own — an unexplained "Not planned"
//      is worse than silence, so it still costs someone a written sentence
//   5. the issue 233 guards hold on the new path: no send on your own item, no
//      send with no address, a mail failure never fails the save
//   6. ONE email when a save both ships and replies — the reply, carrying the
//      status, not two messages about one event
//   7. it rides the same rail: sendEmailDirect, so notification_log records it
//      by construction, under the same 'feedback_reply' kind
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
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
// The same seam issue 233 asserts on: the last thing before the Resend SDK and
// the only place notification_log is written.
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
import { buildFeedbackReplyEmail } from '@/lib/feedback-reply-email'

const ITEM = {
  id: 'fb-1',
  location_id: 'loc-1',
  user_id: 'owner-9',
  type: 'bug',
  title: 'Closed Lost clients showing back up in my inbox',
  status: 'planned',
  admin_response: null as string | null,
}

const SUBMITTER = { email: 'lynette@kcbees.com', full_name: 'Lynette Ewy', first_name: 'Lynette' }

const patch = async (body: any) => {
  const req = { json: async () => body } as any
  const res = await PATCH(req, { params: { id: 'fb-1' } })
  return { status: res.status, body: await res.json() }
}
const sent = () => direct.fn.mock.calls[0][0] as any

beforeEach(() => {
  h.reset()
  direct.fn.mockClear()
  direct.fn.mockImplementation(async () => ({ success: true, id: 'msg_1' }))
  authUser.current = { id: 'admin-1' }
  h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null, ...SUBMITTER }
  h.state.rows.feedback_items = { ...ITEM }
})

describe('a transition INTO shipped sends, with no reply written', () => {
  it('emails the submitter off the status change alone', async () => {
    const { status, body } = await patch({ status: 'shipped' })
    expect(status).toBe(200)
    expect(direct.fn).toHaveBeenCalledTimes(1)
    expect(sent().to).toBe(SUBMITTER.email)
    expect(body.reply_email).toEqual({ sent: true, to: SUBMITTER.email, kind: 'shipped' })
  })

  it('rides the SAME rail — one sender, one notification_log kind, right location', async () => {
    await patch({ status: 'shipped' })
    expect(sent().email_kind).toBe('feedback_reply')
    expect(sent().location_id).toBe('loc-1')
  })

  it('re-saving an ALREADY shipped item does not announce it twice', async () => {
    h.state.rows.feedback_items = { ...ITEM, status: 'shipped' }
    const { body } = await patch({ status: 'shipped' })
    expect(direct.fn).not.toHaveBeenCalled()
    expect(body.reply_email).toBeNull()
  })
})

describe('the middle statuses are unchanged — this is one exception, not a policy reversal', () => {
  it('under_review, planned and in_progress each send nothing on their own', async () => {
    for (const status of ['under_review', 'planned', 'in_progress']) {
      h.state.rows.feedback_items = { ...ITEM, status: 'submitted' }
      const { body } = await patch({ status })
      expect(direct.fn).not.toHaveBeenCalled()
      expect(body.reply_email).toBeNull()
    }
  })

  // The declined decision. "Not planned" with no explanation and nobody's name
  // on it is the message most likely to end someone's willingness to report
  // anything again — where Fixed carries its own explanation, a decline's
  // explanation is exactly the part a bare status change omits. So it still
  // costs someone a written sentence.
  it('DECLINED stays silent on its own, and sends when someone writes the reason', async () => {
    const { body } = await patch({ status: 'declined' })
    expect(direct.fn).not.toHaveBeenCalled()
    expect(body.reply_email).toBeNull()

    h.state.rows.feedback_items = { ...ITEM }
    await patch({ status: 'declined', admin_response: 'Jobber owns this screen, so we cannot change it from our side.' })
    expect(direct.fn).toHaveBeenCalledTimes(1)
    expect(sent().text).toContain('Jobber owns this screen')
    expect(sent().text).toContain('Not planned')   // named, by a person, with a reason
  })
})

describe('the issue 233 guards hold on the new path', () => {
  it('marking your OWN report Fixed mails you nothing', async () => {
    authUser.current = { id: 'owner-9' }
    h.state.rows.hub_users = { id: 'owner-9', role: 'owner', location_id: 'loc-1', ...SUBMITTER }
    const { body } = await patch({ status: 'shipped' })
    expect(direct.fn).not.toHaveBeenCalled()
    expect(body.reply_email).toEqual({ sent: false, skipped: 'replied_to_own_item' })
  })

  it('a submitter with no address on file is reported, not silently dropped', async () => {
    h.state.rows.hub_users = { id: 'admin-1', role: 'super_admin', location_id: null, email: null }
    const { body } = await patch({ status: 'shipped' })
    expect(direct.fn).not.toHaveBeenCalled()
    expect(body.reply_email).toEqual({ sent: false, skipped: 'no_submitter_email' })
  })

  it('a mail failure never costs the status change', async () => {
    direct.fn.mockImplementation(async () => ({ success: false, error: 'Resend rejected the recipient' }))
    const { status, body } = await patch({ status: 'shipped' })
    expect(status).toBe(200)
    expect(h.state.updates.find(u => u.table === 'feedback_items')!.arg).toMatchObject({ status: 'shipped' })
    expect(body.reply_email).toEqual({ sent: false, error: 'Resend rejected the recipient' })
  })
})

describe('shipping AND replying in one save is ONE email', () => {
  it('sends the reply, carrying the status — not a second announcement', async () => {
    const { body } = await patch({ status: 'shipped', admin_response: 'Fixed this morning — closed clients stay out of the inbox now.' })
    expect(direct.fn).toHaveBeenCalledTimes(1)
    expect(body.reply_email.kind).toBe('reply')
    const text = sent().text
    expect(text).toContain('Fixed this morning')
    expect(text).toContain("We've also marked it: Fixed")
  })
})

// ── THE COPY, WHEN THERE ARE NO WORDS TO QUOTE ────────────────
// The announcement cannot quote a reply that does not exist, so it must not
// carry the reply email's furniture: no "What we said back:", no empty quote
// rule, and no "We've ALSO marked it: Fixed" — which is not an also when it is
// the entire message.
describe('the announcement email', () => {
  const built = buildFeedbackReplyEmail({
    recipientName: 'Lynette Ewy',
    itemTitle: 'Closed Lost clients showing back up in my inbox',
    itemType: 'bug',
    replyText: '',
    shipped: true,
    statusLabel: 'Fixed',
    link: 'https://hub.example.com/?feedback=1',
  })

  it('leads with the news and names their own report back to them', () => {
    expect(built.subject).toBe('We fixed "Closed Lost clients showing back up in my inbox"')
    expect(built.text).toContain('Hi Lynette,')
    expect(built.text).toContain('the problem you reported is fixed')
    expect(built.text).toContain('Closed Lost clients showing back up in my inbox')
    expect(built.text).toContain('https://hub.example.com/?feedback=1')
  })

  it('quotes nothing, because there is nothing to quote', () => {
    expect(built.text).not.toContain('What we said back')
    expect(built.html).not.toContain('What we said back')
    expect(built.text).not.toContain("We've also marked it")
  })

  it('invites the correction, since nobody is on the other end of this one', () => {
    expect(built.text).toContain('still doesn’t look right')
    expect(built.text).toContain('reply to this email')
  })

  it('an idea was BUILT, not fixed', () => {
    const idea = buildFeedbackReplyEmail({
      itemTitle: 'A way to add several people to the Network at once',
      itemType: 'feature', replyText: '', shipped: true,
    })
    expect(idea.subject).toBe('We built "A way to add several people to the Network at once"')
    expect(idea.text).toContain('the idea you sent in is built')
    expect(idea.text).not.toContain('is fixed')
  })

  it('speaks plainly — no status vocabulary, no product jargon', () => {
    const all = `${built.subject} ${built.text} ${built.html}`.toLowerCase()
    for (const jargon of ['shipped', 'under_review', 'in_progress', 'feedback_items', 'ticket', 'status update', 'triage']) {
      expect(all).not.toContain(jargon)
    }
  })

  it('escapes the title on this path too', () => {
    const evil = buildFeedbackReplyEmail({
      itemTitle: '<script>alert(1)</script>', replyText: '', shipped: true, link: 'https://x.test/?feedback=1',
    })
    expect(evil.html).not.toContain('<script>')
    expect(evil.html).toContain('&lt;script&gt;')
  })

  it('a reply that happens to arrive WITH a ship still builds the reply email', () => {
    const withWords = buildFeedbackReplyEmail({
      itemTitle: 't', replyText: 'Fixed it.', shipped: true, statusLabel: 'Fixed',
    })
    expect(withWords.subject).toBe('We replied about "t"')
    expect(withWords.text).toContain('What we said back:')
    expect(withWords.text).toContain("We've also marked it: Fixed")
  })
})
