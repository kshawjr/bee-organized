// @vitest-environment happy-dom
// lib/beta-jobber-card-token-health.test.tsx
// ─────────────────────────────────────────────────────────────
// Builds on the truthful-badge fix (deriveJobberStatus, cc9d0ad):
//   GOAL A — the connection card surfaces token-health *evidence* when
//            connected (last sync/refresh + token validity horizon), so a
//            connection is verifiable at a glance and can't hide behind a bare
//            green pill the way the 2-month token-death bug did. The
//            reconnect_required state still shows amber.
//   GOAL B — once a location has completed its first import, the prominent
//            "Start Import" CTA never returns; a compact, low-emphasis
//            "Re-sync from Jobber" catch-up takes its place (reconnection can
//            follow a webhook-missing disconnection gap). A not-yet-imported
//            location still shows the prominent CTA.
//
// The re-sync reuses the EXISTING import mechanism, which is idempotent —
// upsertLead / upsertServiceRequest select-then-update on the jobber_*_id keys
// and quotes·jobs·invoices use onConflict upserts — so a re-run updates in
// place and never duplicates. (Verified in lib/jobber-import.ts, not assumed.)
// ─────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ClientImportCard calls useRouter().refresh() on completion; outside a Next
// app-router tree the real hook throws at render.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

import { jobberTokenHealth, ClientImportCard, JobberCard } from '@/components/BeeHub'

const HOUR = 60 * 60 * 1000

// ── fetch mock (ClientImportCard mount effect hits /api/import/active) ──
const fetchMock = vi.fn()
const jsonRes = (body: any, ok = true, status = 200) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: any) =>
    String(url).includes('/api/import/active')
      ? jsonRes({ job: null, client_count: 430 })
      : jsonRes({ error: 'unmocked_route' }, false, 404))
  ;(globalThis as any).fetch = fetchMock
})

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => {}) // flush mount effect's async fetch → setState
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const buttonByText = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => b.textContent?.trim().includes(text))

// ─────────────────────────────────────────────────────────────
// GOAL A — token-health formatting (pure helper)
// ─────────────────────────────────────────────────────────────
describe('jobberTokenHealth — connection evidence line', () => {
  it('connected: parses a refresh stamp + future expiry into synced + valid-through', () => {
    const refreshedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString().slice(0, 19)
    const { syncedLabel, validityLabel } = jobberTokenHealth({
      lastSyncStatus: `Token refreshed: ${refreshedAt}`,
      tokenExpiry: String(Date.now() + HOUR),
    })
    expect(syncedLabel).toMatch(/^Last synced /)
    // Short-lived access token: pair the horizon with the auto-refresh
    // reassurance so an hour-out time doesn't read as alarming.
    expect(validityLabel).toMatch(/^token valid through /)
    expect(validityLabel).toContain('auto-refreshes')
  })

  it('parses the OAuth-callback "Connected via Hub:" locale stamp', () => {
    const { syncedLabel } = jobberTokenHealth({
      lastSyncStatus: `Connected via Hub: ${new Date().toLocaleString()}`,
      tokenExpiry: null,
    })
    expect(syncedLabel).toMatch(/^Last synced /)
  })

  it('past expiry → "token expired", never a false "valid through"', () => {
    const { validityLabel } = jobberTokenHealth({
      lastSyncStatus: null,
      tokenExpiry: String(Date.now() - HOUR),
    })
    expect(validityLabel).toMatch(/^token expired /)
    expect(validityLabel).not.toContain('valid through')
  })

  it('pulls the last-sync time out of a RECONNECT REQUIRED 401 stamp (@ <iso>)', () => {
    const { syncedLabel } = jobberTokenHealth({
      lastSyncStatus: 'RECONNECT REQUIRED — Jobber rejected refresh token (401) @ 2026-05-01T00:00:00',
      tokenExpiry: null,
    })
    expect(syncedLabel).toMatch(/^Last synced /)
  })

  it('absent signals render nothing (absence is never guessed)', () => {
    expect(jobberTokenHealth({ lastSyncStatus: null, tokenExpiry: null }))
      .toEqual({ syncedLabel: null, validityLabel: null })
    expect(jobberTokenHealth({})).toEqual({ syncedLabel: null, validityLabel: null })
  })
})

// ─────────────────────────────────────────────────────────────
// GOAL A — the card renders the evidence when connected, amber when stale
// ─────────────────────────────────────────────────────────────
const settingsFor = (over: Record<string, any>) => ({
  location: {
    locId: 'loc-1',
    jobberAccountName: 'Bee Organized KC',
    ...over,
  },
})

// The UNIFIED card (connection + import in one) is state-driven and plain-
// language for a non-technical audience (professional organizers, 45–65, limited
// tech): one unmistakable status + one clear next step per state, NO token/expiry
// jargon, and no alarming buttons on a healthy card. The technical detail
// (expiry, auto-refresh) lives in the super_admin Jobber Health view instead.
describe('JobberCard — unified connection + import, plain-language & state-driven', () => {
  it('connected + already imported: calm "up to date" status, no CTA, no jargon', async () => {
    const { host, unmount } = await mount(
      <JobberCard
        settings={settingsFor({
          jobberStatus: 'connected',
          jobberAccountName: 'Bee Organized NWA',
          jobberInitialImportCompletedAt: '2026-07-09T12:00:00Z',
        })}
        updateLocation={() => {}}
      />,
    )
    expect(host.textContent).toContain('Connected & syncing')
    expect(host.textContent).toContain('Jobber is connected')
    expect(host.textContent).toContain('up to date automatically')
    expect(host.textContent).toContain('Bee Organized NWA')
    // Nothing to do: no import CTA, and no token/expiry jargon.
    expect(host.textContent).not.toContain('Bring in my clients')
    expect(host.textContent).not.toContain('Start Import')
    expect(host.textContent).not.toMatch(/token|expire|auto-refresh/i)
    expect(host.textContent).toContain('Manage connection')
    await unmount()
  })

  it('connected + NOT yet imported: one healthy call-to-action — bring in clients', async () => {
    const { host, unmount } = await mount(
      <JobberCard
        settings={settingsFor({
          jobberStatus: 'connected',
          jobberAccountName: 'Bee Organized NWA',
          jobberInitialImportCompletedAt: null,
        })}
        updateLocation={() => {}}
      />,
    )
    expect(host.textContent).toContain('Connected & syncing')
    expect(host.textContent).toContain('Next step')
    expect(buttonByText(host, 'Bring in my clients')).toBeTruthy()
    expect(host.textContent).not.toContain('Reconnect Jobber')
    await unmount()
  })

  it('connected: Manage expander hides switch / re-sync / disconnect until opened', async () => {
    const { host, unmount } = await mount(
      <JobberCard
        settings={settingsFor({ jobberStatus: 'connected', jobberAccountName: 'Bee Organized NWA', jobberInitialImportCompletedAt: '2026-07-09T12:00:00Z' })}
        updateLocation={() => {}}
      />,
    )
    expect(host.textContent).not.toContain('Disconnect')
    expect(host.textContent).not.toContain('Re-sync from Jobber')
    const manage = buttonByText(host, 'Manage connection')!
    await act(async () => { manage.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(host.textContent).toContain('Reconnect to a different account')
    expect(host.textContent).toContain('Re-sync from Jobber')
    expect(host.textContent).toContain('Disconnect')
    await unmount()
  })

  it('reconnect_required: amber Action needed + one Reconnect button, never offers import, no jargon', async () => {
    const { host, unmount } = await mount(
      <JobberCard
        settings={settingsFor({
          jobberStatus: 'reconnect_required',
          jobberInitialImportCompletedAt: '2026-07-09T12:00:00Z',
          jobberLastSyncStatus: 'RECONNECT REQUIRED — Jobber rejected refresh token (401) @ 2026-05-01T00:00:00',
        })}
        updateLocation={() => {}}
      />,
    )
    expect(host.textContent).toContain('Action needed')
    expect(host.textContent).toContain('Reconnect Jobber')
    expect(host.textContent).toContain('30 seconds')
    expect(host.textContent).toContain('none of your existing information is lost')
    // A dead connection never offers import, and never shows raw token vocab.
    expect(host.textContent).not.toContain('Bring in my clients')
    expect(host.textContent).not.toContain('Manage connection')
    expect(host.textContent).not.toMatch(/token|401|expire/i)
    await unmount()
  })

  it('disconnected: a single clear Connect action, no status strip', async () => {
    const { host, unmount } = await mount(
      <JobberCard
        settings={settingsFor({ jobberStatus: 'disconnected', jobberAccountName: '' })}
        updateLocation={() => {}}
      />,
    )
    expect(host.textContent).toContain('Connect Jobber')
    expect(host.textContent).not.toContain('Connected & syncing')
    expect(host.textContent).not.toContain('Action needed')
    expect(host.textContent).not.toContain('Bring in my clients')
    await unmount()
  })
})

// ─────────────────────────────────────────────────────────────
// GOAL B — import CTA gates on "has imported before"
// ─────────────────────────────────────────────────────────────
describe('ClientImportCard — import vs. re-sync gate', () => {
  it('already imported → quiet "Re-sync from Jobber", NOT the prominent Start Import', async () => {
    const { host, unmount } = await mount(
      <ClientImportCard
        isJobberConnected
        locationId="loc-1"
        initialImportCompletedAt={'2026-07-09T12:00:00Z' as any}
      />,
    )
    expect(buttonByText(host, 'Re-sync from Jobber')).toBeTruthy()
    expect(buttonByText(host, 'Start Import')).toBeFalsy()
    expect(host.textContent).toContain('Initial import completed')
    expect(host.textContent).toContain('Re-sync only if records may have been missed')
    await unmount()
  })

  it('not yet imported → the prominent Start Import CTA, no re-sync link', async () => {
    const { host, unmount } = await mount(
      <ClientImportCard
        isJobberConnected
        locationId="loc-1"
        initialImportCompletedAt={null as any}
      />,
    )
    expect(buttonByText(host, 'Start Import')).toBeTruthy()
    expect(buttonByText(host, 'Re-sync from Jobber')).toBeFalsy()
    await unmount()
  })

  it('disconnected → the card renders nothing at all (unchanged)', async () => {
    const { host, unmount } = await mount(
      <ClientImportCard
        isJobberConnected={false}
        locationId="loc-1"
        initialImportCompletedAt={'2026-07-09T12:00:00Z' as any}
      />,
    )
    expect(host.textContent).toBe('')
    await unmount()
  })
})
