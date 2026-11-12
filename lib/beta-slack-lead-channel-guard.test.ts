// @vitest-environment node
//
// THE LEAD-CHANNEL GUARD — a reconnect must never move or break lead posts.
//
// Every connected location has to reconnect Slack once to get job channels,
// and Slack's install screen always makes the owner pick a channel. The
// callback used to store that pick, so an owner clicking through could move
// their lead posts to another channel — or, by picking a private channel the
// app is not in, stop them arriving at all. That is a risk to something that
// works today at every connected location, which is a bigger surface than
// anything job channels add.
//
// The rule (lib/slack-lead-channel.ts): reconnecting to the SAME workspace
// keeps the channel the location already had, whatever was picked. A first
// connection, a connection after Disconnect, and a connection to a DIFFERENT
// workspace all take the pick, exactly as before.
//
// These run the REAL connect and callback routes against a location row that
// behaves like the database's: every update is applied to it. So "the channel
// is exactly as it was" is read off the row afterwards — and then a lead post
// is sent through the real lib/slack-bot, to see where it actually goes.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => {
  const state = {
    location: null as any,   // the locations row — updates are APPLIED to it
    hubUser: null as any,
    authUser: null as any,
    updates: [] as { table: string; payload: any }[],
    updateResults: [] as { data: any; error: any }[],
    selects: [] as { table: string; cols: string }[],
  }
  const makeBuilder = (table: string) => {
    const b: any = {}
    let pending: any = null
    for (const m of ['eq', 'limit', 'order']) b[m] = () => b
    b.select = (cols: string) => { state.selects.push({ table, cols: String(cols || '') }); return b }
    b.update = (payload: any) => { state.updates.push({ table, payload: { ...payload } }); pending = payload; return b }
    const row = () => (table === 'hub_users' ? { data: state.hubUser, error: null } : { data: state.location ? { ...state.location } : null, error: null })
    b.single = async () => row()
    b.maybeSingle = async () => row()
    b.then = (res: any, rej: any) => {
      let out = { data: null, error: null } as any
      if (pending) {
        out = state.updateResults.shift() ?? out
        if (!out.error && table === 'locations') Object.assign(state.location, pending)
      }
      return Promise.resolve(out).then(res, rej)
    }
    return b
  }
  return { state, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.makeBuilder(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: h.state.authUser } }) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))

import { GET as connect } from '@/app/api/slack/connect/route'
import { GET as callback } from '@/app/api/slack/callback/route'
import { SLACK_OAUTH_STATE_COOKIE, __resetConsumedNoncesForTest } from '@/lib/slack-oauth-guard'
import { leadChannelOnConnect } from '@/lib/slack-lead-channel'
import { postToSlack } from '@/lib/slack-bot'

const LOC = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OLD_TOKEN = 'xoxb-OLD-token'
const NEW_TOKEN = 'xoxb-NEW-token'
const SCOPES = 'chat:write,chat:write.public,channels:read,channels:manage,incoming-webhook,users:read,users:read.email'

// A location connected today, before job channels: workspace T-PDX, leads to #leads.
const CONNECTED = () => ({
  id: LOC, location_id: 'portland-01', name: 'Portland',
  slack_connected: true, slack_bot_token: OLD_TOKEN,
  slack_team_id: 'T-PDX', slack_team_name: 'Bee Organized Portland',
  slack_channel_id: 'C-LEADS', slack_channel_name: '#leads',
  slack_scopes: null,
})
// Never connected — and what lib/slack-disconnect leaves behind, which is the same.
const NEVER = () => ({
  id: LOC, location_id: 'portland-01', name: 'Portland',
  slack_connected: false, slack_bot_token: null, slack_team_id: null, slack_team_name: null,
  slack_channel_id: null, slack_channel_name: null, slack_scopes: null,
})

// What Slack sends back: the workspace, and the channel the owner picked.
const slackSays = (over: any = {}) => ({
  ok: true, access_token: NEW_TOKEN, scope: SCOPES,
  team: { id: 'T-PDX', name: 'Bee Organized Portland' },
  incoming_webhook: { channel_id: 'C-RANDOM', channel: '#random' },
  ...over,
})

const req = (url: string, cookie?: string) => new NextRequest(new Request(url, { headers: cookie ? { cookie } : {} }))

async function reconnect(slackBody: any) {
  const start = await connect(req('https://hub.test/api/slack/connect?location_id=portland-01'))
  const cookie = start.cookies.get(SLACK_OAUTH_STATE_COOKIE)?.value
  const state = new URL(start.headers.get('location') || '').searchParams.get('state') || ''
  vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(slackBody) } as any)
  const p = new URLSearchParams({ code: 'good-code', state })
  const res = await callback(req(`https://hub.test/api/slack/callback?${p}`, `${SLACK_OAUTH_STATE_COOKIE}=${cookie}`))
  return { res, landed: new URL(res.headers.get('location') || '').searchParams }
}

const locationWrites = () => h.state.updates.filter(u => u.table === 'locations').map(u => u.payload)
const channelOf = () => ({ id: h.state.location.slack_channel_id, name: h.state.location.slack_channel_name })

// Send one lead post through the real transport and report where it went.
async function whereALeadPostGoes() {
  const spy = vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.1', channel: 'x' }), text: async () => '{"ok":true}' } as any)
  await postToSlack(LOC, { text: 'New lead' })
  const call = spy.mock.calls.find((c: any[]) => String(c[0]).includes('chat.postMessage')) as any[]
  return { channel: JSON.parse(call[1].body).channel, token: String(call[1].headers.Authorization).replace('Bearer ', '') }
}

beforeEach(() => {
  vi.restoreAllMocks()
  __resetConsumedNoncesForTest()
  process.env.SLACK_CLIENT_ID = 'client-id'
  process.env.SLACK_CLIENT_SECRET = 'client-secret'
  process.env.NEXT_PUBLIC_APP_URL = 'https://hub.test'
  h.state.location = CONNECTED()
  h.state.authUser = { id: 'user-1' }
  h.state.hubUser = { id: 'user-1', role: 'owner', location_id: LOC }
  h.state.updates = []
  h.state.updateResults = []
  h.state.selects = []
  for (const m of ['log', 'error', 'warn'] as const) vi.spyOn(console, m).mockImplementation(() => {})
})

describe('reconnecting to the SAME workspace keeps the lead channel exactly as it was', () => {
  it('the owner picks a DIFFERENT channel on Slack’s screen — the stored channel does not change, id or name', async () => {
    const before = channelOf()
    expect(before).toEqual({ id: 'C-LEADS', name: '#leads' })
    const { landed } = await reconnect(slackSays())   // picked C-RANDOM / #random

    expect(landed.get('slack')).toBe('connected')
    expect(channelOf()).toEqual(before)
    // Not "written back with the old value": the two columns are not in the write at all.
    expect(locationWrites()).toHaveLength(1)
    expect(Object.keys(locationWrites()[0])).not.toContain('slack_channel_id')
    expect(Object.keys(locationWrites()[0])).not.toContain('slack_channel_name')
    // The picked channel appears nowhere in what was stored.
    expect(JSON.stringify(h.state.location)).not.toContain('C-RANDOM')
    expect(JSON.stringify(h.state.location)).not.toContain('#random')
  })

  it('…and the reconnect still did its job: new token, the new grant, still connected', async () => {
    await reconnect(slackSays())
    expect(h.state.location.slack_bot_token).toBe(NEW_TOKEN)
    expect(h.state.location.slack_scopes).toBe(SCOPES)
    expect(h.state.location.slack_connected).toBe(true)
    expect(Object.keys(locationWrites()[0]).sort()).toEqual(
      ['slack_bot_token', 'slack_connected', 'slack_scopes', 'slack_team_id', 'slack_team_name', 'updated_at'])
  })

  it('a lead post after the reconnect goes to the OLD channel, with the NEW token', async () => {
    await reconnect(slackSays())
    expect(await whereALeadPostGoes()).toEqual({ channel: 'C-LEADS', token: NEW_TOKEN })
  })

  it('the owner picks a PRIVATE channel the app is not in — lead posts still go where they went', async () => {
    await reconnect(slackSays({ incoming_webhook: { channel_id: 'G-PRIVATE', channel: 'owners-only' } }))
    expect(channelOf()).toEqual({ id: 'C-LEADS', name: '#leads' })
    expect((await whereALeadPostGoes()).channel).toBe('C-LEADS')
  })

  it('the owner picks the same channel again — nothing changes either', async () => {
    await reconnect(slackSays({ incoming_webhook: { channel_id: 'C-LEADS', channel: '#leads' } }))
    expect(channelOf()).toEqual({ id: 'C-LEADS', name: '#leads' })
    expect(Object.keys(locationWrites()[0])).not.toContain('slack_channel_id')
  })

  it('the screen is told the channel leads really go to, not the one that was picked and ignored', async () => {
    const { landed } = await reconnect(slackSays())
    expect(landed.get('channel')).toBe('#leads')
  })

  it('the workspace was RENAMED since (same id, new name) — still the same workspace: channel kept, name refreshed', async () => {
    await reconnect(slackSays({ team: { id: 'T-PDX', name: 'Bee Organized PDX Metro' } }))
    expect(channelOf()).toEqual({ id: 'C-LEADS', name: '#leads' })
    expect(h.state.location.slack_team_name).toBe('Bee Organized PDX Metro')
  })

  it('an admin reconnecting on the owner’s behalf is held to the same rule', async () => {
    h.state.hubUser = { id: 'user-1', role: 'super_admin', location_id: null }
    await reconnect(slackSays())
    expect(channelOf()).toEqual({ id: 'C-LEADS', name: '#leads' })
  })

  // This file's stand-in database hands back the whole row whatever is asked
  // for. The real one hands back only the columns named — so if the callback
  // ever stops ASKING for what the location was connected to, the guard would
  // quietly never fire. Pin the ask.
  it('the callback reads what the location was connected to BEFORE it writes anything', async () => {
    await reconnect(slackSays())
    const asked = h.state.selects.filter(s => s.table === 'locations').map(s => s.cols).join(' | ')
    for (const col of ['slack_connected', 'slack_team_id', 'slack_channel_id', 'slack_channel_name']) {
      expect(asked, `the callback must select ${col}`).toContain(col)
    }
    expect(asked).not.toContain('slack_bot_token')   // …and never the old token
  })

  it('reconnecting twice in a row keeps it both times', async () => {
    await reconnect(slackSays())
    await reconnect(slackSays({ incoming_webhook: { channel_id: 'C-THIRD', channel: '#third' } }))
    expect(channelOf()).toEqual({ id: 'C-LEADS', name: '#leads' })
  })

  it('before the slack_scopes column existed, the retry write keeps the channel too', async () => {
    h.state.updateResults = [{ data: null, error: { code: 'PGRST204', message: "Could not find the 'slack_scopes' column of 'locations' in the schema cache" } }]
    await reconnect(slackSays())
    expect(locationWrites()).toHaveLength(2)
    for (const w of locationWrites()) expect(Object.keys(w)).not.toContain('slack_channel_id')
    expect(channelOf()).toEqual({ id: 'C-LEADS', name: '#leads' })
  })
})

describe('a FIRST connection still takes the channel the owner picks — unchanged', () => {
  it('never connected: the picked channel is stored, with the same columns as before the guard', async () => {
    h.state.location = NEVER()
    await reconnect(slackSays())
    expect(channelOf()).toEqual({ id: 'C-RANDOM', name: '#random' })
    // The fingerprint: exactly the eight columns the callback wrote before this guard existed.
    expect(Object.keys(locationWrites()[0]).sort()).toEqual([
      'slack_bot_token', 'slack_channel_id', 'slack_channel_name', 'slack_connected',
      'slack_scopes', 'slack_team_id', 'slack_team_name', 'updated_at'])
    expect(locationWrites()[0]).toMatchObject({
      slack_bot_token: NEW_TOKEN, slack_team_id: 'T-PDX', slack_team_name: 'Bee Organized Portland',
      slack_channel_id: 'C-RANDOM', slack_channel_name: '#random', slack_scopes: SCOPES, slack_connected: true })
    expect((await whereALeadPostGoes())).toEqual({ channel: 'C-RANDOM', token: NEW_TOKEN })
  })

  it('Disconnect, then connect again — the way to move lead posts on purpose — takes the new pick', async () => {
    // What lib/slack-disconnect.ts leaves: not connected, workspace and channel cleared.
    Object.assign(h.state.location, { slack_connected: false, slack_bot_token: null, slack_team_id: null, slack_team_name: null, slack_channel_id: null, slack_channel_name: null })
    await reconnect(slackSays())
    expect(channelOf()).toEqual({ id: 'C-RANDOM', name: '#random' })
  })

  it('marked not-connected but with an old channel still on the row (a dead token cleared the flag): takes the pick', async () => {
    h.state.location.slack_connected = false
    await reconnect(slackSays())
    expect(channelOf()).toEqual({ id: 'C-RANDOM', name: '#random' })
  })

  it('connected to this workspace but with NO stored channel: takes the pick — a location is never left without one', async () => {
    Object.assign(h.state.location, { slack_channel_id: null, slack_channel_name: null })
    await reconnect(slackSays())
    expect(channelOf()).toEqual({ id: 'C-RANDOM', name: '#random' })
  })
})

describe('connecting to a DIFFERENT workspace is a real move — it takes the pick', () => {
  it('another workspace id: the new channel replaces the old one (an old channel id means nothing in a new workspace)', async () => {
    await reconnect(slackSays({ team: { id: 'T-OTHER', name: 'Somewhere Else' } }))
    expect(channelOf()).toEqual({ id: 'C-RANDOM', name: '#random' })
    expect(h.state.location.slack_team_id).toBe('T-OTHER')
  })

  it('a workspace with the SAME NAME but another id is a different workspace', async () => {
    await reconnect(slackSays({ team: { id: 'T-TWIN', name: 'Bee Organized Portland' } }))
    expect(channelOf()).toEqual({ id: 'C-RANDOM', name: '#random' })
  })

  it('Slack sends no workspace id at all: treated as a move, which is what happened before the guard', async () => {
    await reconnect(slackSays({ team: undefined }))
    expect(channelOf()).toEqual({ id: 'C-RANDOM', name: '#random' })
  })
})

describe('the rule on its own (leadChannelOnConnect)', () => {
  const prior = { slack_connected: true, slack_team_id: 'T1', slack_channel_id: 'C1', slack_channel_name: '#leads' }
  const pick = { teamId: 'T1', channelId: 'C2', channelName: '#other' }

  it('same workspace → keep', () => {
    expect(leadChannelOnConnect(prior, pick)).toEqual({ keep: true, channelId: 'C1', channelName: '#leads', reason: 'same_workspace' })
  })

  it('keeps ONLY when all four hold: connected, a stored workspace, a stored channel, the same workspace coming back', () => {
    const takes = (p: any, i: any = pick) => expect(leadChannelOnConnect(p, i)).toMatchObject({ keep: false, channelId: i.channelId })
    takes(null); takes(undefined); takes({})
    takes({ ...prior, slack_connected: false }); takes({ ...prior, slack_connected: null })
    takes({ ...prior, slack_team_id: null }); takes({ ...prior, slack_team_id: '' }); takes({ ...prior, slack_team_id: '   ' })
    takes({ ...prior, slack_channel_id: null }); takes({ ...prior, slack_channel_id: '' })
    takes(prior, { ...pick, teamId: 'T2' }); takes(prior, { ...pick, teamId: null }); takes(prior, { ...pick, teamId: undefined })
    takes(prior, { ...pick, teamId: 't1' })   // ids are exact — no case folding, no near match
    takes(prior, { ...pick, teamId: 'T10' })  // …and no prefix match
  })

  it('says why, for the log', () => {
    expect(leadChannelOnConnect(null, pick).reason).toBe('first_connection')
    expect(leadChannelOnConnect(prior, { ...pick, teamId: 'T2' }).reason).toBe('different_workspace')
  })
})
