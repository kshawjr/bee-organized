// lib/jobber-introspect-token-health.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Pins the token-health check in scripts/introspect-jobber-schema.mjs.
//
// The bug: the script gated on a non-expired ACCESS token. Access tokens live
// 55 minutes and refresh only ON DEMAND, so a fleet where every location was
// perfectly healthy reported "NO_VALID_TOKEN: no location has a non-expired
// token" — the exact v2 false alarm lib/jobber-status.ts exists to kill. It
// blocked a build and sent us chasing a production outage that did not exist.
//
// The script is a side-effecting .mjs (it reads .env.local and calls
// process.exit at import time), so it cannot be imported and driven directly.
// Coverage is therefore two-part:
//   1. the PREDICATE it now delegates to — expired access token + healthy
//      refresh token must read as usable — exercised through the real shared
//      helper with the exact row shape the script feeds it;
//   2. a source sweep pinning the two regressions, so a future edit cannot
//      quietly reintroduce the expiry gate or re-swallow the query error.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { jobberStatusView } from '@/lib/jobber-status'

const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'introspect-jobber-schema.mjs')
const source = readFileSync(SCRIPT_PATH, 'utf8')

// The row shape the script selects, mapped exactly as it maps it.
type Row = {
  location_id: string
  jobber_connected?: boolean
  jobber_access_token?: string | null
  jobber_refresh_token?: string | null
  token_expiry?: string | null
  last_sync_status?: string | null
}

const HOUR = 60 * 60 * 1000

function gradeAsScriptDoes(l: Row) {
  return jobberStatusView({
    connected: !!l.jobber_connected,
    tokenExpiry: l.token_expiry ?? null,
    lastSyncStatus: l.last_sync_status ?? null,
    hasAccessToken: !!l.jobber_access_token,
    hasRefreshToken: !!l.jobber_refresh_token,
  })
}

const healthy = (over: Partial<Row> = {}): Row => ({
  location_id: 'loc_test',
  jobber_connected: true,
  jobber_access_token: 'a'.repeat(907),
  jobber_refresh_token: 'r'.repeat(32),
  // epoch-ms-as-string — the house storage convention.
  token_expiry: String(Date.now() + 30 * 60 * 1000),
  last_sync_status: 'Import complete',
  ...over,
})

describe('introspect script token health — the predicate', () => {
  it('treats an EXPIRED access token with a healthy refresh token as usable', () => {
    // This is the whole bug. Under the old gate this location was skipped.
    const view = gradeAsScriptDoes(healthy({ token_expiry: String(Date.now() - 3 * HOUR) }))
    expect(view.status).toBe('connected')
    expect(view.autoRefreshing).toBe(true)
  })

  it('treats a long-expired access token no differently from a barely-expired one', () => {
    const barely = gradeAsScriptDoes(healthy({ token_expiry: String(Date.now() - 60_000) }))
    const ancient = gradeAsScriptDoes(healthy({ token_expiry: String(Date.now() - 90 * 24 * HOUR) }))
    expect(barely.status).toBe('connected')
    expect(ancient.status).toBe('connected')
  })

  it('counts the whole real fleet as usable: 9 connected, both tokens, all access-expired', () => {
    // Tonight's verified production state — every location expired, zero
    // reconnect stamps. The old check found 0 usable and exited 2.
    const fleet = Array.from({ length: 9 }, (_, i) =>
      healthy({ location_id: `loc_${i}`, token_expiry: String(Date.now() - (i + 1) * HOUR) }),
    )
    const usable = fleet.filter(l => gradeAsScriptDoes(l).status === 'connected')
    expect(usable).toHaveLength(9)
  })

  it('a usable verdict always carries an access token to send as the bearer', () => {
    // The script relies on this: it never separately checks for a token.
    const noAccess = healthy({ jobber_access_token: null })
    expect(gradeAsScriptDoes(noAccess).status).toBe('reconnect_required')
  })

  it('rejects a RECONNECT REQUIRED stamp even when the access token is fresh', () => {
    const row = healthy({
      token_expiry: String(Date.now() + 30 * 60 * 1000),
      last_sync_status: 'RECONNECT REQUIRED: refresh token rejected (401)',
    })
    expect(gradeAsScriptDoes(row).status).toBe('reconnect_required')
  })

  it('rejects a missing refresh token — nothing left to renew with', () => {
    expect(gradeAsScriptDoes(healthy({ jobber_refresh_token: null })).status).toBe('reconnect_required')
  })

  it('rejects a location that was never connected', () => {
    expect(gradeAsScriptDoes(healthy({ jobber_connected: false })).status).toBe('disconnected')
  })

  it('prefers a fresh token but still accepts a stale one (expiry is a preference, not a gate)', () => {
    const now = Date.now()
    const expiryMsOf = (l: Row) => parseInt(l.token_expiry ?? '', 10)
    const isFresh = (l: Row) =>
      Number.isFinite(expiryMsOf(l)) && now < expiryMsOf(l) - 5 * 60 * 1000

    const stale = healthy({ location_id: 'stale', token_expiry: String(now - HOUR) })
    const fresh = healthy({ location_id: 'fresh', token_expiry: String(now + HOUR) })

    const usable = [stale, fresh].filter(l => gradeAsScriptDoes(l).status === 'connected')
    expect((usable.find(isFresh) || usable[0]).location_id).toBe('fresh')

    // ...and with only stale locations there is still a pick, not an exit 2.
    const staleOnly = [stale].filter(l => gradeAsScriptDoes(l).status === 'connected')
    expect((staleOnly.find(isFresh) || staleOnly[0]).location_id).toBe('stale')
  })
})

describe('introspect script token health — source regressions', () => {
  it('delegates to the shared helper rather than keeping a second opinion', () => {
    expect(source).toContain('lib/jobber-status')
    expect(source).toMatch(/jobberStatusView\(\{/)
  })

  it('does not gate location selection on access-token expiry', () => {
    // The original bug line: .find(l => l.token_expiry && now < parseInt(...) - 5*60*1000)
    expect(source).not.toMatch(/find\(\s*l\s*=>\s*l\.token_expiry/)
    // Expiry may still be consulted, but only to PREFER a fresh token among
    // locations the helper already called usable.
    expect(source).toMatch(/usable\.find\(isFresh\)\s*\|\|\s*usable\[0\]/)
  })

  it('captures the PostgREST error instead of discarding it', () => {
    // `const { data: locs }` alone made a bad column name look like a dead fleet.
    expect(source).toMatch(/const\s*\{\s*data:\s*locs,\s*error:\s*locsError\s*\}/)
    expect(source).toMatch(/if\s*\(locsError\)/)
    expect(source).toContain('LOCATIONS_QUERY_FAILED')
    // The message must carry the actual PostgREST detail, not just a label.
    expect(source).toContain('locsError.message')
    expect(source).toContain('locsError.code')
  })

  it('no longer emits the misleading NO_VALID_TOKEN message', () => {
    expect(source).not.toContain('NO_VALID_TOKEN')
    expect(source).not.toContain('no location has a non-expired token')
  })

  it('names the failing condition when nothing is usable', () => {
    expect(source).toContain('NO_USABLE_LOCATION')
    // A per-status tally, plus a distinct reason for each way a connected
    // location can be broken.
    expect(source).toMatch(/tally\.reconnect_required/)
    expect(source).toContain('RECONNECT REQUIRED')
    expect(source).toContain('no refresh token')
    expect(source).toContain('no access token stored')
    // The never-connected tail is counted, not enumerated — 45 identical lines
    // buried the signal when this branch was first driven against real data.
    expect(source).toMatch(/graded\.filter\(g => g\.view\.status === 'reconnect_required'\)/)
  })

  it('still never refreshes — no token write from this read-only script', () => {
    expect(source).not.toMatch(/\.update\(/)
    expect(source).not.toMatch(/\.upsert\(/)
    expect(source).not.toContain('oauth/token')
    expect(source).not.toContain('refresh_token=')
  })
})
