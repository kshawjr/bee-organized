// @vitest-environment node
// app/api/slack/interactivity — the "Log call" button handler.
//
// Pins the security boundary + the reuse contract:
//   • A bad / missing / stale signature → 401 and NO write (forged requests
//     must never log data).
//   • A verified log_call → resolves the Slack clicker to a hub_user by email
//     and logs the call through the SAME writer the in-record path uses
//     (logCallTouchpoint), attributed to the resolved user.
//   • Unknown clicker → logged with user_id=null (unattributed), still 200.
//   • Every post-verification path acks 200 (never a broken-button 500).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'

const SECRET = 'test-signing-secret'

// ── Mock the DB reads (lead → location → hub_user) ──
const rows = vi.hoisted(() => ({ leads: null as any, locations: null as any, hub_users: null as any }))
vi.mock('@/lib/supabase-service', () => {
  const make = (table: string) => {
    const b: any = {}
    for (const m of ['select', 'eq', 'ilike', 'update']) b[m] = () => b
    b.maybeSingle = async () => ({ data: (rows as any)[table], error: null })
    return b
  }
  return { supabaseService: { from: (t: string) => make(t) } }
})

// ── Mock the Slack user lookup + the shared touchpoint writer ──
const getSlackUserEmail = vi.hoisted(() => vi.fn())
vi.mock('@/lib/slack-bot', () => ({ getSlackUserEmail }))
const logCallTouchpoint = vi.hoisted(() => vi.fn(async () => ({ ok: true, touchpoint: { id: 'tp-1' } })))
vi.mock('@/lib/touchpoints', () => ({ logCallTouchpoint }))

import { POST } from '@/app/api/slack/interactivity/route'

// Build a signed Slack request from a payload object.
function signedReq(payload: any, opts: { ts?: number; secret?: string; badSig?: boolean } = {}) {
  const ts = opts.ts ?? Math.floor(Date.now() / 1000)
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`
  const sig = opts.badSig
    ? 'v0=deadbeef'
    : 'v0=' + createHmac('sha256', opts.secret ?? SECRET).update(`v0:${ts}:${raw}`).digest('hex')
  return {
    text: async () => raw,
    headers: { get: (k: string) => (k === 'x-slack-request-timestamp' ? String(ts) : k === 'x-slack-signature' ? sig : null) },
  } as any
}

const logCallPayload = {
  actions: [{ action_id: 'log_call', value: 'lead-1' }],
  user: { id: 'U123' },
  response_url: 'https://hooks.slack.com/actions/resp',
}

beforeEach(() => {
  vi.restoreAllMocks()
  process.env.SLACK_SIGNING_SECRET = SECRET
  rows.leads = { id: 'lead-1', location_uuid: 'loc-uuid-1', name: 'Jane' }
  rows.locations = { id: 'loc-uuid-1', slack_bot_token: 'xoxb-1', slack_connected: true }
  rows.hub_users = null
  getSlackUserEmail.mockReset().mockResolvedValue(null)
  logCallTouchpoint.mockReset().mockResolvedValue({ ok: true, touchpoint: { id: 'tp-1' } })
  vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) } as any)
})

describe('signature verification (the security boundary)', () => {
  it('rejects a forged signature with 401 and writes nothing', async () => {
    const res = await POST(signedReq(logCallPayload, { badSig: true }))
    expect(res.status).toBe(401)
    expect(logCallTouchpoint).not.toHaveBeenCalled()
  })

  it('rejects a stale timestamp (replay) with 401', async () => {
    const res = await POST(signedReq(logCallPayload, { ts: Math.floor(Date.now() / 1000) - 60 * 10 }))
    expect(res.status).toBe(401)
    expect(logCallTouchpoint).not.toHaveBeenCalled()
  })

  it('rejects when no signing secret is configured', async () => {
    delete process.env.SLACK_SIGNING_SECRET
    const res = await POST(signedReq(logCallPayload))
    expect(res.status).toBe(401)
    expect(logCallTouchpoint).not.toHaveBeenCalled()
  })
})

describe('verified log_call', () => {
  it('attributes the call to the resolved hub_user and acks 200', async () => {
    getSlackUserEmail.mockResolvedValue('jane@bmave.com')
    rows.hub_users = { id: 'hub-9', full_name: 'Jane Staff', first_name: 'Jane' }

    const res = await POST(signedReq(logCallPayload))
    expect(res.status).toBe(200)
    // Reuses the in-record writer, attributed to the mapped user.
    expect(logCallTouchpoint).toHaveBeenCalledWith({
      leadId: 'lead-1',
      locationUuid: 'loc-uuid-1',
      userId: 'hub-9',
    })
    // Ephemeral confirmation names the actor.
    const ephemeral = (globalThis.fetch as any).mock.calls.find((c: any[]) => c[0] === 'https://hooks.slack.com/actions/resp')
    expect(ephemeral).toBeTruthy()
    expect(JSON.parse(ephemeral[1].body).text).toContain('Jane Staff')
  })

  it('logs unattributed (user_id null) when the clicker is not a known hub_user', async () => {
    getSlackUserEmail.mockResolvedValue('stranger@nowhere.com')
    rows.hub_users = null // no match

    const res = await POST(signedReq(logCallPayload))
    expect(res.status).toBe(200)
    expect(logCallTouchpoint).toHaveBeenCalledWith({
      leadId: 'lead-1',
      locationUuid: 'loc-uuid-1',
      userId: null,
    })
    const ephemeral = (globalThis.fetch as any).mock.calls.find((c: any[]) => c[0] === 'https://hooks.slack.com/actions/resp')
    expect(JSON.parse(ephemeral[1].body).text.toLowerCase()).toContain('unattributed')
  })

  it('ignores payloads without a log_call action (acks 200, no write)', async () => {
    const res = await POST(signedReq({ actions: [{ action_id: 'something_else', value: 'x' }], user: { id: 'U1' } }))
    expect(res.status).toBe(200)
    expect(logCallTouchpoint).not.toHaveBeenCalled()
  })
})
