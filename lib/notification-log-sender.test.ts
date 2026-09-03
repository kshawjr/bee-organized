// @vitest-environment node
//
// 2026-09-03 — THE NOTEBOOK RECORDS WHO AN EMAIL WENT OUT AS.
//
// notification_log recorded the recipient, subject and Resend message id but
// not the From line or the Reply-To, so "every client email still arrives from
// Lynette" took a read of the send path and a look in the Resend dashboard to
// answer. With `sender` and `reply_to` on every email row it is one query.
//
// Pins:
//   • sendEmailDirect stamps sender ("Name <address>") and reply_to on the
//     accepted row AND on a failed row — the failure is when you most want to
//     know who it was going out as.
//   • PRE-MIGRATION SAFETY. Until migrations/notification_log_sender.sql runs,
//     PostgREST rejects an insert naming the new columns. The writer retries
//     once without them, so the row is still logged exactly as before. A row
//     must never be lost to a column that does not exist yet.
//   • A Slack row names neither column — there is no sender identity on that
//     rail — so the retry path is never even reachable for it.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    inserts: [] as { table: string; row: any }[],
    // Responses consumed in order; the last one repeats.
    resps: [] as { error: any }[],
  }
  return { state }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (table: string) => ({
      insert: (row: any) => {
        h.state.inserts.push({ table, row })
        const resp = h.state.resps.length > 1 ? h.state.resps.shift()! : (h.state.resps[0] ?? { error: null })
        return Promise.resolve(resp)
      },
    }),
  },
}))

const sendSpy = vi.hoisted(() => vi.fn(async () => ({ data: { id: 're-1' }, error: null })))
vi.mock('resend', () => ({ Resend: class { emails = { send: sendSpy } } }))

import { sendEmailDirect } from '@/lib/resend'
import { logNotification, logSlackNotification } from '@/lib/notification-log'

const DIRECT = {
  from: 'carol@beeorganized.com',
  fromName: 'Carol Kern',
  replyTo: 'carol@beeorganized.com',
  to: 'client@example.com',
  subject: 'Thank you for reaching out!',
  html: '<p>hi</p>',
  text: 'hi',
  email_kind: 'drip',
}

// PostgREST's wording when a column is not in the schema cache (PGRST204).
const MISSING_SENDER = { error: { message: "Could not find the 'sender' column of 'notification_log' in the schema cache" } }

beforeEach(() => {
  h.state.inserts = []
  h.state.resps = [{ error: null }]
  vi.clearAllMocks()
  sendSpy.mockResolvedValue({ data: { id: 're-1' }, error: null } as any)
})

describe('sendEmailDirect stamps sender + reply_to on the notebook row', () => {
  it('the accepted row says who it went out as and where replies go', async () => {
    const res = await sendEmailDirect(DIRECT as any)
    expect(res).toEqual({ success: true, id: 're-1' })
    expect(h.state.inserts).toHaveLength(1)
    expect(h.state.inserts[0].row).toMatchObject({
      channel: 'email',
      send_status: 'accepted',
      recipient: 'client@example.com',
      sender: 'Carol Kern <carol@beeorganized.com>',
      reply_to: 'carol@beeorganized.com',
      resend_message_id: 're-1',
    })
  })

  it('a FAILED row carries them too — that is when you most want to know', async () => {
    sendSpy.mockResolvedValue({ data: null, error: { message: 'boom', name: 'application_error', statusCode: 500 } } as any)
    const res = await sendEmailDirect(DIRECT as any)
    expect(res.success).toBe(false)
    expect(h.state.inserts[0].row).toMatchObject({
      send_status: 'failed',
      sender: 'Carol Kern <carol@beeorganized.com>',
      reply_to: 'carol@beeorganized.com',
    })
  })

  it('every recipient of a multi-address send gets the same sender on its row', async () => {
    await sendEmailDirect({ ...DIRECT, to: ['a@example.com', 'b@example.com'], cc: ['c@example.com'] } as any)
    expect(h.state.inserts.map(i => i.row.recipient)).toEqual(['a@example.com', 'b@example.com', 'c@example.com'])
    for (const i of h.state.inserts) {
      expect(i.row.sender).toBe('Carol Kern <carol@beeorganized.com>')
      expect(i.row.reply_to).toBe('carol@beeorganized.com')
    }
  })
})

describe('PRE-MIGRATION SAFETY — the row survives a schema without the columns', () => {
  it('retries once WITHOUT sender/reply_to when PostgREST rejects them, and the row lands', async () => {
    h.state.resps = [MISSING_SENDER, { error: null }]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await sendEmailDirect(DIRECT as any)
    expect(res).toEqual({ success: true, id: 're-1' })
    expect(h.state.inserts).toHaveLength(2)
    expect(h.state.inserts[0].row).toHaveProperty('sender')
    expect(h.state.inserts[1].row).not.toHaveProperty('sender')
    expect(h.state.inserts[1].row).not.toHaveProperty('reply_to')
    // Everything else on the retried row is intact — it is the old row exactly.
    expect(h.state.inserts[1].row).toMatchObject({
      channel: 'email', send_status: 'accepted', recipient: 'client@example.com', resend_message_id: 're-1',
    })
    expect(warn.mock.calls.some(c => String(c[0]).includes('notification_log_sender.sql'))).toBe(true)
    warn.mockRestore()
  })

  it('does NOT retry on an unrelated insert error — one attempt, swallowed, as before', async () => {
    h.state.resps = [{ error: { message: 'null value in column "channel"' } }]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      logNotification({ channel: 'email', send_status: 'accepted', recipient: 'a@b.com', sender: 'X <x@y.z>', reply_to: 'x@y.z' }),
    ).resolves.toBeUndefined()
    expect(h.state.inserts).toHaveLength(1)
    warn.mockRestore()
  })

  it('a row with neither field never names the columns, so it cannot trip the retry', async () => {
    await logNotification({ channel: 'email', send_status: 'accepted', recipient: 'a@b.com' })
    expect(h.state.inserts).toHaveLength(1)
    expect(h.state.inserts[0].row).not.toHaveProperty('sender')
    expect(h.state.inserts[0].row).not.toHaveProperty('reply_to')
  })

  it('a Slack row names neither column', async () => {
    await logSlackNotification({ ok: true }, { location_slug: 'loc_kc' })
    expect(h.state.inserts).toHaveLength(1)
    expect(h.state.inserts[0].row).toMatchObject({ channel: 'slack', send_status: 'accepted' })
    expect(h.state.inserts[0].row).not.toHaveProperty('sender')
    expect(h.state.inserts[0].row).not.toHaveProperty('reply_to')
  })
})
