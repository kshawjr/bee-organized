// lib/beta-jobber-token-refresh.test.ts
// ─────────────────────────────────────────────────────────────
// Pins the Jobber auto-refresh contract (root-cause fix for the chronic
// `no_valid_jobber_token` webhook failures):
//   1. an expired access token triggers a refresh, not a hard fail
//   2. the refreshed token is persisted (access + rotated refresh) and reused
//   3. jobberGraphQL retries ONCE on a 401 (force-refresh + re-fetch)
//   4. a genuinely dead refresh token surfaces a distinct reconnect signal
//      and stamps a RECONNECT-REQUIRED status without clobbering the tokens
//   5. the double-checked re-read reuses a token another caller just wrote
//      (no needless second rotation of the single-use refresh token)
//   6. persist-guard: a response without a new refresh_token never nulls it
// ─────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── controllable supabaseService mock (single `locations` row) ──
const state: {
  row: any
  reads: any[] | null      // when set, getLocation SELECTs shift from here
  updates: Array<{ patch: any }>
} = { row: null, reads: null, updates: [] }

function locBuilder() {
  return {
    select: () => ({
      eq: () => ({
        single: async () => ({ data: nextRead(), error: null }),
        maybeSingle: async () => ({ data: nextRead(), error: null }),
      }),
    }),
    update: (patch: any) => {
      state.updates.push({ patch })
      state.row = { ...state.row, ...patch }
      return { eq: async () => ({ error: null }) }
    },
  }
}
function nextRead() {
  if (state.reads && state.reads.length) return state.reads.shift()
  return state.row
}
vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: () => locBuilder() },
}))

import {
  getValidJobberToken,
  jobberGraphQL,
  JobberReauthRequiredError,
} from '@/lib/jobber'

// ── fetch stub: routes OAuth token vs GraphQL by URL ──
const oauth = vi.fn()
const graphql = vi.fn()
function resp(status: number, body: any, asText = false) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (asText ? JSON.parse(text) : body),
  }
}
beforeEach(() => {
  state.row = null
  state.reads = null
  state.updates = []
  oauth.mockReset()
  graphql.mockReset()
  process.env.JOBBER_CLIENT_ID = 'cid'
  process.env.JOBBER_CLIENT_SECRET = 'csecret'
  global.fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('/oauth/token')) return oauth(init) as any
    return graphql(init) as any
  }) as any
})

const PAST = Date.now() - 60_000
const FUTURE = Date.now() + 60 * 60_000

function baseRow(over: any = {}) {
  return {
    location_id: 'loc_test',
    jobber_access_token: 'old_access',
    jobber_refresh_token: 'refresh_v0',
    token_expiry: String(PAST),
    ...over,
  }
}

describe('getValidJobberToken', () => {
  it('refreshes an expired token instead of failing, and returns the new one', async () => {
    state.row = baseRow()
    oauth.mockResolvedValue(resp(200, { access_token: 'new_access', refresh_token: 'refresh_v1' }))

    const token = await getValidJobberToken(baseRow())

    expect(token).toBe('new_access')
    expect(oauth).toHaveBeenCalledTimes(1)
  })

  it('persists the refreshed access + rotated refresh token, then reuses it (no 2nd OAuth call)', async () => {
    state.row = baseRow()
    oauth.mockResolvedValue(resp(200, { access_token: 'new_access', refresh_token: 'refresh_v1' }))

    await getValidJobberToken(baseRow())
    const patch = state.updates.at(-1)!.patch
    expect(patch.jobber_access_token).toBe('new_access')
    expect(patch.jobber_refresh_token).toBe('refresh_v1')
    expect(Number(patch.token_expiry)).toBeGreaterThan(Date.now())

    // Row is now valid — a subsequent call must not hit Jobber again.
    oauth.mockClear()
    const reused = await getValidJobberToken(state.row)
    expect(reused).toBe('new_access')
    expect(oauth).not.toHaveBeenCalled()
  })

  it('reuses a token another caller already refreshed (double-checked re-read, no 2nd rotation)', async () => {
    // Caller passes a stale/expired row, but the DB re-read shows a fresh one.
    const stale = baseRow()
    state.reads = [baseRow({ jobber_access_token: 'peer_access', token_expiry: String(FUTURE) })]

    const token = await getValidJobberToken(stale)

    expect(token).toBe('peer_access')
    expect(oauth).not.toHaveBeenCalled() // did NOT burn the rotating refresh token
  })

  it('persist-guard: a response without a new refresh_token never overwrites the stored one', async () => {
    state.row = baseRow()
    oauth.mockResolvedValue(resp(200, { access_token: 'new_access' })) // no refresh_token

    await getValidJobberToken(baseRow())
    const patch = state.updates.at(-1)!.patch
    expect(patch.jobber_access_token).toBe('new_access')
    expect('jobber_refresh_token' in patch).toBe(false)
  })

  it('surfaces a distinct reconnect error + stamps status on a dead refresh token', async () => {
    state.row = baseRow()
    oauth.mockResolvedValue(resp(400, { error: 'invalid_grant' }))

    await expect(getValidJobberToken(baseRow())).rejects.toBeInstanceOf(JobberReauthRequiredError)

    const patch = state.updates.at(-1)!.patch
    expect(patch.last_sync_status).toMatch(/RECONNECT REQUIRED/)
    // never clobber the token columns on a failed refresh
    expect('jobber_access_token' in patch).toBe(false)
    expect('jobber_refresh_token' in patch).toBe(false)
  })
})

describe('jobberGraphQL', () => {
  it('returns a distinct jobber_reauth_required error when the refresh token is dead', async () => {
    state.row = baseRow()
    oauth.mockResolvedValue(resp(400, { error: 'invalid_grant' }))

    const res = await jobberGraphQL('loc_test', '{ account { id } }')
    expect(res.errors?.[0]?.message).toBe('jobber_reauth_required')
    expect(graphql).not.toHaveBeenCalled()
  })

  it('retries ONCE on a 401 by force-refreshing, then succeeds', async () => {
    state.row = baseRow({ token_expiry: String(FUTURE) }) // clock says valid
    oauth.mockResolvedValue(resp(200, { access_token: 'minted_access', refresh_token: 'refresh_v1' }))
    graphql
      .mockResolvedValueOnce(resp(401, 'unauthorized', false))
      .mockResolvedValueOnce(resp(200, { data: { account: { id: 'A1' } } }))

    const res = await jobberGraphQL('loc_test', '{ account { id } }')

    expect(res.data?.account?.id).toBe('A1')
    expect(oauth).toHaveBeenCalledTimes(1)   // exactly one forced refresh
    expect(graphql).toHaveBeenCalledTimes(2) // original + one retry
  })

  it('does not retry more than once — a persistent 401 after refresh throws', async () => {
    state.row = baseRow({ token_expiry: String(FUTURE) })
    oauth.mockResolvedValue(resp(200, { access_token: 'minted_access', refresh_token: 'refresh_v1' }))
    graphql.mockResolvedValue(resp(401, 'unauthorized', false)) // always 401

    await expect(jobberGraphQL('loc_test', '{ account { id } }')).rejects.toThrow(/HTTP 401/)
    expect(graphql).toHaveBeenCalledTimes(2) // original + single retry, no more
  })
})
