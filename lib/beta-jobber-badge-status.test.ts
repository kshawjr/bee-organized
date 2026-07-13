// lib/beta-jobber-badge-status.test.ts
// ─────────────────────────────────────────────────────────────
// Pins the Jobber "Connected" badge to ACTUAL token validity, not the bare
// jobber_connected boolean (which only flips at OAuth callback / manual
// Disconnect and hid a 2-month dead-token bug — Kansas City showed
// "✅ Connected" over a "RECONNECT REQUIRED" last_sync_status).
//
//   1. expired token_expiry (+ connected)          → reconnect_required
//   2. last_sync_status "RECONNECT REQUIRED — …"    → reconnect_required
//   3. connected + future token_expiry + clean sync → connected
//   4. never connected                              → disconnected
//   5. all three SettingsScreen derivation sites call the shared helper —
//      the old `jobber_connected ? 'connected' : 'disconnected'` ternary is
//      gone (this is the "3 copies of a derivation drift" pattern).
// ─────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { deriveJobberStatus } from '@/components/BeeHub'

const HOUR = 60 * 60 * 1000
const FUTURE = String(Date.now() + 24 * HOUR)
const PAST = String(Date.now() - HOUR)
const RECONNECT = 'RECONNECT REQUIRED — Jobber rejected refresh token (401) @ 2026-05-01T00:00:00'

describe('deriveJobberStatus — three-state token-aware badge', () => {
  it('expired token_expiry on a connected location → reconnect_required', () => {
    expect(deriveJobberStatus({ connected: true, tokenExpiry: PAST, lastSyncStatus: 'Token refreshed: ok' }))
      .toBe('reconnect_required')
  })

  it('last_sync_status starting with "RECONNECT REQUIRED" → reconnect_required', () => {
    // Even with a future expiry, the fail-loud 401 stamp wins.
    expect(deriveJobberStatus({ connected: true, tokenExpiry: FUTURE, lastSyncStatus: RECONNECT }))
      .toBe('reconnect_required')
  })

  it('connected + future token_expiry + clean sync → connected', () => {
    expect(deriveJobberStatus({ connected: true, tokenExpiry: FUTURE, lastSyncStatus: 'Token refreshed: ok' }))
      .toBe('connected')
    // Missing signals (unknown expiry, no sync stamp) still read connected —
    // absence of a failure signal is not itself a failure.
    expect(deriveJobberStatus({ connected: true, tokenExpiry: null, lastSyncStatus: null }))
      .toBe('connected')
  })

  it('never connected → disconnected (regardless of stale token fields)', () => {
    expect(deriveJobberStatus({ connected: false, tokenExpiry: PAST, lastSyncStatus: RECONNECT }))
      .toBe('disconnected')
    expect(deriveJobberStatus({ connected: false, tokenExpiry: null, lastSyncStatus: null }))
      .toBe('disconnected')
  })

  it('accepts numeric epoch-ms expiry as well as string', () => {
    expect(deriveJobberStatus({ connected: true, tokenExpiry: Date.now() - HOUR, lastSyncStatus: null }))
      .toBe('reconnect_required')
    expect(deriveJobberStatus({ connected: true, tokenExpiry: Date.now() + HOUR, lastSyncStatus: null }))
      .toBe('connected')
  })
})

describe('single-helper invariant — no drifting copies', () => {
  const src = readFileSync(new URL('../components/BeeHub.jsx', import.meta.url), 'utf8')

  it('all three SettingsScreen jobberStatus sites route through deriveJobberStatus', () => {
    // 1 definition + 3 call sites = 4 occurrences of the identifier.
    const occurrences = src.match(/deriveJobberStatus\s*\(/g) || []
    expect(occurrences.length).toBe(4)
  })

  it('the old bare-boolean ternary is fully removed', () => {
    expect(src).not.toMatch(/jobber_connected\s*\?\s*'connected'\s*:\s*'disconnected'/)
    expect(src).not.toMatch(/jobberConnected\s*\?\s*'connected'\s*:\s*'disconnected'/)
  })

  it('the card renders a distinct reconnect_required state', () => {
    expect(src).toMatch(/reconnect_required:/)          // statusConf entry
    expect(src).toMatch(/Reconnect required/)           // pill label
  })
})
