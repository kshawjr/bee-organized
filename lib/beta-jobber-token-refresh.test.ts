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
  readCount: number        // every locations SELECT, for the fingerprint pins
} = { row: null, reads: null, updates: [], readCount: 0 }

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
  state.readCount++
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
  computeTokenExpiryMs,
  DEFAULT_TOKEN_LIFETIME_MS,
  __raceResolveTuning,
  __transientRefreshTuning,
} from '@/lib/jobber'

// Keep the concurrent-refresh race poll near-instant in tests (prod: 4×500ms).
__raceResolveTuning.attempts = 4
__raceResolveTuning.intervalMs = 1
// Same for the busy-reply (503) wait (prod: 3×200ms).
__transientRefreshTuning.attempts = 3
__transientRefreshTuning.intervalMs = 1

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
  state.readCount = 0
  __raceResolveTuning.intervalMs = 1
  __transientRefreshTuning.intervalMs = 1
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

  // ── Concurrent-refresh race (#102) ─────────────────────────────
  it('invalid_grant that is a concurrent-refresh race loss adopts the winner’s token — no stamp, no throw', async () => {
    // Our POST loses the single-use rotation: Jobber returns invalid_grant.
    // Reads: [double-check still-old] then [winner has rotated + written a
    // fresh, clock-valid token]. We must adopt it instead of stamping.
    state.row = baseRow()
    state.reads = [
      baseRow(), // performRefresh double-check: still the old, expired row
      baseRow({ jobber_refresh_token: 'refresh_v1', jobber_access_token: 'winner_access', token_expiry: String(FUTURE) }),
    ]
    oauth.mockResolvedValue(resp(400, { error: 'invalid_grant' }))

    const token = await getValidJobberToken(baseRow())

    expect(token).toBe('winner_access')          // adopted the winner's token
    expect(oauth).toHaveBeenCalledTimes(1)        // did NOT re-rotate
    // no RECONNECT-REQUIRED stamp was written
    const stamped = state.updates.some(u => /RECONNECT REQUIRED/.test(u.patch.last_sync_status || ''))
    expect(stamped).toBe(false)
  })

  it('invalid_grant with NO concurrent rotation is still a genuine dead token — stamps + throws', async () => {
    // Every re-read shows the SAME (un-rotated) refresh token → nothing raced,
    // so the token is genuinely dead and we must fall through to the stamp.
    state.row = baseRow()                         // all reads return this (refresh_v0, expired)
    oauth.mockResolvedValue(resp(400, { error: 'invalid_grant' }))

    await expect(getValidJobberToken(baseRow())).rejects.toBeInstanceOf(JobberReauthRequiredError)
    expect(state.updates.some(u => /RECONNECT REQUIRED/.test(u.patch.last_sync_status || ''))).toBe(true)
  })

  it('race loss where the winner only rotated the ACCESS token (expiry still stale) does NOT falsely adopt', async () => {
    // Defensive: a rotated refresh token but a token_expiry that is NOT yet
    // clock-valid must not be adopted (tokenValid guard) → genuine-dead path.
    state.row = baseRow()
    state.reads = [
      baseRow(),
      baseRow({ jobber_refresh_token: 'refresh_v1', jobber_access_token: 'winner_access', token_expiry: String(PAST) }),
    ]
    oauth.mockResolvedValue(resp(400, { error: 'invalid_grant' }))

    await expect(getValidJobberToken(baseRow())).rejects.toBeInstanceOf(JobberReauthRequiredError)
  })
})

describe('token lifetime from expires_in', () => {
  const MARGIN = 60_000

  it('uses Jobber-reported expires_in (minus the margin) instead of the 55-min assumption', () => {
    const before = Date.now()
    const expiry = computeTokenExpiryMs(3600, 'test')
    const after = Date.now()
    expect(expiry).toBeGreaterThanOrEqual(before + 3600_000 - MARGIN)
    expect(expiry).toBeLessThanOrEqual(after + 3600_000 - MARGIN)
  })

  it('accepts a numeric-string expires_in', () => {
    const before = Date.now()
    const expiry = computeTokenExpiryMs('1800', 'test')
    expect(expiry).toBeGreaterThanOrEqual(before + 1800_000 - MARGIN)
  })

  it.each([undefined, null, 'soon', '', -5, 0, NaN])(
    'falls back to the 55-min default on unusable expires_in (%s) — never NaN/null',
    (bad) => {
      const before = Date.now()
      const expiry = computeTokenExpiryMs(bad, 'test')
      expect(Number.isFinite(expiry)).toBe(true)
      expect(expiry).toBeGreaterThanOrEqual(before + DEFAULT_TOKEN_LIFETIME_MS)
      expect(expiry).toBeLessThanOrEqual(Date.now() + DEFAULT_TOKEN_LIFETIME_MS)
    },
  )

  it('rejects a non-credible lifetime (looks like milliseconds, not seconds) and falls back', () => {
    const before = Date.now()
    const expiry = computeTokenExpiryMs(3_600_000, 'test')
    expect(expiry).toBeGreaterThanOrEqual(before + DEFAULT_TOKEN_LIFETIME_MS)
    expect(expiry).toBeLessThanOrEqual(Date.now() + DEFAULT_TOKEN_LIFETIME_MS)
  })

  it('a very short grant still yields a future expiry (half-grant clamp, never past)', () => {
    const before = Date.now()
    const expiry = computeTokenExpiryMs(90, 'test') // margin would leave 30s; clamp gives 45s
    expect(expiry).toBeGreaterThan(before)
    expect(expiry).toBeLessThanOrEqual(Date.now() + 90_000)
  })

  it('refresh persists the observed lifetime as epoch-ms (parseInt-compatible)', async () => {
    state.row = baseRow()
    oauth.mockResolvedValue(resp(200, {
      access_token: 'new_access',
      refresh_token: 'refresh_v1',
      expires_in: 3600,
    }))

    const before = Date.now()
    await getValidJobberToken(baseRow())

    const patch = state.updates.at(-1)!.patch
    const written = parseInt(String(patch.token_expiry))
    expect(Number.isInteger(written)).toBe(true)
    expect(String(written)).toBe(String(patch.token_expiry)) // pure epoch-ms, no decoration
    expect(written).toBeGreaterThanOrEqual(before + 3600_000 - MARGIN)
    expect(written).toBeLessThanOrEqual(Date.now() + 3600_000 - MARGIN)
  })

  it('refresh without expires_in still writes the 55-min default expiry', async () => {
    state.row = baseRow()
    oauth.mockResolvedValue(resp(200, { access_token: 'new_access', refresh_token: 'refresh_v1' }))

    const before = Date.now()
    await getValidJobberToken(baseRow())

    const written = parseInt(String(state.updates.at(-1)!.patch.token_expiry))
    expect(written).toBeGreaterThanOrEqual(before + DEFAULT_TOKEN_LIFETIME_MS)
    expect(written).toBeLessThanOrEqual(Date.now() + DEFAULT_TOKEN_LIFETIME_MS)
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

// ─────────────────────────────────────────────────────────────
// Busy-reply recovery (2026-11). What a concurrent-refresh LOSER gets from
// Jobber in prod is 503 `temporarily_unavailable — "Retry the request."`, not
// invalid_grant (14 of 15 failure bursts sampled). The code called that
// "retryable" and then threw; nothing retried, and 432 webhooks failed with
// no_valid_jobber_token. Pins:
//   · a 503 (or 520, or a network throw) is retried — ONCE
//   · a winner's token that landed meanwhile is adopted without a 2nd POST
//   · nothing retries more than once per call
//   · a caller sharing a failed refresh re-reads the stored token first
//   · a 400/401 still raises reauth with NO retry and NO added wait
//   · a refresh that simply succeeds is untouched (same calls, no waiting)
// ─────────────────────────────────────────────────────────────
const BUSY = {
  error: 'temporarily_unavailable',
  error_description: 'The authorization server is temporarily unable to process the request. Retry the request.',
}
const stamped = () => state.updates.some(u => /RECONNECT REQUIRED/.test(u.patch.last_sync_status || ''))

describe('busy reply (503) on token refresh', () => {
  it('a 503 is retried, and the retry’s token is used and saved', async () => {
    state.row = baseRow()
    oauth
      .mockResolvedValueOnce(resp(503, BUSY))
      .mockResolvedValueOnce(resp(200, { access_token: 'second_try', refresh_token: 'refresh_v1' }))

    const token = await getValidJobberToken(baseRow())

    expect(token).toBe('second_try')
    expect(oauth).toHaveBeenCalledTimes(2)
    expect(state.updates.at(-1)!.patch.jobber_access_token).toBe('second_try')
    expect(stamped()).toBe(false)
  })

  it('through jobberGraphQL: a webhook whose refresh got a 503 still fetches its record', async () => {
    state.row = baseRow()
    oauth
      .mockResolvedValueOnce(resp(503, BUSY))
      .mockResolvedValueOnce(resp(200, { access_token: 'second_try', refresh_token: 'refresh_v1' }))
    graphql.mockResolvedValue(resp(200, { data: { request: { id: 'R1' } } }))

    const res = await jobberGraphQL('loc_test', '{ request { id } }')

    expect(res.errors).toBeUndefined()
    expect(res.data?.request?.id).toBe('R1')
  })

  it('a 503 because another copy won the race adopts the winner’s token — no second POST', async () => {
    state.row = baseRow()
    state.reads = [
      baseRow(), // double-check before the POST: still the old row
      baseRow({ jobber_refresh_token: 'refresh_v1', jobber_access_token: 'winner_access', token_expiry: String(FUTURE) }),
    ]
    oauth.mockResolvedValue(resp(503, BUSY))

    const token = await getValidJobberToken(baseRow())

    expect(token).toBe('winner_access')
    expect(oauth).toHaveBeenCalledTimes(1) // did not burn the winner's new refresh token
    expect(state.updates).toHaveLength(0)  // wrote nothing over the winner's row
  })

  it('WAITS for the winner’s write rather than re-posting at once (it lands a beat after the 503)', async () => {
    // In prod the winner's row landed 20–25ms after the loser's 503. An
    // immediate second POST would spend the old refresh token against a
    // rotation already under way; the wait is what makes the 503 harmless.
    state.row = baseRow()
    state.reads = [
      baseRow(), // double-check before the POST
      baseRow(), // first look after the 503: winner has not written yet
      baseRow({ jobber_refresh_token: 'refresh_v1', jobber_access_token: 'winner_access', token_expiry: String(FUTURE) }),
    ]
    oauth.mockResolvedValue(resp(503, BUSY))

    expect(await getValidJobberToken(baseRow())).toBe('winner_access')
    expect(oauth).toHaveBeenCalledTimes(1)
    expect(state.readCount).toBe(3)
  })

  it('gives the winner at most the tuned number of looks, then posts once more', async () => {
    state.row = baseRow() // nobody ever wins
    oauth
      .mockResolvedValueOnce(resp(503, BUSY))
      .mockResolvedValueOnce(resp(200, { access_token: 'second_try', refresh_token: 'refresh_v1' }))

    await getValidJobberToken(baseRow())

    // 1 double-check + 3 looks for a winner + the retry's own double-check
    expect(state.readCount).toBe(1 + __transientRefreshTuning.attempts + 1)
  })

  it('the production wait is 3 × 200ms — under a second, well inside the #102 window', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('./jobber.ts', import.meta.url), 'utf8')
    expect(src).toContain('export const __transientRefreshTuning = { attempts: 3, intervalMs: 200 }')
    expect(src).toContain('export const __raceResolveTuning = { attempts: 4, intervalMs: 500 }')
  })

  it('a non-JSON 5xx (the 520 HTML error page) is retried the same way', async () => {
    state.row = baseRow()
    oauth
      .mockResolvedValueOnce(resp(520, '<!DOCTYPE html><html><title>Application Error</title></html>'))
      .mockResolvedValueOnce(resp(200, { access_token: 'second_try', refresh_token: 'refresh_v1' }))

    expect(await getValidJobberToken(baseRow())).toBe('second_try')
    expect(oauth).toHaveBeenCalledTimes(2)
  })

  it('a fetch that throws (network) is retried the same way', async () => {
    state.row = baseRow()
    oauth
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(resp(200, { access_token: 'second_try', refresh_token: 'refresh_v1' }))

    expect(await getValidJobberToken(baseRow())).toBe('second_try')
    expect(oauth).toHaveBeenCalledTimes(2)
  })

  it('retries ONCE only — a 503 that persists fails as a plain transient, never a reconnect', async () => {
    state.row = baseRow()
    oauth.mockResolvedValue(resp(503, BUSY)) // always busy

    const err = await getValidJobberToken(baseRow()).catch(e => e)

    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(JobberReauthRequiredError)
    expect(String(err.message)).toMatch(/refresh failed \(503\)/)
    expect(oauth).toHaveBeenCalledTimes(2) // original + one retry, no more
    expect(stamped()).toBe(false)
  })

  it('through jobberGraphQL a persistent 503 is still no_valid_jobber_token after exactly two POSTs', async () => {
    state.row = baseRow()
    oauth.mockResolvedValue(resp(503, BUSY))

    const res = await jobberGraphQL('loc_test', '{ account { id } }')

    expect(res.errors?.[0]?.message).toBe('no_valid_jobber_token')
    expect(oauth).toHaveBeenCalledTimes(2)
    expect(graphql).not.toHaveBeenCalled()
  })

  it('a retry that comes back REJECTED is a real reconnect — stamped and thrown as one', async () => {
    state.row = baseRow()
    oauth
      .mockResolvedValueOnce(resp(503, BUSY))
      .mockResolvedValueOnce(resp(400, { error: 'invalid_grant' }))

    await expect(getValidJobberToken(baseRow())).rejects.toBeInstanceOf(JobberReauthRequiredError)
    expect(oauth).toHaveBeenCalledTimes(2)
    expect(stamped()).toBe(true)
  })
})

describe('a caller sharing a refresh that fails', () => {
  it('re-reads the stored token rather than inheriting the failure', async () => {
    // Two webhooks on one instance: the second JOINS the first's refresh. That
    // refresh fails both tries — but by then another instance has stored a
    // good token (it lands as the second POST is answered). Neither caller may
    // fail: each takes one last look at the row.
    state.row = baseRow()
    let posts = 0
    oauth.mockImplementation(async () => {
      posts++
      if (posts === 2) {
        state.row = baseRow({ jobber_refresh_token: 'refresh_v9', jobber_access_token: 'peer_access', token_expiry: String(FUTURE) })
      }
      return resp(503, BUSY)
    })

    const [owner, joiner] = await Promise.all([
      getValidJobberToken(baseRow()),
      getValidJobberToken(baseRow()),
    ])

    expect(joiner).toBe('peer_access')
    expect(owner).toBe('peer_access')
    expect(oauth).toHaveBeenCalledTimes(2) // ONE shared refresh (1 + its retry), not two
  })

  it('still fails when no good token is stored — the last look is a read, not a wish', async () => {
    state.row = baseRow()
    oauth.mockResolvedValue(resp(503, BUSY))

    const results = await Promise.allSettled([
      getValidJobberToken(baseRow()),
      getValidJobberToken(baseRow()),
    ])

    expect(results.map(r => r.status)).toEqual(['rejected', 'rejected'])
    expect(oauth).toHaveBeenCalledTimes(2)
  })

  it('a joiner of a REJECTED refresh gets the reconnect error itself, not a stored token', async () => {
    // The stored access token even looks valid on the last read — it must not
    // be handed out: a rejection is rethrown before any look at the row.
    state.row = baseRow()
    oauth.mockImplementation(async () => {
      state.row = baseRow({ jobber_access_token: 'looks_fine', token_expiry: String(FUTURE) }) // same refresh_v0 → not a rotation
      return resp(400, { error: 'invalid_grant' })
    })

    const results = await Promise.allSettled([
      getValidJobberToken(baseRow()),
      getValidJobberToken(baseRow()),
    ])

    for (const r of results) {
      expect(r.status).toBe('rejected')
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(JobberReauthRequiredError)
    }
    expect(oauth).toHaveBeenCalledTimes(1)
  })

  it('a FORCED refresh that fails never falls back to the stored token Jobber just refused', async () => {
    state.row = baseRow({ token_expiry: String(FUTURE) }) // clock says valid
    graphql.mockResolvedValue(resp(401, 'unauthorized', false)) // Jobber says no
    oauth.mockResolvedValue(resp(503, BUSY))

    const res = await jobberGraphQL('loc_test', '{ account { id } }')

    expect(res.errors?.[0]?.message).toBe('no_valid_jobber_token')
    expect(graphql).toHaveBeenCalledTimes(1) // old_access was not sent a second time
  })
})

describe('a real reconnect is no quieter and no slower', () => {
  // The busy-reply wait is set to a full MINUTE here. If a 400/401 touched that
  // wait at all — once — these would hit the 5s test timeout. They finish in
  // milliseconds, so the rejection path provably never enters it.
  it.each([400, 401])('a %i on the refresh token: one POST, no retry, no busy-wait, stamped, thrown', async (status) => {
    __transientRefreshTuning.intervalMs = 60_000
    state.row = baseRow()
    oauth.mockResolvedValue(resp(status, { error: 'invalid_grant' }))

    const started = Date.now()
    await expect(getValidJobberToken(baseRow())).rejects.toBeInstanceOf(JobberReauthRequiredError)

    expect(Date.now() - started).toBeLessThan(1000)
    expect(oauth).toHaveBeenCalledTimes(1)          // never retried
    expect(stamped()).toBe(true)                    // still loud
    // Fingerprint, identical to before this change: 1 double-check read + the
    // 4 race-loss looks of #102. Not one read more.
    expect(state.readCount).toBe(1 + __raceResolveTuning.attempts)
    expect(state.updates).toHaveLength(1)           // the stamp, nothing else
  })

  it('a plain-text "authorization grant is invalid" body on a 5xx is still a reconnect, not a retry', async () => {
    __transientRefreshTuning.intervalMs = 60_000
    state.row = baseRow()
    oauth.mockResolvedValue(resp(500, 'The provided authorization grant is invalid, expired, revoked', false))

    await expect(getValidJobberToken(baseRow())).rejects.toBeInstanceOf(JobberReauthRequiredError)
    expect(oauth).toHaveBeenCalledTimes(1)
  })

  it('through jobberGraphQL: jobber_reauth_required after exactly one POST', async () => {
    __transientRefreshTuning.intervalMs = 60_000
    state.row = baseRow()
    oauth.mockResolvedValue(resp(401, { error: 'invalid_grant' }))

    const res = await jobberGraphQL('loc_test', '{ account { id } }')

    expect(res.errors?.[0]?.message).toBe('jobber_reauth_required')
    expect(oauth).toHaveBeenCalledTimes(1)
  })
})

describe('a refresh that simply works is untouched', () => {
  // Both waits are a full minute: any sleep on the success path times out.
  it('expired token + 200: one POST, one read, one write, no waiting', async () => {
    __transientRefreshTuning.intervalMs = 60_000
    __raceResolveTuning.intervalMs = 60_000
    state.row = baseRow()
    oauth.mockResolvedValue(resp(200, { access_token: 'new_access', refresh_token: 'refresh_v1', expires_in: 3600 }))

    const token = await getValidJobberToken(baseRow())

    expect(token).toBe('new_access')
    expect(oauth).toHaveBeenCalledTimes(1)
    expect(state.readCount).toBe(1)
    expect(state.updates).toHaveLength(1)
    expect(Object.keys(state.updates[0].patch).sort()).toEqual([
      'jobber_access_token', 'jobber_refresh_token', 'last_sync_status',
      'token_expiry', 'token_expiry_display', 'updated_at',
    ])
  })

  it('a still-valid token: no POST, no read, no write', async () => {
    __transientRefreshTuning.intervalMs = 60_000
    __raceResolveTuning.intervalMs = 60_000
    state.row = baseRow({ token_expiry: String(FUTURE) })

    expect(await getValidJobberToken(state.row)).toBe('old_access')
    expect(oauth).not.toHaveBeenCalled()
    expect(state.readCount).toBe(0)
    expect(state.updates).toHaveLength(0)
  })
})
