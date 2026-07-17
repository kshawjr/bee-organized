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

// notifyNewLeadSlack is gated on notifications_live. Mocked live:true here so
// these tests keep pinning the TRANSPORT — and mocked rather than left real
// because resolveNotificationsLive reads through the same mocked
// supabaseService builder below, so an unmocked gate would consume this file's
// single queued location row and every post would read as muted. The gate's own
// behavior is pinned in beta-notifications-live-gate.test.ts.
const notificationsLiveMock = vi.hoisted(() =>
  vi.fn(async () => ({ live: true }) as any),
)
vi.mock('@/lib/notifications-live', () => ({
  resolveNotificationsLive: notificationsLiveMock,
}))

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

describe('buildLeadSlackMessage — top-level text (single-line summary)', () => {
  // The top-level `text` renders ABOVE the attachment card, so it is a one-line
  // summary only — every detail lives in attachments[0].blocks (see next block).
  // The same summary is mirrored onto attachments[0].fallback. The lead NAME is
  // intentionally NOT in the summary — it is the card's headline.
  it('is a single-line "New lead (<location>)" summary with NO lead name, mirrored to fallback', () => {
    const msg = buildLeadSlackMessage({
      lead: { ...LEAD, name: 'A & B <Co>' },
      locationName: 'Boulder',
      leadUrl: 'https://app.example.com/clients/lead-1',
    })
    expect(msg.text).toBe('🐝 New lead (Boulder)')
    // The lead name is NOT in the summary/notification line.
    expect(msg.text).not.toContain('A &amp; B')
    // The old rich detail is NOT in the top-level text — it only lives in the card.
    expect(msg.text).not.toContain('*Email:*')
    expect(msg.text).not.toContain('*Project type:*')
    expect(msg.text).not.toContain('Open this lead in Bee Hub')
    // Attachment carries the same summary as its non-block fallback.
    expect(msg.attachments[0].fallback).toBe(msg.text)
  })

  it('the summary omits the name regardless of the lead name', () => {
    const msg = buildLeadSlackMessage({
      lead: { ...LEAD, name: 'Jane Prospect' },
      locationName: 'Boulder',
      leadUrl: null,
    })
    expect(msg.text).toBe('🐝 New lead (Boulder)')
    expect(msg.attachments[0].fallback).toBe('🐝 New lead (Boulder)')
  })

  it('drops the location parens cleanly when the location is blank', () => {
    const msg = buildLeadSlackMessage({ lead: LEAD, locationName: '   ', leadUrl: null })
    expect(msg.text).toBe('🐝 New lead')
    expect(msg.attachments[0].fallback).toBe('🐝 New lead')
  })
})

describe('buildLeadSlackMessage — card (attachments + blocks)', () => {
  // The card lives in attachments[0].blocks; the attachment color is the stripe.
  const card = (over: Partial<typeof LEAD> = {}, leadUrl: string | null = 'https://app.example.com/clients/lead-1') =>
    buildLeadSlackMessage({ lead: { ...LEAD, ...over }, locationName: 'Boulder', leadUrl })
  const blocksOf = (msg: any) => msg.attachments[0].blocks
  const flat = (blocks: any[]) => JSON.stringify(blocks)
  const actionsOf = (blocks: any[]) => blocks.find((b: any) => b.type === 'actions')

  it('wraps the card in an attachment with a color stripe; trailing divider separates posts', () => {
    const msg = card()
    expect(Array.isArray(msg.attachments)).toBe(true)
    expect(msg.attachments).toHaveLength(1)
    expect(typeof msg.attachments[0].color).toBe('string')
    const blocks = blocksOf(msg)
    expect(blocks[blocks.length - 1]).toEqual({ type: 'divider' })
    // Card starts with the prominent name headline — no eyebrow "New lead" badge.
    expect(flat(blocks)).not.toContain('New lead')
    expect(blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: '*Jane Prospect*' } })
  })

  it('puts the name and "from <source>" on two lines of ONE headline section, then a divider before the grid', () => {
    const blocks = blocksOf(card({ source: 'Instagram' }))
    // Headline: single section, name line 1 + "from <source>" line 2.
    expect(blocks[0]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: '*Jane Prospect*\nfrom Instagram' },
    })
    // Divider sits between the headline and the field grid.
    expect(blocks[1]).toEqual({ type: 'divider' })
    const fieldsIdx = blocks.findIndex((b: any) => Array.isArray(b.fields))
    expect(blocks[fieldsIdx - 1]).toEqual({ type: 'divider' })
    // "from <source>" is NOT its own separate context block.
    expect(blocks.filter((b: any) => b.type === 'context' && flat([b]).includes('from Instagram'))).toHaveLength(0)
  })

  it('caps the "What they told us" quote at ~140 chars (+ …); full text stays in Bee Hub', () => {
    const long = 'x'.repeat(300)
    const s = flat(blocksOf(card({ request_details: long })))
    // 140 shown chars + a single ellipsis, never the full 300.
    expect(s).toContain(`${'x'.repeat(140)}…`)
    expect(s).not.toContain('x'.repeat(141))
    // A short one is shown whole, no ellipsis.
    const shortS = flat(blocksOf(card({ request_details: 'Need packing help' })))
    expect(shortS).toContain('Need packing help')
    expect(shortS).not.toContain('…')
  })

  it('renders tel:/mailto: hyperlinks and the primary Log call button with the exact contract', () => {
    const blocks = blocksOf(card())
    const s = flat(blocks)
    expect(s).toContain('<tel:+15551112222|(555) 111-2222>')
    expect(s).toContain('<mailto:jane@example.com|jane@example.com>')

    const logBtn = actionsOf(blocks).elements.find((e: any) => e.action_id === 'log_call')
    expect(logBtn).toBeTruthy()
    expect(logBtn.value).toBe('lead-1')        // interactivity contract — unchanged
    expect(logBtn.style).toBe('primary')        // green
    // Open button carries the deep-link when a URL is present.
    expect(actionsOf(blocks).elements.some((e: any) => e.url === 'https://app.example.com/clients/lead-1')).toBe(true)
  })

  describe('color-by-project-type stripe', () => {
    it('Moving → blue, Organizing → teal, unknown/absent → gray', () => {
      expect(card({ project_type: 'Moving' }).attachments[0].color).toBe('#2563eb')
      expect(card({ project_type: 'Organizing' }).attachments[0].color).toBe('#0d9488')
      // Real-world: "Move-In Organization" is an organizing job → teal (organizing wins).
      expect(card({ project_type: 'Move-In Organization' }).attachments[0].color).toBe('#0d9488')
      expect(card({ project_type: 'Garage' }).attachments[0].color).toBe('#6b7280')
      expect(card({ project_type: null }).attachments[0].color).toBe('#6b7280')
    })
  })

  describe('de-dupe: each value appears exactly once', () => {
    it('source lives ONLY in the meta line, project ONLY in the grid — no duplicate cells', () => {
      const s = flat(blocksOf(card({ preferred_contact: 'Phone', source: 'Referral', project_type: 'Moving' })))
      // Source: meta line only, no Source grid cell.
      expect(s).toContain('from Referral')
      expect(s).not.toContain('*Source:*')
      // Project: grid cell only, no eyebrow badge.
      expect(s).toContain('*Project:*\\nMoving')
      expect(s.match(/Moving/g)!.length).toBe(1)
      // Preferred contact: the grid field replacing Source.
      expect(s).toContain('*Preferred contact:*\\nPhone')
    })

    it('humanizes the webform source slug to Website (meta line)', () => {
      expect(flat(blocksOf(card({ source: 'web_form' })))).toContain('from Website')
    })

    it('omits the source meta line when source is absent', () => {
      const s = flat(blocksOf(card({ preferred_contact: 'Text', source: null })))
      expect(s).not.toContain('from ')
      // Preferred contact still renders in the grid.
      expect(s).toContain('*Preferred contact:*\\nText')
    })

    it('ALWAYS renders Preferred contact — em-dash when empty', () => {
      const s = flat(blocksOf(card({ preferred_contact: null, source: null })))
      expect(s).toContain('*Preferred contact:*\\n—')
      expect(s).not.toContain('from ')
    })

    it('a name+phone-only lead still renders a clean card (no empty labels, Preferred contact = —)', () => {
      const s = flat(blocksOf(card(
        { email: null, project_type: null, preferred_contact: null, source: null, request_details: null },
        null,
      )))
      expect(s).toContain('<tel:+15551112222|(555) 111-2222>')
      expect(s).not.toContain('mailto:')
      expect(s).not.toContain('*Email:*')
      expect(s).not.toContain('*Source:*')
      expect(s).not.toContain('*Project:*')
      expect(s).not.toContain('What they told us')
      // Preferred contact always shows, em-dash when empty.
      expect(s).toContain('*Preferred contact:*\\n—')
      // No leadUrl → only the Log call button.
      const actions = actionsOf(blocksOf(card(
        { email: null, project_type: null, preferred_contact: null, source: null, request_details: null },
        null,
      )))
      expect(actions.elements).toHaveLength(1)
      expect(actions.elements[0].action_id).toBe('log_call')
    })

    it('includes What they told us only when request_details present', () => {
      expect(flat(blocksOf(card({ request_details: 'Need packing help' })))).toContain('What they told us')
      expect(flat(blocksOf(card({ request_details: null })))).not.toContain('What they told us')
    })
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
    expect(JSON.parse(opts.body)).toEqual({
      channel: 'C123',
      unfurl_links: false,
      unfurl_media: false,
      text: 'hello',
    })
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
    // Top-level text is the one-line summary (no lead name); the deep-link now
    // lives on the card's "Open in Bee Hub" button (attachments[0].blocks).
    expect(body.text).toBe('🐝 New lead (Boulder)')
    const openBtn = body.attachments[0].blocks
      .find((b: any) => b.type === 'actions')
      .elements.find((e: any) => e.url)
    expect(openBtn.url).toBe('https://app.example.com/clients/lead-1')
  })
})
