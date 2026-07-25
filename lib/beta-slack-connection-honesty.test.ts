// @vitest-environment node
//
// Connection honesty — a dead Slack token must not leave the UI claiming
// "Connected".
//
// Before this, a revoked token or an uninstalled app left slack_connected=true
// forever: the SlackCard showed a green "Connected · #leads" while every single
// lead card failed, so the one person who could fix it had no signal at all.
//
// Pins:
//   • a DEAD-token error (invalid_auth / token_revoked / account_inactive)
//     clears the connection through the shared disconnect helper;
//   • a CHANNEL error (not_in_channel / channel_not_found) does NOT — the token
//     is fine, and clearing it would make the owner reinstall for nothing;
//   • the clear is fail-soft: a failing teardown never changes what postToSlack
//     returns, so it can never reach back into the email send or the response.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const maybeSingleMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase-service', () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: (...a: any[]) => maybeSingleMock(...a),
  }
  return { supabaseService: { from: () => builder } }
})

const disconnectSlackFromLocation = vi.hoisted(() => vi.fn(async () => ({ error: null })))
vi.mock('@/lib/slack-disconnect', () => ({ disconnectSlackFromLocation }))

import { postToSlack } from '@/lib/slack-bot'

const CONNECTED = {
  data: { slack_connected: true, slack_bot_token: 'xoxb-dead', slack_channel_id: 'C1' },
  error: null,
}

// Slack's "HTTP 200 but logically failed" shape.
const slackSays = (error: string) =>
  vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, error }),
  } as any)

beforeEach(() => {
  vi.restoreAllMocks()
  maybeSingleMock.mockReset().mockResolvedValue(CONNECTED)
  disconnectSlackFromLocation.mockReset().mockResolvedValue({ error: null })
})

describe('a dead token clears the connection', () => {
  for (const err of ['invalid_auth', 'token_revoked', 'account_inactive']) {
    it(`${err} → connection cleared, error still surfaced unchanged`, async () => {
      slackSays(err)
      const res = await postToSlack('loc-uuid-1', { text: 'hi' })

      expect(disconnectSlackFromLocation).toHaveBeenCalledWith('loc-uuid-1')
      // The caller's contract is untouched — same shape as any other failure.
      expect(res).toEqual({ ok: false, error: err })
    })
  }
})

describe('a channel problem does NOT clear the connection', () => {
  for (const err of ['not_in_channel', 'channel_not_found', 'is_archived']) {
    it(`${err} → connection left intact (the token still works)`, async () => {
      slackSays(err)
      const res = await postToSlack('loc-uuid-1', { text: 'hi' })

      expect(disconnectSlackFromLocation).not.toHaveBeenCalled()
      expect(res).toEqual({ ok: false, error: err })
    })
  }
})

describe('the teardown is fail-soft', () => {
  it('a failing disconnect does not change what postToSlack returns', async () => {
    slackSays('invalid_auth')
    disconnectSlackFromLocation.mockResolvedValue({ error: 'db exploded' })

    const res = await postToSlack('loc-uuid-1', { text: 'hi' })
    expect(res).toEqual({ ok: false, error: 'invalid_auth' })
  })

  it('a THROWN disconnect is swallowed — postToSlack still never throws', async () => {
    slackSays('token_revoked')
    disconnectSlackFromLocation.mockRejectedValue(new Error('boom'))

    await expect(postToSlack('loc-uuid-1', { text: 'hi' })).resolves.toEqual({
      ok: false,
      error: 'token_revoked',
    })
  })

  it('a successful post clears nothing', async () => {
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as any)

    const res = await postToSlack('loc-uuid-1', { text: 'hi' })
    expect(res).toEqual({ ok: true })
    expect(disconnectSlackFromLocation).not.toHaveBeenCalled()
  })
})
