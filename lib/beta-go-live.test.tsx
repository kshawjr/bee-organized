// @vitest-environment happy-dom
// GO-LIVE flip (2026-07-09): beta hive is the default for everyone.
//
// Three coordinated changes, all pinned here:
//   1. canSeeBetaBoard(role) → true for ALL roles (was 'super_admin').
//      Rollback = restore the role check; the function stays the single
//      flip point.
//   2. Landing view = 'engagements' (beta) when the gate is open, via
//      defaultHiveView — SSR and client agree (derived from role).
//   3. Stored Classic bee_hive_view ('list'/'kanban') no longer wins the
//      initial landing — ignore-on-hydrate via hydrateHiveView. The key
//      is NOT cleared/migrated, so rollback restores old behavior as-is.
//
// Must survive the flip:
//   - "Back to classic" escape hatch renders (desktop + mobile) and fires
//     onExitBeta — Classic stays reachable in-session (recycle bin,
//     mass-update, saved views, quick captures, drip activation).
//   - Reversibility self-heal: with the gate CLOSED, a stored
//     'engagements' is ignored and the default is 'list' — a beta-stranded
//     browser bounces back to Classic on next load; stored Classic views
//     still restore under a closed gate.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import HiveShell from '@/components/hive/HiveShell'
import { canSeeBetaBoard, defaultHiveView, hydrateHiveView } from '@/components/hive/shared/betaGate'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
const ENGAGEMENTS = [{
  id: 'e-1', client_id: 'c1', client_name: 'Pat Tester', location_uuid: 'loc-uuid-1',
  title: 'Garage organization', stage: 'Request', created_at: daysAgo(3),
  stage_entered_at: daysAgo(3), nurture_started_at: null,
  total_invoiced: 0, total_paid: 0, balance_owing: 0, repeat_count: 1,
  quotes: [], jobs: [], invoices: [],
}]
const PEOPLE = [{
  id: 'p-1', name: 'Ida Fixture', email: 'ida@x.com', phone: '555',
  locationId: 'loc-uuid-1', created: daysAgo(3), paidAmount: 0, paused: false,
  jobberRef: null, source: 'webform', outreachTimeline: [],
}]

const setWidth = (w: number | undefined) => { (globalThis as any).__BEE_TEST_WIDTH__ = w }
afterEach(() => { setWidth(undefined); try { localStorage.clear() } catch {} })

describe('gate: canSeeBetaBoard is open for every role', () => {
  it('returns true for all mapRole values (and even unknown/missing roles)', () => {
    for (const role of ['super_admin', 'corporate', 'franchise', 'lite_user', 'admin', 'owner', undefined]) {
      expect(canSeeBetaBoard(role)).toBe(true)
    }
  })
})

describe('landing view: beta by default, stored Classic no longer wins', () => {
  it('fresh user (no stored preference) lands on beta', () => {
    expect(defaultHiveView(true)).toBe('engagements')
    expect(hydrateHiveView(true, null)).toBe(null) // keep the default
  })

  it('stored Classic views are ignored on hydrate when the gate is open', () => {
    expect(hydrateHiveView(true, 'list')).toBe(null)
    expect(hydrateHiveView(true, 'kanban')).toBe(null)
    expect(hydrateHiveView(true, 'engagements')).toBe(null) // already the default
  })

  it('BeeHub actually binds view state to these helpers (not a stale copy)', () => {
    const src = readFileSync('components/BeeHub.jsx', 'utf8')
    expect(src).toContain("useState(defaultHiveView(newBoardAllowed))")
    expect(src).toContain("hydrateHiveView(newBoardAllowed, localStorage.getItem('bee_hive_view'))")
    // In-session escape hatch still writes the Classic preference.
    expect(src).toContain("onExitBeta={()=>{ setView('kanban')")
  })
})

describe('reversibility self-heal (gate closed = rollback posture)', () => {
  it('a beta-stranded browser (stored engagements) bounces back to Classic', () => {
    expect(defaultHiveView(false)).toBe('list')
    expect(hydrateHiveView(false, 'engagements')).toBe(null) // default 'list' holds
  })

  it('stored Classic views still restore under a closed gate', () => {
    expect(hydrateHiveView(false, 'kanban')).toBe('kanban')
    expect(hydrateHiveView(false, 'list')).toBe('list')
  })
})

describe('"Back to classic" escape hatch survives the flip', () => {
  it('renders on desktop and mobile shell chrome', () => {
    setWidth(1280)
    expect(renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />)).toContain('Back to classic')
    setWidth(390)
    expect(renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />)).toContain('Back to classic')
  })

  it('clicking it fires onExitBeta (in-session switch to Classic)', async () => {
    ;(globalThis as any).fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ lookups: [] }) }))
    const onExitBeta = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} onExitBeta={onExitBeta} />)
    })
    const btn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Back to classic')
    expect(btn).toBeTruthy()
    await act(async () => { btn!.click() })
    expect(onExitBeta).toHaveBeenCalledTimes(1)
    await act(async () => { root.unmount() })
    host.remove()
  })
})
