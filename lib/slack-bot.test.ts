// @vitest-environment node
// Slack bot-token transport (lib/slack-bot.ts) — the ADDITIVE new-lead post.
//
// Pins:
//   • buildLeadSlackMessage is pure mrkdwn: carries the lead fields + the
//     /clients/<id> deep-link as a <url|label> link; blanks → em-dash; and
//     escapes &,<,> so a stray delimiter can't break out of a link.
//   • postToSlack is a quiet no-op (skipped, not error) when the location has
//     no Slack connection — never posts, never throws.
//   • CRITICAL Slack quirk: an HTTP 200 with { ok:false, error } is a LOGICAL
//     failure → { ok:false, error } surfaced (channel_not_found etc.), NOT a
//     false success.
//   • A happy post returns { ok:true } and calls chat.postMessage with the
//     stored channel + bot token.
//   • Never throws — a fetch rejection is caught and returned as { ok:false }.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Per-test control over what the location row read returns.
let LOC_ROW: any = null
const maybeSingleMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase-service', () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: (...a: any[]) => maybeSingleMock(...a),
  }
  return { supabaseService: { from: () => builder } }
})

import {
  buildLeadSlackMessage,
  postToSlack,
  notifyNewLeadSlack,
  SLACK_POST_MESSAGE_URL,
} from '@/lib/slack-bot'

const LEAD = {
  id: 'lead-1',
  name: 'Jane Prospect',
  email: 'jane@example.com',
  phone: '(555) 111-2222',
  project_type: 'Moving',
  request_details: 'I need help packing.',
  preferred_contact: 'Text',
}

beforeEach(() => {
  vi.restoreAllMocks()
  maybeSingleMock.mockReset()
  LOC_ROW = null
  maybeSingleMock.mockImplementation(async () => ({ data: LOC_ROW, error: null }))
})

describe('buildLeadSlackMessage (pure builder)', () => {
  it('renders lead fields, the deep-link, and escapes mrkdwn delimiters', () => {
    const { text } = buildLeadSlackMessage({
      lead: { ...LEAD, name: 'A & B <Co>' },
      locationName: 'Boulder',
      leadUrl: 'https://app.example.com/clients/lead-1',
    })
    expect(text).toContain('New lead for Boulder')
    expect(text).toContain('*Email:* jane@example.com')
    expect(text).toContain('*Project type:* Moving')
    expect(text).toContain('*Preferred contact:* Text')
    // Deep-link as a mrkdwn <url|label> link.
    expect(text).toContain('<https://app.example.com/clients/lead-1|Open this lead in Bee Hub>')
    // & < > escaped in the interpolated name.
    expect(text).toContain('A &amp; B &lt;Co&gt;')
  })

  it('falls back to em-dash for blank fields and omits the link when no URL', () => {
    const { text } = buildLeadSlackMessage({
      lead: { ...LEAD, phone: null, preferred_contact: null, request_details: null },
      locationName: 'Boulder',
      leadUrl: null,
    })
    expect(text).toContain('*Phone:* —')
    expect(text).toContain('*Preferred contact:* —')
    expect(text).not.toContain('Open this lead in Bee Hub')
    expect(text).not.toContain('What they told us')
  })
})

describe('postToSlack', () => {
  it('is a quiet no-op (skipped, not error) when Slack is not connected', async () => {
    LOC_ROW = { slack_connected: false, slack_bot_token: null, slack_channel_id: null }
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any)
    const res = await postToSlack('loc-uuid-1', { text: 'hi' })
    expect(res).toEqual({ ok: false, skipped: 'not_connected' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('treats HTTP 200 with { ok:false } as a logical failure', async () => {
    LOC_ROW = { slack_connected: true, slack_bot_token: 'xoxb-1', slack_channel_id: 'C1' }
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    } as any)
    const res = await postToSlack('loc-uuid-1', { text: 'hi' })
    expect(res).toEqual({ ok: false, error: 'channel_not_found' })
  })

  it('posts to the stored channel with the bot token and returns ok on success', async () => {
    LOC_ROW = { slack_connected: true, slack_bot_token: 'xoxb-secret', slack_channel_id: 'C123' }
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as any)
    const res = await postToSlack('loc-uuid-1', { text: 'hello' })
    expect(res).toEqual({ ok: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchSpy.mock.calls[0] as any[]
    expect(url).toBe(SLACK_POST_MESSAGE_URL)
    expect(opts.headers.Authorization).toBe('Bearer xoxb-secret')
    expect(JSON.parse(opts.body)).toEqual({ channel: 'C123', text: 'hello' })
  })

  it('never throws — a fetch rejection returns { ok:false }', async () => {
    LOC_ROW = { slack_connected: true, slack_bot_token: 'xoxb-1', slack_channel_id: 'C1' }
    vi.spyOn(globalThis, 'fetch' as any).mockRejectedValue(new Error('network down'))
    const res = await postToSlack('loc-uuid-1', { text: 'hi' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('network down')
  })
})

describe('notifyNewLeadSlack', () => {
  it('builds the deep-link from baseUrl and posts', async () => {
    LOC_ROW = { slack_connected: true, slack_bot_token: 'xoxb-1', slack_channel_id: 'C1' }
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true }),
    } as any)
    const res = await notifyNewLeadSlack({
      locationId: 'loc-uuid-1',
      locationName: 'Boulder',
      baseUrl: 'https://app.example.com/',
      lead: LEAD,
    })
    expect(res).toEqual({ ok: true })
    const body = JSON.parse((fetchSpy.mock.calls[0] as any[])[1].body)
    expect(body.channel).toBe('C1')
    expect(body.text).toContain('<https://app.example.com/clients/lead-1|Open this lead in Bee Hub>')
  })
})
