// lib/beta-jobber-badge-status.test.ts
// ─────────────────────────────────────────────────────────────
// Pins the refined three-state Jobber derivation (deriveJobberStatus +
// jobberStatusView, lib/jobber-status.ts). The badge used to fire amber
// "reconnect required" on ANY expired access token — but the access token is
// short-lived by design and silently auto-renews from a healthy refresh token
// on the next webhook. Only a GENUINELY dead connection needs a manual
// reconnect:
//   • a fail-loud 401 "RECONNECT REQUIRED" last_sync stamp, OR
//   • a connected flag with no access token ever obtained (half-connection), OR
//   • a missing refresh token.
// A normally-expired-but-refreshable location now reads connected /
// auto-refreshing, NOT reconnect_required (the false-alarm fix).
//
//   1. connected + expired access + healthy refresh → connected (auto-refresh)
//   2. last_sync_status "RECONNECT REQUIRED — …"     → reconnect_required
//   3. connected, no access token (Scottsdale)       → reconnect_required
//   4. connected, missing refresh token              → reconnect_required
//   5. never connected                               → disconnected
//   6. ONE shared helper feeds the card AND the admin view (re-exported from
//      @/components/BeeHub; the old bare-boolean ternary is gone).
// ─────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
// Imported from the CARD's module to prove the re-export contract the card
// relies on; the definition itself lives in lib/jobber-status.ts.
import { deriveJobberStatus, jobberStatusView } from '@/components/BeeHub'

const HOUR = 60 * 60 * 1000
const FUTURE = String(Date.now() + 24 * HOUR)
const PAST = String(Date.now() - HOUR)
const RECONNECT = 'RECONNECT REQUIRED — Jobber rejected refresh token (401) @ 2026-05-01T00:00:00'

describe('deriveJobberStatus — refined three-state derivation', () => {
  it('expired access token + healthy refresh → connected (NOT a false reconnect alarm)', () => {
    // The core fix: mere access-token expiry is not an error — it auto-renews.
    expect(deriveJobberStatus({ connected: true, tokenExpiry: PAST, lastSyncStatus: 'Token refreshed: ok' }))
      .toBe('connected')
    expect(deriveJobberStatus({ connected: true, tokenExpiry: PAST, lastSyncStatus: 'Token refreshed: ok', hasAccessToken: true, hasRefreshToken: true }))
      .toBe('connected')
    // numeric epoch-ms, expired → still connected
    expect(deriveJobberStatus({ connected: true, tokenExpiry: Date.now() - HOUR, lastSyncStatus: null }))
      .toBe('connected')
  })

  it('a fail-loud 401 "RECONNECT REQUIRED" stamp → reconnect_required (wins over a future expiry)', () => {
    expect(deriveJobberStatus({ connected: true, tokenExpiry: FUTURE, lastSyncStatus: RECONNECT }))
      .toBe('reconnect_required')
  })

  it('connected flag but NO access token obtained (half-connection) → reconnect_required', () => {
    expect(deriveJobberStatus({ connected: true, tokenExpiry: null, lastSyncStatus: 'Connected via Hub: 4/21/2026', hasAccessToken: false, hasRefreshToken: true }))
      .toBe('reconnect_required')
  })

  it('connected but MISSING refresh token → reconnect_required', () => {
    expect(deriveJobberStatus({ connected: true, tokenExpiry: FUTURE, lastSyncStatus: null, hasAccessToken: true, hasRefreshToken: false }))
      .toBe('reconnect_required')
  })

  it('connected + future expiry + clean sync → connected; unknown signals stay connected', () => {
    expect(deriveJobberStatus({ connected: true, tokenExpiry: FUTURE, lastSyncStatus: 'Token refreshed: ok' }))
      .toBe('connected')
    // Absence of a failure signal (unknown expiry, no presence booleans) is not
    // itself a failure.
    expect(deriveJobberStatus({ connected: true, tokenExpiry: null, lastSyncStatus: null }))
      .toBe('connected')
  })

  it('never connected → disconnected (regardless of stale token fields)', () => {
    expect(deriveJobberStatus({ connected: false, tokenExpiry: PAST, lastSyncStatus: RECONNECT }))
      .toBe('disconnected')
    expect(deriveJobberStatus({ connected: false, tokenExpiry: null, lastSyncStatus: null }))
      .toBe('disconnected')
  })
})

describe('jobberStatusView — the 4-way display label the card + admin view render', () => {
  it('valid access token → Connected (ok, not auto-refreshing)', () => {
    const v = jobberStatusView({ connected: true, tokenExpiry: FUTURE, lastSyncStatus: 'Token refreshed: ok', hasAccessToken: true, hasRefreshToken: true })
    expect(v).toMatchObject({ status: 'connected', label: 'Connected', tone: 'ok', autoRefreshing: false })
  })

  it('expired-but-refreshable access token → Auto-refreshing (info)', () => {
    const v = jobberStatusView({ connected: true, tokenExpiry: PAST, lastSyncStatus: 'Token refreshed: ok', hasAccessToken: true, hasRefreshToken: true })
    expect(v).toMatchObject({ status: 'connected', label: 'Auto-refreshing', tone: 'info', autoRefreshing: true })
  })

  it('401 stamp → Reconnect required (warn)', () => {
    const v = jobberStatusView({ connected: true, tokenExpiry: FUTURE, lastSyncStatus: RECONNECT })
    expect(v).toMatchObject({ status: 'reconnect_required', label: 'Reconnect required', tone: 'warn' })
  })

  it('half-connection (no access token) → Reconnect required', () => {
    const v = jobberStatusView({ connected: true, tokenExpiry: null, lastSyncStatus: null, hasAccessToken: false })
    expect(v).toMatchObject({ status: 'reconnect_required', label: 'Reconnect required' })
  })

  it('never connected → Never connected (muted)', () => {
    const v = jobberStatusView({ connected: false })
    expect(v).toMatchObject({ status: 'disconnected', label: 'Never connected', tone: 'muted' })
  })
})

describe('single-helper invariant — no drifting copies', () => {
  const src = readFileSync(new URL('../components/BeeHub.jsx', import.meta.url), 'utf8')
  const libSrc = readFileSync(new URL('./jobber-status.ts', import.meta.url), 'utf8')

  it('the canonical derivation is defined once, in the shared pure module', () => {
    expect(libSrc).toMatch(/export function deriveJobberStatus/)
    expect(libSrc).toMatch(/export function jobberStatusView/)
  })

  it('BeeHub imports the helper from the shared module (never redefines it)', () => {
    expect(src).toMatch(/import \{[^}]*deriveJobberStatus[^}]*\} from ["']@\/lib\/jobber-status["']/)
    expect(src).not.toMatch(/function deriveJobberStatus\s*\(/)
  })

  it('all three SettingsScreen jobberStatus sites still route through deriveJobberStatus', () => {
    const callSites = src.match(/deriveJobberStatus\(\{/g) || []
    expect(callSites.length).toBe(3)
  })

  it('the admin all-locations view derives status through the same shared helper', () => {
    const apiSrc = readFileSync(new URL('../app/api/admin/jobber-health/route.ts', import.meta.url), 'utf8')
    expect(apiSrc).toMatch(/from ["']@\/lib\/jobber-status["']/)
    expect(apiSrc).toMatch(/jobberStatusView\(/)
  })

  it('the old bare-boolean ternary is fully removed', () => {
    expect(src).not.toMatch(/jobber_connected\s*\?\s*'connected'\s*:\s*'disconnected'/)
    expect(src).not.toMatch(/jobberConnected\s*\?\s*'connected'\s*:\s*'disconnected'/)
  })

  it('the card renders a distinct reconnect_required state with a prominent action', () => {
    expect(src).toMatch(/reconnect_required:/)          // per-state presentation entry
    expect(src).toMatch(/Reconnect Jobber/)             // the prominent reconnect CTA
  })
})
