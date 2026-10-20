// @vitest-environment node
//
// Pressing a button on Other's route-suggestion card
// (lib/route-suggestion-actions.ts, wired in app/api/slack/interactivity).
//   • Only CORPORATE may press: anyone else is told privately and NOTHING is
//     written — not a transfer, not an email, not a card edit.
//   • Accept moves the lead with transferLead and edits the card in place.
//   • Leave in Other writes nothing and edits the card.
//   • Not in our service area re-checks the 75-mile rule NOW and only then
//     calls closeLeadAsNoCoverage.
//   • A lead already gone from Other: the card says where, nothing changes.
//   • The endpoint acks at once and finishes under waitUntil; a bad signature
//     never reaches the handler.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'

const h = vi.hoisted(() => ({
  otherToken: 'xoxb-other' as string | null,
  slackEmail: 'leslie@beeorganized.com' as string | null,
  hubUsers: [] as any[],
  lead: null as any,
  locations: {} as Record<string, any>,
  posts: [] as { url: string; body: any }[],
  waited: [] as Promise<any>[],
}))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: {
    from: (table: string) => {
      const f: Record<string, any> = {}
      const b: any = {}
      b.select = () => b
      b.limit = () => b
      b.eq = (c: string, v: any) => { f[c] = v; return b }
      b.ilike = (c: string, v: any) => { f[`ilike:${c}`] = v; return b }
      const result = () => {
        if (table === 'hub_users') return { data: h.hubUsers, error: null }
        if (table === 'leads') return { data: h.lead && h.lead.id === f.id ? h.lead : null, error: null }
        if (table === 'locations') {
          if (f.location_id === 'loc_other') return { data: { slack_bot_token: h.otherToken }, error: null }
          return { data: h.locations[f.location_id] ?? null, error: null }
        }
        return { data: null, error: null }
      }
      b.maybeSingle = async () => result()
      b.then = (res: any, rej: any) => Promise.resolve(result()).then(res, rej)
      return b
    },
  },
}))
vi.mock('@/lib/slack-bot', () => ({ getSlackUserEmail: vi.fn(async () => h.slackEmail) }))
vi.mock('@/lib/lead-transfer', () => ({ transferLead: vi.fn(async () => ({ status: 200, body: { success: true } })) }))
vi.mock('@/lib/lead-no-coverage', () => ({ closeLeadAsNoCoverage: vi.fn(async () => ({ status: 200, body: { success: true, to: 'j@example.com' } })) }))
vi.mock('@/lib/touchpoints', () => ({ logCallTouchpoint: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/other-card-sync', () => ({ markCardResolved: vi.fn(async () => {}) }))
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<any>) => { h.waited.push(p) } }))

import { handleRouteAction, resolveCorporateClicker, isRouteAction } from '@/lib/route-suggestion-actions'
import { encodeAcceptValue, buildResolvedRouteMessage, DONE_BLOCK_ID } from '@/lib/route-suggestion-slack'
import { transferLead } from '@/lib/lead-transfer'
import { closeLeadAsNoCoverage } from '@/lib/lead-no-coverage'
import { getSlackUserEmail } from '@/lib/slack-bot'
import { POST } from '@/app/api/slack/interactivity/route'
import { markCardResolved } from '@/lib/other-card-sync'

const RESP = 'https://hooks.slack.com/actions/resp'
const LESLIE = { id: 'hu-leslie', role: 'admin', full_name: 'Leslie Mullins', email: 'Leslie@BeeOrganized.com ', disabled_at: null }
const CARD = {
  text: '📍 New lead in Other — needs a hive',
  attachments: [{ color: '#abc', blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: '*Jessica*' } },
    { type: 'section', block_id: 'route_suggest', text: { type: 'mrkdwn', text: 'Closest' } },
    { type: 'actions', block_id: 'route_actions', elements: [] },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Other · via Bee Hub' }] },
  ] }],
}
const press = (actionId: string, value: unknown) =>
  handleRouteAction({ actionId, value, slackUserId: 'U-LESLIE', responseUrl: RESP, message: CARD, channelId: 'C-OTHER', messageTs: '111.222' })
const accept = (to = 'loc_miami', lead = 'lead-1') => press('route_accept_0', encodeAcceptValue(lead, to))
const lastPost = () => h.posts[h.posts.length - 1]?.body
const editedLine = () => lastPost().attachments[0].blocks.find((b: any) => b.block_id === DONE_BLOCK_ID).elements[0].text

beforeEach(() => {
  vi.clearAllMocks()
  h.otherToken = 'xoxb-other'
  h.slackEmail = 'leslie@beeorganized.com'
  h.hubUsers = [LESLIE]
  h.lead = { id: 'lead-1', name: 'Jessica', location_id: 'loc_other' }
  h.locations = {
    loc_miami: { id: 'uuid-miami', name: 'Miami', location_id: 'loc_miami' },
    loc_lincoln: { id: 'uuid-lincoln', name: 'Lincoln', location_id: 'loc_lincoln' },
  }
  h.posts = []
  h.waited = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => { h.posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true }) } as any }))
})

const nothingWritten = () => {
  expect(transferLead).not.toHaveBeenCalled()
  expect(closeLeadAsNoCoverage).not.toHaveBeenCalled()
}

describe('who may press — corporate only', () => {
  it('the clicker is looked up with OTHER\'s bot token and matched by email, case- and space-blind', async () => {
    expect(await resolveCorporateClicker('U-LESLIE')).toEqual({ hubUserId: 'hu-leslie', role: 'admin', name: 'Leslie Mullins' })
    expect(getSlackUserEmail).toHaveBeenCalledWith('xoxb-other', 'U-LESLIE')
  })

  it.each([
    ['an owner', () => { h.hubUsers = [{ ...LESLIE, role: 'owner' }] }],
    ['a manager', () => { h.hubUsers = [{ ...LESLIE, role: 'manager' }] }],
    ['nobody in Bee Hub', () => { h.hubUsers = [] }],
    ['a removed admin', () => { h.hubUsers = [{ ...LESLIE, disabled_at: '2026-10-01' }] }],
    ['an email that only nearly matches', () => { h.hubUsers = [{ ...LESLIE, email: 'leslie@beeorganized.co' }] }],
    ['a Slack user with no email', () => { h.slackEmail = null }],
    ['Other not connected to Slack', () => { h.otherToken = null }],
  ])('%s → refused privately; nothing moved, emailed or edited', async (_who, arrange) => {
    arrange()
    for (const go of [() => accept(), () => press('route_leave', 'lead-1'), () => press('route_no_coverage', 'lead-1')]) {
      h.posts = []
      expect(await go()).toBe('refused_not_corporate')
      nothingWritten()
      expect(h.posts).toHaveLength(1)
      expect(lastPost()).toMatchObject({ response_type: 'ephemeral', replace_original: false })
      expect(lastPost().text).toContain('Only corporate can route leads from Slack')
    }
  })

  it('two Bee Hub rows on one email: the corporate one is used', async () => {
    h.hubUsers = [{ ...LESLIE, id: 'hu-owner', role: 'owner' }, LESLIE]
    expect((await resolveCorporateClicker('U-LESLIE'))?.hubUserId).toBe('hu-leslie')
  })

  it('a super_admin may press', async () => {
    h.hubUsers = [{ ...LESLIE, role: 'super_admin' }]
    expect(await accept()).toBe('moved')
  })
})

describe('Accept — move it, then edit the card in place', () => {
  it('moves the lead to the hive pressed, as the clicker, with no reason; the card says so', async () => {
    expect(await accept('loc_miami')).toBe('moved')
    expect(transferLead).toHaveBeenCalledWith({
      leadId: 'lead-1', destinationLocationId: 'uuid-miami', reason: null,
      actor: { hubUserId: 'hu-leslie', role: 'admin', name: 'Leslie Mullins' }, requestOrigin: null,
    })
    expect(lastPost()).toMatchObject({ replace_original: true })
    expect(editedLine()).toBe('✅ Moved to *Miami* by Leslie Mullins.')
    // the edit keeps the lead details and drops the buttons
    expect(JSON.stringify(lastPost())).toContain('*Jessica*')
    expect(JSON.stringify(lastPost())).not.toContain('route_actions')
  })

  it('a refused move (e.g. already in Jobber) leaves the card and tells the clicker why, privately', async () => {
    vi.mocked(transferLead).mockResolvedValueOnce({ status: 409, body: { error: 'lead_in_jobber', detail: 'This lead is already in Jobber.' } })
    expect(await accept()).toBe('move_refused')
    expect(lastPost()).toMatchObject({ response_type: 'ephemeral', replace_original: false })
    expect(lastPost().text).toContain("Couldn't move this lead to Miami: This lead is already in Jobber. It is still in Other.")
  })

  it('a hive that no longer exists → nothing moved, told privately', async () => {
    expect(await accept('loc_gone')).toBe('destination_not_found')
    nothingWritten()
  })

  it('a lead already moved out of Other (Bee Hub, or a second click) → the card says where; nothing moves', async () => {
    h.lead = { id: 'lead-1', name: 'Jessica', location_id: 'loc_lincoln' }
    expect(await accept('loc_miami')).toBe('already_moved')
    nothingWritten()
    expect(editedLine()).toBe('↪️ Already moved to *Lincoln* — nothing changed. (Pressed by Leslie Mullins)')
  })

  it('a lead that does not exist → nothing moved', async () => {
    h.lead = null
    expect(await accept()).toBe('lead_not_found')
    nothingWritten()
  })

  it.each([['not json'], [null], [encodeAcceptValue('', 'loc_miami')]])('an unreadable button value %j → refused, nothing read or written', async (v) => {
    expect(await press('route_accept_0', v)).toBe('refused_bad_value')
    nothingWritten()
    expect(getSlackUserEmail).not.toHaveBeenCalled()
  })
})

describe('Leave in Other', () => {
  it('writes nothing to the lead; the card says who left it, and its row records it (so the sweep never reposts it)', async () => {
    expect(await press('route_leave', 'lead-1')).toBe('left_in_other')
    nothingWritten()
    expect(editedLine()).toBe('📥 Left in Other by Leslie Mullins. Route it in Bee Hub when ready.')
    expect(markCardResolved).toHaveBeenCalledWith({ channelId: 'C-OTHER', messageTs: '111.222', resolution: 'left_in_other', line: '📥 Left in Other by Leslie Mullins. Route it in Bee Hub when ready.' })
  })

  it('an already-moved lead\'s card is recorded too', async () => {
    h.lead = { id: 'lead-1', name: 'Jessica', location_id: 'loc_lincoln' }
    await accept('loc_miami')
    expect(markCardResolved).toHaveBeenCalledWith(expect.objectContaining({ messageTs: '111.222', resolution: 'moved' }))
  })

  it('a refused presser never records anything', async () => {
    h.hubUsers = []
    await press('route_leave', 'lead-1')
    expect(markCardResolved).not.toHaveBeenCalled()
  })
})

describe('Not in our service area — the one rule every door shares', () => {
  it('past 75 measured miles → the email goes, as the clicker, never "confirmed"; the card says who was told', async () => {
    expect(await press('route_no_coverage', 'lead-1')).toBe('no_coverage_sent')
    expect(closeLeadAsNoCoverage).toHaveBeenCalledWith({ leadId: 'lead-1', actor: expect.objectContaining({ hubUserId: 'hu-leslie' }), requestOrigin: null, confirmedOutOfRange: false })
    expect(editedLine()).toBe("📭 Told j@example.com we don't serve their area yet (mailing-list link sent) — by Leslie Mullins.")
  })

  it('a claimed zip → refused privately with who claims it; the card stays', async () => {
    vi.mocked(closeLeadAsNoCoverage).mockResolvedValueOnce({ status: 409, body: { error: 'zip_claimed', detail: "Zip 89509 is on Reno's zip list — that is their territory, so Bee Hub won't send the not-in-area email. Route the lead to Reno instead." } })
    expect(await press('route_no_coverage', 'lead-1')).toBe('no_coverage_blocked')
    expect(lastPost()).toMatchObject({ response_type: 'ephemeral', replace_original: false })
    expect(lastPost().text).toContain("Zip 89509 is on Reno's zip list")
    expect(lastPost().text).toContain('Nothing was sent.')
  })

  it('within 75 miles (or unmeasured) → Slack never confirms; sent to the Inbox to decide', async () => {
    vi.mocked(closeLeadAsNoCoverage).mockResolvedValueOnce({ status: 409, body: { error: 'needs_confirmation', detail: 'Miami is 48 mi from zip 33928. Check they\'re really out of range before sending.' } })
    expect(await press('route_no_coverage', 'lead-1')).toBe('no_coverage_needs_confirmation')
    expect(lastPost().text).toContain('Miami is 48 mi from zip 33928')
    expect(lastPost().text).toContain('Inbox → No coverage')
  })

  it('the close refuses for another reason (no email address) → the card stays, told privately', async () => {
    vi.mocked(closeLeadAsNoCoverage).mockResolvedValueOnce({ status: 400, body: { error: 'lead_has_no_email' } })
    expect(await press('route_no_coverage', 'lead-1')).toBe('no_coverage_refused')
    expect(lastPost()).toMatchObject({ response_type: 'ephemeral' })
    expect(lastPost().text).toContain("didn't go: lead_has_no_email. The lead is still in Other.")
  })

  it('a lead already moved out of Other is never emailed', async () => {
    h.lead = { id: 'lead-1', name: 'Jessica', location_id: 'loc_miami' }
    expect(await press('route_no_coverage', 'lead-1')).toBe('already_moved')
    expect(closeLeadAsNoCoverage).not.toHaveBeenCalled()
  })
})

describe('isRouteAction', () => {
  it.each([['route_accept_0', true], ['route_accept_2', true], ['route_leave', true], ['route_no_coverage', true], ['log_call', false], [undefined, false], ['route_other', false]])('%j → %s', (id, yes) => {
    expect(isRouteAction(id)).toBe(yes)
  })
})

// ── the endpoint ────────────────────────────────────────────────
const SECRET = 'test-signing-secret'
function signedReq(payload: any, opts: { badSig?: boolean } = {}) {
  const ts = Math.floor(Date.now() / 1000)
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`
  const sig = opts.badSig ? 'v0=deadbeef' : 'v0=' + createHmac('sha256', SECRET).update(`v0:${ts}:${raw}`).digest('hex')
  return { text: async () => raw, headers: { get: (k: string) => (k === 'x-slack-request-timestamp' ? String(ts) : k === 'x-slack-signature' ? sig : null) } } as any
}
const routePayload = {
  actions: [{ action_id: 'route_accept_0', value: encodeAcceptValue('lead-1', 'loc_miami') }],
  user: { id: 'U-LESLIE' },
  response_url: RESP,
  message: CARD,
}

describe('app/api/slack/interactivity — route buttons', () => {
  beforeEach(() => { process.env.SLACK_SIGNING_SECRET = SECRET })

  it('the endpoint hands the pressed message\'s channel and id to the handler', async () => {
    await POST(signedReq({ ...routePayload, actions: [{ action_id: 'route_leave', value: 'lead-1' }], container: { channel_id: 'C-OTHER', message_ts: '999.888' } }))
    await h.waited[0]
    expect(markCardResolved).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'C-OTHER', messageTs: '999.888' }))
  })

  it('a signed route click is acked at once and the move finishes under waitUntil', async () => {
    const res = await POST(signedReq(routePayload))
    expect(res.status).toBe(200)
    expect(h.waited).toHaveLength(1)
    await h.waited[0]
    expect(transferLead).toHaveBeenCalledTimes(1)
    expect(editedLine()).toBe('✅ Moved to *Miami* by Leslie Mullins.')
  })

  it('a bad signature → 401 and the handler never runs', async () => {
    const res = await POST(signedReq(routePayload, { badSig: true }))
    expect(res.status).toBe(401)
    expect(h.waited).toHaveLength(0)
    nothingWritten()
  })

  it('Log call still goes the old way (not through the route handler)', async () => {
    await POST(signedReq({ actions: [{ action_id: 'log_call', value: 'lead-1' }], user: { id: 'U1' }, response_url: RESP }))
    expect(h.waited).toHaveLength(0)
    nothingWritten()
  })
})

describe('the edit builder used here is the one the card was built with', () => {
  it('buildResolvedRouteMessage on the posted card', () => {
    const m = buildResolvedRouteMessage(CARD, 'x')
    expect(m.attachments[0].blocks.map((b: any) => b.block_id ?? b.type)).toEqual(['section', 'route_done', 'context'])
  })
})
