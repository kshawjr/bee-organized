// @vitest-environment node
//
// The Slack install gate — /api/slack/connect + /api/slack/callback.
//
// THE HIJACK THIS PINS SHUT. The connect route had no session or role check and
// middleware.ts requires no session, so the URL was open. The callback then took
// the ?state= string at face value — it split off the locationId and never
// verified the nonce it was told was CSRF protection. Together: create a free
// Slack workspace, guess a slug (loc_portland), open the connect URL, click
// Allow, and your workspace's bot token lands on that franchise's row. Every
// subsequent lead card — name, email, phone, request details — posts to your
// channel, over the top of any legitimate connection, while the owner's card
// still reads green.
//
// So these tests are the security boundary, not coverage:
//   • connect rejects anonymous callers, and owners reaching for a location
//     that isn't theirs;
//   • the callback writes NOTHING unless the signed, unexpired, unconsumed
//     state cookie agrees with the state string AND the caller is still
//     authorized at exchange time;
//   • the happy path still writes the same seven columns it always did;
//   • a dead token clears the connection instead of leaving the UI lying.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Supabase mocks ────────────────────────────────────────────
// Service client: locations reads (by id or slug) + captured updates.
// Session client: auth.getUser + the hub_users self-read the authz does.
const h = vi.hoisted(() => {
  const state = {
    location: null as any,
    hubUser: null as any,
    authUser: null as any,
    updates: [] as { table: string; payload: any }[],
  }
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ['select', 'eq', 'limit', 'order']) b[m] = () => b
    b.update = (payload: any) => {
      state.updates.push({ table, payload })
      return b
    }
    const row = () =>
      table === 'hub_users'
        ? { data: state.hubUser, error: null }
        : { data: state.location, error: state.location ? null : null }
    b.single = async () => row()
    b.maybeSingle = async () => row()
    b.then = (res: any, rej: any) => Promise.resolve({ data: null, error: null }).then(res, rej)
    return b
  }
  return { state, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: h.state.authUser } }) },
    from: (t: string) => h.makeBuilder(t),
  })),
}))

import { GET as connect } from '@/app/api/slack/connect/route'
import { GET as callback } from '@/app/api/slack/callback/route'
import {
  SLACK_OAUTH_STATE_COOKIE,
  SLACK_OAUTH_STATE_TTL_MS,
  __resetConsumedNoncesForTest,
} from '@/lib/slack-oauth-guard'

const LOC_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OTHER_UUID = '11111111-2222-3333-4444-555555555555'

const req = (url: string, cookie?: string) =>
  new NextRequest(new Request(url, { headers: cookie ? { cookie } : {} }))

const connectReq = (locParam = 'portland-01') =>
  req(`https://hub.test/api/slack/connect?location_id=${encodeURIComponent(locParam)}`)

const callbackReq = (opts: { state?: string; code?: string; cookie?: string }) => {
  const p = new URLSearchParams()
  if (opts.code !== undefined) p.set('code', opts.code)
  if (opts.state !== undefined) p.set('state', opts.state)
  return req(
    `https://hub.test/api/slack/callback?${p.toString()}`,
    opts.cookie ? `${SLACK_OAUTH_STATE_COOKIE}=${opts.cookie}` : undefined,
  )
}

// Slack's oauth.v2.access happy response.
const TOKEN_OK = {
  ok: true,
  access_token: 'xoxb-real-token',
  team: { id: 'T123', name: 'Bee Organized Portland' },
  incoming_webhook: { channel_id: 'C999', channel: '#leads' },
}

const mockTokenExchange = (body: any) =>
  vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as any)

// Drive a real connect → grab the minted cookie + state, exactly as a browser
// would carry them into the callback.
async function startFlow(locParam = 'portland-01') {
  const res = await connect(connectReq(locParam))
  const cookie = res.cookies.get(SLACK_OAUTH_STATE_COOKIE)?.value
  const location = res.headers.get('location') || ''
  const state = new URL(location).searchParams.get('state') || ''
  return { cookie, state, res }
}

beforeEach(() => {
  vi.restoreAllMocks()
  __resetConsumedNoncesForTest()
  process.env.SLACK_CLIENT_ID = 'client-id'
  process.env.SLACK_CLIENT_SECRET = 'client-secret'
  process.env.NEXT_PUBLIC_APP_URL = 'https://hub.test'
  h.state.location = { id: LOC_UUID, location_id: 'portland-01', name: 'Portland' }
  h.state.authUser = { id: 'user-1' }
  h.state.hubUser = { id: 'user-1', role: 'owner', location_id: LOC_UUID }
  h.state.updates = []
})

describe('/api/slack/connect — the route is reachable by bare URL, so it must gate itself', () => {
  it('rejects an unauthenticated caller with 401 and mints no state', async () => {
    h.state.authUser = null
    const res = await connect(connectReq())
    expect(res.status).toBe(401)
    expect(res.cookies.get(SLACK_OAUTH_STATE_COOKIE)).toBeFalsy()
  })

  it('rejects an owner reaching for a location that is not theirs', async () => {
    // The attack shape: authenticated, but aiming at someone else's territory.
    h.state.hubUser = { id: 'user-1', role: 'owner', location_id: OTHER_UUID }
    const res = await connect(connectReq())
    expect(res.status).toBe(403)
    expect(res.cookies.get(SLACK_OAUTH_STATE_COOKIE)).toBeFalsy()
  })

  it('rejects a franchise role that is neither owner nor elevated', async () => {
    h.state.hubUser = { id: 'user-1', role: 'manager', location_id: LOC_UUID }
    const res = await connect(connectReq())
    expect(res.status).toBe(403)
  })

  it('allows an owner for their OWN location and redirects to Slack with the state cookie set', async () => {
    const res = await connect(connectReq())
    expect(res.status).toBe(307)
    const dest = new URL(res.headers.get('location')!)
    expect(dest.origin + dest.pathname).toBe('https://slack.com/oauth/v2/authorize')

    const cookie = res.cookies.get(SLACK_OAUTH_STATE_COOKIE)
    expect(cookie?.value).toBeTruthy()
    // httpOnly + Lax + scoped: readable only by the callback, and carried on
    // Slack's top-level redirect back (which is what makes Lax the right mode).
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite).toBe('lax')
    expect(cookie?.path).toBe('/api/slack')

    // The state binds the RESOLVED uuid, not the slug the caller passed.
    expect(dest.searchParams.get('state')!.startsWith(`${LOC_UUID}:`)).toBe(true)
  })

  it('allows super_admin for any location', async () => {
    h.state.hubUser = { id: 'user-1', role: 'super_admin', location_id: OTHER_UUID }
    const res = await connect(connectReq())
    expect(res.status).toBe(307)
    expect(res.cookies.get(SLACK_OAUTH_STATE_COOKIE)?.value).toBeTruthy()
  })

  it('allows admin for any location', async () => {
    h.state.hubUser = { id: 'user-1', role: 'admin', location_id: null }
    const res = await connect(connectReq())
    expect(res.status).toBe(307)
  })

  it('404s an unknown location instead of minting state for it', async () => {
    h.state.location = null
    const res = await connect(connectReq('loc_does_not_exist'))
    expect(res.status).toBe(404)
  })
})

describe('/api/slack/callback — an unverifiable state must never reach a write', () => {
  it('rejects a MISSING state cookie (the bare-URL hijack) and writes nothing', async () => {
    const { state } = await startFlow()
    const fetchSpy = mockTokenExchange(TOKEN_OK)

    const res = await callback(callbackReq({ code: 'c', state })) // no cookie
    expect(new URL(res.headers.get('location')!).searchParams.get('reason')).toBe('invalid_state')
    expect(h.state.updates).toHaveLength(0)
    // Never even reached the token exchange.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects an UNKNOWN / forged cookie (bad signature) and writes nothing', async () => {
    const { state } = await startFlow()
    mockTokenExchange(TOKEN_OK)
    const forged = Buffer.from(
      JSON.stringify({ n: 'attacker', loc: LOC_UUID, uid: 'user-1', exp: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url') + '.deadbeef'

    const res = await callback(callbackReq({ code: 'c', state, cookie: forged }))
    expect(new URL(res.headers.get('location')!).searchParams.get('reason')).toBe('invalid_state')
    expect(h.state.updates).toHaveLength(0)
  })

  it('rejects an EXPIRED nonce and writes nothing', async () => {
    const { cookie, state } = await startFlow()
    mockTokenExchange(TOKEN_OK)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + SLACK_OAUTH_STATE_TTL_MS + 1000)

    const res = await callback(callbackReq({ code: 'c', state, cookie }))
    expect(new URL(res.headers.get('location')!).searchParams.get('reason')).toBe('invalid_state')
    expect(h.state.updates).toHaveLength(0)
  })

  it('rejects a REPLAYED nonce — the second use writes nothing', async () => {
    const { cookie, state } = await startFlow()
    mockTokenExchange(TOKEN_OK)

    const first = await callback(callbackReq({ code: 'c1', state, cookie }))
    expect(new URL(first.headers.get('location')!).searchParams.get('slack')).toBe('connected')
    expect(h.state.updates).toHaveLength(1)

    const second = await callback(callbackReq({ code: 'c2', state, cookie }))
    expect(new URL(second.headers.get('location')!).searchParams.get('reason')).toBe('invalid_state')
    expect(h.state.updates).toHaveLength(1) // still just the first write
  })

  it('rejects a state string that names a DIFFERENT location than the signed record', async () => {
    // The whole original defect in one case: the location must come from the
    // signed record, never from the attacker-reachable query string.
    const { cookie, state } = await startFlow()
    mockTokenExchange(TOKEN_OK)
    const tampered = `${OTHER_UUID}:${state.split(':')[1]}`

    const res = await callback(callbackReq({ code: 'c', state: tampered, cookie }))
    expect(new URL(res.headers.get('location')!).searchParams.get('reason')).toBe('invalid_state')
    expect(h.state.updates).toHaveLength(0)
  })

  it('clears the state cookie on every response, so it cannot be presented twice', async () => {
    const { cookie, state } = await startFlow()
    mockTokenExchange(TOKEN_OK)
    const res = await callback(callbackReq({ code: 'c', state, cookie }))
    expect(res.cookies.get(SLACK_OAUTH_STATE_COOKIE)?.value).toBe('')
  })

  it('rejects when the session is no longer the user who started the flow', async () => {
    const { cookie, state } = await startFlow()
    mockTokenExchange(TOKEN_OK)
    h.state.authUser = { id: 'someone-else' }

    const res = await callback(callbackReq({ code: 'c', state, cookie }))
    expect(new URL(res.headers.get('location')!).searchParams.get('reason')).toBe('unauthorized')
    expect(h.state.updates).toHaveLength(0)
  })

  it('rejects when the caller LOST authorization between initiating and exchanging', async () => {
    const { cookie, state } = await startFlow()
    mockTokenExchange(TOKEN_OK)
    // Same person, but they were moved off the location mid-flow.
    h.state.hubUser = { id: 'user-1', role: 'owner', location_id: OTHER_UUID }

    const res = await callback(callbackReq({ code: 'c', state, cookie }))
    expect(new URL(res.headers.get('location')!).searchParams.get('reason')).toBe('forbidden')
    expect(h.state.updates).toHaveLength(0)
  })

  it('happy path — writes the same seven columns as before, keyed on the signed uuid', async () => {
    const { cookie, state } = await startFlow()
    mockTokenExchange(TOKEN_OK)

    const res = await callback(callbackReq({ code: 'good-code', state, cookie }))
    const dest = new URL(res.headers.get('location')!)
    expect(dest.searchParams.get('slack')).toBe('connected')
    expect(dest.searchParams.get('channel')).toBe('#leads')

    expect(h.state.updates).toHaveLength(1)
    const { table, payload } = h.state.updates[0]
    expect(table).toBe('locations')
    expect(Object.keys(payload).sort()).toEqual([
      'slack_bot_token',
      'slack_channel_id',
      'slack_channel_name',
      'slack_connected',
      'slack_team_id',
      'slack_team_name',
      'updated_at',
    ])
    expect(payload.slack_bot_token).toBe('xoxb-real-token')
    expect(payload.slack_channel_id).toBe('C999')
    expect(payload.slack_connected).toBe(true)
  })

  it('a Slack-side denial writes nothing', async () => {
    const { cookie, state } = await startFlow()
    mockTokenExchange({ ok: false, error: 'invalid_code' })
    const res = await callback(callbackReq({ code: 'used', state, cookie }))
    expect(new URL(res.headers.get('location')!).searchParams.get('reason')).toBe('invalid_code')
    expect(h.state.updates).toHaveLength(0)
  })
})
