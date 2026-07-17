// @vitest-environment node
//
// FIRE SAFETY — the outbound-mail notebook (migrations/notification_log.sql)
// must never be able to break, alter, or block a send.
//
// The notebook is an OBSERVER hooked into lib/resend.ts sendEmailDirect. That
// makes it uniquely dangerous: a bug in the logging path sits directly in the
// hot path of every invite, magic-link, drip and lead notification the product
// sends. The failure mode this file exists to prevent is the nasty one — a
// logging fault that flips a genuinely-sent email to { success: false }, so the
// caller reports a send that actually reached the recipient as broken (intake
// pushes a `lead_notification_failed` warning, an operator re-sends, the
// prospect gets two emails). Silently losing a log row is acceptable; lying
// about the send is not.
//
// Pins:
//   • logNotification NEVER throws — not on a { error } insert result, not on
//     a client that throws outright.
//   • A MISSING TABLE is a normal, swallowed outcome. This is the mechanism
//     that lets the logging code ship BEFORE the migration is run in the
//     Supabase editor; if this pin fails, deploying ahead of the migration
//     would break every send in production.
//   • A rejecting logger changes neither sendEmailDirect's return value nor its
//     throwing behavior — on the success path (the dangerous one) AND on the
//     failure path.
//   • A skipped Slack post writes no row.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── The supabase mock the writer inserts through ───────────────────
const h = vi.hoisted(() => {
  const state = {
    inserts: [] as { table: string; row: any }[],
    // What .insert() resolves with; or a throw when `throws` is set.
    resp: { error: null as any },
    throws: null as any,
  }
  return { state }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (table: string) => ({
      insert: (row: any) => {
        h.state.inserts.push({ table, row })
        if (h.state.throws) throw h.state.throws
        return Promise.resolve(h.state.resp)
      },
    }),
  },
}))

const sendSpy = vi.hoisted(() => vi.fn(async () => ({ data: { id: 're-1' }, error: null })))
vi.mock('resend', () => ({ Resend: class { emails = { send: sendSpy } } }))

import { logNotification, logSlackNotification } from '@/lib/notification-log'

const DIRECT = {
  from: 'notifications@beeorganized.com',
  fromName: 'Bee Hub',
  replyTo: 'admin@beeorganized.com',
  subject: 'New lead: Jane',
  html: '<p>hi</p>',
}

beforeEach(() => {
  h.state.inserts = []
  h.state.resp = { error: null }
  h.state.throws = null
  vi.clearAllMocks()
  sendSpy.mockResolvedValue({ data: { id: 're-1' }, error: null } as any)
  vi.unstubAllEnvs()
})

// The rejecting-logger tests below doMock the writer. Unmocking must NOT live
// at the end of a test body: an assertion failure would skip it and leak the
// broken logger into every later test, turning one real failure into a
// cascade of fake ones (observed while mutation-testing this file).
afterEach(() => {
  vi.doUnmock('@/lib/notification-log')
  vi.resetModules()
})

describe('logNotification — never throws', () => {
  it('swallows a { error } insert result (supabase-js resolves, it does not reject)', async () => {
    h.state.resp = { error: { message: 'null value in column "channel"' } }
    await expect(
      logNotification({ channel: 'email', send_status: 'accepted', recipient: 'a@b.com' }),
    ).resolves.toBeUndefined()
  })

  it('swallows a client that throws outright', async () => {
    h.state.throws = new Error('connection refused')
    await expect(
      logNotification({ channel: 'email', send_status: 'accepted', recipient: 'a@b.com' }),
    ).resolves.toBeUndefined()
  })

  // THE ship-before-the-migration pin. Until notification_log.sql is run in the
  // Supabase editor, every insert comes back with exactly this PostgREST error.
  it('swallows "relation does not exist" — so the code can deploy BEFORE the migration runs', async () => {
    h.state.resp = { error: { message: 'relation "notification_log" does not exist' } }
    await expect(
      logNotification({ channel: 'email', send_status: 'accepted', recipient: 'a@b.com' }),
    ).resolves.toBeUndefined()
  })

  it('omits the Half B delivery columns entirely (works against a pre-Half-B schema)', async () => {
    await logNotification({ channel: 'email', send_status: 'accepted', recipient: 'a@b.com' })
    const row = h.state.inserts[0].row
    expect(h.state.inserts[0].table).toBe('notification_log')
    expect('delivery_status' in row).toBe(false)
    expect('delivery_updated_at' in row).toBe(false)
  })

  it('absent context lands as explicit nulls — a system email is a valid, complete row', async () => {
    await logNotification({ channel: 'email', send_status: 'accepted', recipient: 'a@b.com' })
    expect(h.state.inserts[0].row).toMatchObject({
      lead_id: null,
      lead_name: null,
      location_id: null,
      location_slug: null,
      email_kind: null,
    })
  })
})

describe('logSlackNotification', () => {
  it('a SKIP (location never installed Slack) writes NO row', async () => {
    await logSlackNotification({ ok: false, skipped: 'not_connected' }, { lead_id: 'l1' })
    expect(h.state.inserts).toHaveLength(0)
  })

  // The ONE skip that is NOT silent. Every other skip reports an absence (no
  // Slack app installed) — nothing to resolve, so a row would be noise forever.
  // A mute is a DECISION that gets reversed at cutover, and a muted location
  // that logged nothing would be indistinguishable from a broken one.
  it('a MUTED location (notifications_off) DOES write a row — a mute is not an absence', async () => {
    await logSlackNotification(
      { ok: false, skipped: 'notifications_off', mutedReason: 'muted' },
      { lead_id: 'l1', location_slug: 'loc_omaha' },
    )
    expect(h.state.inserts).toHaveLength(1)
    expect(h.state.inserts[0].row).toMatchObject({
      channel: 'slack',
      send_status: 'muted',
      error: 'muted',
      location_slug: 'loc_omaha',
    })
  })

  it('a fail-closed read carries its reason onto the muted row', async () => {
    await logSlackNotification(
      { ok: false, skipped: 'notifications_off', mutedReason: 'read_failed: column does not exist' },
      { lead_id: 'l1' },
    )
    expect(h.state.inserts[0].row).toMatchObject({
      send_status: 'muted',
      error: 'read_failed: column does not exist',
    })
  })

  it('ok → accepted; error → failed, both on the slack channel', async () => {
    await logSlackNotification({ ok: true }, { lead_id: 'l1' })
    await logSlackNotification({ ok: false, error: 'channel_not_found' }, { lead_id: 'l1' })
    expect(h.state.inserts.map(i => i.row)).toMatchObject([
      { channel: 'slack', send_status: 'accepted', error: null },
      { channel: 'slack', send_status: 'failed', error: 'channel_not_found' },
    ])
  })
})

// ── The load-bearing pin ───────────────────────────────────────────
// Everything above proves the writer swallows its own faults. This proves
// sendEmailDirect survives even a writer that DOESN'T — the guard in resend.ts
// (safeLog) rather than the guard in notification-log.ts.
describe('sendEmailDirect — a broken logger cannot corrupt the send result', () => {
  it('a REJECTING logger leaves a successful send reporting success', async () => {
    vi.resetModules()
    vi.doMock('@/lib/notification-log', () => ({
      logNotificationFanout: vi.fn(async () => { throw new Error('logger exploded') }),
    }))
    const { sendEmailDirect } = await import('@/lib/resend')

    const res = await sendEmailDirect({ ...DIRECT, to: 'a@b.com' })

    // The email genuinely went out — Resend returned an id. Reporting anything
    // other than success here would make callers re-send a delivered email.
    expect(res).toEqual({ success: true, id: 're-1' })
  })

  it('a REJECTING logger does not throw out of sendEmailDirect on the failure path either', async () => {
    vi.resetModules()
    vi.doMock('@/lib/notification-log', () => ({
      logNotificationFanout: vi.fn(async () => { throw new Error('logger exploded') }),
    }))
    const { sendEmailDirect } = await import('@/lib/resend')
    const { Resend } = await import('resend')
    ;(new Resend('k').emails.send as any).mockResolvedValue({ data: null, error: { message: 'resend down' } })

    const res = await sendEmailDirect({ ...DIRECT, to: 'a@b.com' })

    expect(res).toEqual({ success: false, error: 'resend down' })
  })
})

// ── The fan-out grain ──────────────────────────────────────────────
describe('sendEmailDirect — one row per recipient, sharing the message id', () => {
  it('a 3-recipient send writes 3 accepted rows with the SAME resend_message_id', async () => {
    vi.resetModules()
    const { sendEmailDirect } = await import('@/lib/resend')

    const res = await sendEmailDirect({
      ...DIRECT,
      to: ['a@b.com', 'c@d.com', 'e@f.com'],
      lead_id: 'lead-1',
      email_kind: 'lead_notification',
    })

    expect(res).toEqual({ success: true, id: 're-1' })
    // This grain is exactly why resend_message_id is INDEXED, not UNIQUE — a
    // unique constraint would reject rows 2 and 3.
    expect(h.state.inserts).toHaveLength(3)
    expect(h.state.inserts.map(i => i.row.recipient)).toEqual(['a@b.com', 'c@d.com', 'e@f.com'])
    for (const { row } of h.state.inserts) {
      expect(row).toMatchObject({
        channel: 'email',
        send_status: 'accepted',
        resend_message_id: 're-1',
        email_kind: 'lead_notification',
        lead_id: 'lead-1',
      })
    }
  })

  it('a Resend error writes failed rows carrying the error, and no message id', async () => {
    vi.resetModules()
    const { sendEmailDirect } = await import('@/lib/resend')
    const { Resend } = await import('resend')
    ;(new Resend('k').emails.send as any).mockResolvedValue({ data: null, error: { message: 'rate limited' } })

    const res = await sendEmailDirect({ ...DIRECT, to: ['a@b.com', 'c@d.com'] })

    expect(res).toEqual({ success: false, error: 'rate limited' })
    expect(h.state.inserts).toHaveLength(2)
    for (const { row } of h.state.inserts) {
      expect(row).toMatchObject({
        send_status: 'failed',
        error: 'rate limited',
        resend_message_id: null,
      })
    }
  })
})
