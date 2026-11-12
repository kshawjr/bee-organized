// @vitest-environment node
//
// Job channels, slice 1 — the Slack permission and knowing who has granted it.
//
// Pins:
//   • the connect URL asks for channels:manage, and NOT groups:write;
//   • a fresh connect stores the scope string Slack granted;
//   • the callback still connects before migrations/slack_scopes.sql runs;
//   • null / lacking scopes read as not-ready, granted reads as ready;
//   • a missing_scope answer from Slack flips a ready location back;
//   • slack_bot_token appears in no response and no log line;
//   • no owner-facing location read selects the token.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => {
  const state = {
    location: null as any,
    hubUser: null as any,
    authUser: null as any,
    updates: [] as { table: string; payload: any }[],
    // Result for each successive locations.update(...), in order. Empty → ok.
    updateResults: [] as { data: any; error: any }[],
    selectRow: null as any,
  }
  const makeBuilder = (table: string) => {
    const b: any = {}
    let isUpdate = false
    for (const m of ['select', 'eq', 'limit', 'order']) b[m] = () => b
    b.update = (payload: any) => {
      state.updates.push({ table, payload: { ...payload } })
      isUpdate = true
      return b
    }
    const row = () =>
      table === 'hub_users'
        ? { data: state.hubUser, error: null }
        : { data: state.selectRow ?? state.location, error: null }
    b.single = async () => row()
    b.maybeSingle = async () => row()
    b.then = (res: any, rej: any) => {
      const out = isUpdate ? (state.updateResults.shift() ?? { data: null, error: null }) : { data: null, error: null }
      return Promise.resolve(out).then(res, rej)
    }
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
import { SLACK_OAUTH_STATE_COOKIE, __resetConsumedNoncesForTest } from '@/lib/slack-oauth-guard'
import {
  slackCanManageChannels,
  scopesAfterMissingScope,
  parseSlackScopes,
} from '@/lib/slack-scopes'
import { recordSlackMissingScope } from '@/lib/slack-scopes-server'

const LOC_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TOKEN = 'xoxb-SECRET-token-must-never-leak'
const NEW_SCOPES =
  'chat:write,chat:write.public,channels:read,channels:manage,incoming-webhook,users:read,users:read.email'
const OLD_SCOPES = 'chat:write,chat:write.public,channels:read,incoming-webhook,users:read,users:read.email'

const req = (url: string, cookie?: string) =>
  new NextRequest(new Request(url, { headers: cookie ? { cookie } : {} }))

const TOKEN_OK = {
  ok: true,
  access_token: TOKEN,
  scope: NEW_SCOPES,
  team: { id: 'T123', name: 'Bee Organized Portland' },
  incoming_webhook: { channel_id: 'C999', channel: '#leads' },
}

const mockTokenExchange = (bodyText: string) =>
  vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => bodyText,
  } as any)

async function startFlow() {
  const res = await connect(req('https://hub.test/api/slack/connect?location_id=portland-01'))
  const cookie = res.cookies.get(SLACK_OAUTH_STATE_COOKIE)?.value
  const state = new URL(res.headers.get('location') || '').searchParams.get('state') || ''
  return { cookie, state, res }
}

async function runCallback(bodyText: string) {
  const { cookie, state } = await startFlow()
  mockTokenExchange(bodyText)
  const p = new URLSearchParams({ code: 'good-code', state })
  return callback(req(`https://hub.test/api/slack/callback?${p}`, `${SLACK_OAUTH_STATE_COOKIE}=${cookie}`))
}

const COLUMN_MISSING = {
  data: null,
  error: { code: 'PGRST204', message: "Could not find the 'slack_scopes' column of 'locations' in the schema cache" },
}

let logged: string[]

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
  h.state.updateResults = []
  h.state.selectRow = null
  logged = []
  const cap = (...a: any[]) => {
    logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))).join(' '))
  }
  vi.spyOn(console, 'log').mockImplementation(cap)
  vi.spyOn(console, 'error').mockImplementation(cap)
  vi.spyOn(console, 'warn').mockImplementation(cap)
})

// ── 1. The ask ───────────────────────────────────────────────────────────────
describe('the connect URL', () => {
  const scopesAsked = async () => {
    const { res } = await startFlow()
    return parseSlackScopes(new URL(res.headers.get('location')!).searchParams.get('scope'))
  }

  it('asks for channels:manage', async () => {
    expect((await scopesAsked()).has('channels:manage')).toBe(true)
  })

  it('does not ask for groups:write (public channels only)', async () => {
    expect((await scopesAsked()).has('groups:write')).toBe(false)
  })

  it('still asks for everything it asked for before', async () => {
    const asked = await scopesAsked()
    Array.from(parseSlackScopes(OLD_SCOPES)).forEach((s) => expect(asked.has(s), s).toBe(true))
  })
})

// ── 2. Recording the grant ───────────────────────────────────────────────────
describe('the callback records what Slack granted', () => {
  it('a fresh connect stores the granted scope string', async () => {
    const res = await runCallback(JSON.stringify(TOKEN_OK))
    expect(new URL(res.headers.get('location')!).searchParams.get('slack')).toBe('connected')
    expect(h.state.updates).toHaveLength(1)
    expect(h.state.updates[0].payload.slack_scopes).toBe(NEW_SCOPES)
    expect(h.state.updates[0].payload.slack_bot_token).toBe(TOKEN)
  })

  it('a connect whose response carries no scope stores null (unknown), never a guess', async () => {
    const { scope, ...noScope } = TOKEN_OK
    await runCallback(JSON.stringify(noScope))
    expect(h.state.updates[0].payload.slack_scopes).toBeNull()
  })

  it('still connects before the migration runs: drops slack_scopes, writes the rest', async () => {
    h.state.updateResults = [COLUMN_MISSING, { data: null, error: null }]
    const res = await runCallback(JSON.stringify(TOKEN_OK))
    expect(new URL(res.headers.get('location')!).searchParams.get('slack')).toBe('connected')
    expect(h.state.updates).toHaveLength(2)
    const retry = h.state.updates[1].payload
    expect('slack_scopes' in retry).toBe(false)
    expect(retry.slack_bot_token).toBe(TOKEN)
    expect(retry.slack_channel_id).toBe('C999')
    expect(retry.slack_connected).toBe(true)
  })

  it('any OTHER write error is still a failure (no silent retry)', async () => {
    h.state.updateResults = [{ data: null, error: { code: '42501', message: 'permission denied for table locations' } }]
    const res = await runCallback(JSON.stringify(TOKEN_OK))
    expect(new URL(res.headers.get('location')!).searchParams.get('reason')).toBe('supabase_write_failed')
    expect(h.state.updates).toHaveLength(1)
  })
})

// ── 3. The one helper ────────────────────────────────────────────────────────
describe('slackCanManageChannels', () => {
  it('null slack_scopes reads as not-ready', () => {
    expect(slackCanManageChannels({ slack_connected: true, slack_scopes: null })).toBe(false)
    expect(slackCanManageChannels({ slack_connected: true })).toBe(false)
  })

  it('stored scopes lacking channels:manage read as not-ready', () => {
    expect(slackCanManageChannels({ slack_connected: true, slack_scopes: OLD_SCOPES })).toBe(false)
    // A near-miss name is not the scope.
    expect(slackCanManageChannels({ slack_connected: true, slack_scopes: 'channels:manage.extra,groups:write' })).toBe(false)
  })

  it('stored scopes with channels:manage read as ready', () => {
    expect(slackCanManageChannels({ slack_connected: true, slack_scopes: NEW_SCOPES })).toBe(true)
    expect(slackCanManageChannels({ slack_connected: true, slack_scopes: ' channels:manage ' })).toBe(true)
  })

  it('not connected is never ready, whatever is stored', () => {
    expect(slackCanManageChannels({ slack_connected: false, slack_scopes: NEW_SCOPES })).toBe(false)
    expect(slackCanManageChannels(null)).toBe(false)
  })
})

describe('the runtime correction (missing_scope from Slack is authoritative)', () => {
  const MISSING = { ok: false, error: 'missing_scope', needed: 'channels:manage', provided: OLD_SCOPES }

  it('flips a stored-ready location back to not-ready', () => {
    const next = scopesAfterMissingScope(NEW_SCOPES, MISSING)
    expect(next).not.toBeNull()
    expect(slackCanManageChannels({ slack_connected: true, slack_scopes: next })).toBe(false)
  })

  it('without `provided`, removes what was needed from what was stored', () => {
    const next = scopesAfterMissingScope(NEW_SCOPES, { ok: false, error: 'missing_scope', needed: 'channels:manage' })
    expect(parseSlackScopes(next).has('channels:manage')).toBe(false)
    expect(parseSlackScopes(next).has('chat:write')).toBe(true)
  })

  it('any other answer is not a correction', () => {
    expect(scopesAfterMissingScope(NEW_SCOPES, { ok: false, error: 'not_in_channel' })).toBeNull()
    expect(scopesAfterMissingScope(NEW_SCOPES, { ok: true })).toBeNull()
  })

  it('recordSlackMissingScope stores the corrected string, and tolerates the column being absent', async () => {
    h.state.selectRow = { slack_scopes: NEW_SCOPES }
    const r = await recordSlackMissingScope(LOC_UUID, MISSING)
    expect(r.corrected).toBe(true)
    expect(h.state.updates).toHaveLength(1)
    expect(parseSlackScopes(h.state.updates[0].payload.slack_scopes).has('channels:manage')).toBe(false)
    expect(Object.keys(h.state.updates[0].payload)).toEqual(['slack_scopes'])

    h.state.updates = []
    h.state.updateResults = [COLUMN_MISSING]
    expect(await recordSlackMissingScope(LOC_UUID, MISSING)).toEqual({ corrected: false, reason: 'not_set_up_yet' })
  })

  it('recordSlackMissingScope writes nothing for a non-scope error', async () => {
    expect(await recordSlackMissingScope(LOC_UUID, { ok: false, error: 'channel_not_found' })).toEqual({
      corrected: false,
      reason: 'not_missing_scope',
    })
    expect(h.state.updates).toHaveLength(0)
  })
})

// ── 4. The token stays server-only ───────────────────────────────────────────
describe('slack_bot_token appears in no response and no log', () => {
  const leaks = async (res: Response) => {
    const where = [res.headers.get('location') || '', await res.clone().text(), ...logged]
    return where.filter((s) => s.includes(TOKEN) || s.includes('xoxb-'))
  }

  it('happy path', async () => {
    expect(await leaks(await runCallback(JSON.stringify(TOKEN_OK)))).toEqual([])
    expect(logged.length).toBeGreaterThan(0) // the success line really was captured
  })

  it('pre-migration retry path', async () => {
    h.state.updateResults = [COLUMN_MISSING, { data: null, error: null }]
    expect(await leaks(await runCallback(JSON.stringify(TOKEN_OK)))).toEqual([])
  })

  it('write-failure path, even when the database error echoes the row', async () => {
    h.state.updateResults = [{
      data: null,
      error: { code: '23514', message: 'check violation', details: `Failing row contains (${TOKEN}, T123)` },
    }]
    expect(await leaks(await runCallback(JSON.stringify(TOKEN_OK)))).toEqual([])
    expect(logged.some((l) => l.includes('Supabase write failed'))).toBe(true)
  })

  it('a not-ok response that still carries a token', async () => {
    expect(await leaks(await runCallback(JSON.stringify({ access_token: TOKEN, error: undefined })))).toEqual([])
  })

  it('a truncated (unparseable) token response', async () => {
    const truncated = JSON.stringify(TOKEN_OK).slice(0, 60)
    expect(truncated).toContain('xoxb-')
    expect(await leaks(await runCallback(truncated))).toEqual([])
  })

  it('no locations read in the hub page selects slack_bot_token or "*"', () => {
    const src = readFileSync(join(process.cwd(), 'app/_hub-page.tsx'), 'utf8')
    const selects = Array.from(
      src.matchAll(/\.from\('locations'\)\s*\.select\(\s*(?:\/\/[^\n]*\n\s*)*(['"`])([\s\S]*?)\1/g),
    ).map((m) => m[2])
    expect(selects.length).toBeGreaterThanOrEqual(10)
    expect(selects.some((s) => s.includes('slack_scopes'))).toBe(true)
    for (const s of selects) {
      expect(s.includes('slack_bot_token'), s).toBe(false)
      expect(s.trim() === '*', s).toBe(false)
    }
  })
})
