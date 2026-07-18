// @vitest-environment happy-dom
// CLASSIC RETIRED (2026-07-18) — access removed, code retained (reversible).
//
// Kevin's decision: hide ALL access to the Classic Clients view; everything
// opens the new Hive view; status beta→live. The Classic components stay in the
// tree (unreachable, NOT deleted) so the change is a one-line revert.
//
// The dead-end-prevention core: there must be NO way — via any control,
// default, fallback, deep link, or saved preference — to land on a Classic
// surface. Two coordinated changes make that structurally true:
//   1. HiveShell no longer renders the "Back to classic" escape hatch (the
//      sole visible entry into Classic). exitEl + onExitBeta are retained,
//      unrendered, for reversibility.
//   2. BeeHub's HiveScreen renders the new Hive view whenever the beta gate is
//      open (`if (newBoardAllowed)`), NOT gated on `view==='engagements'`. So
//      no value of `view` — including a stale/hydrated Classic pref — can reach
//      the Classic list/kanban board or the Classic PersonPanel below it.
//
// beta→live is label-only: the only "(beta)" wording was the "New board (beta)"
// toggle, which lived inside the (now unreachable) Classic block. The live Hive
// chrome carries no beta badge, and no functionality is gated on a beta flag
// beyond canSeeBetaBoard (already open) — verified unchanged here.
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToString } from 'react-dom/server'
import HiveShell from '@/components/hive/HiveShell'
import { canSeeBetaBoard, defaultHiveView, hydrateHiveView, resolveBetaReadOnly } from '@/components/hive/shared/betaGate'

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

const BEEHUB = readFileSync('components/BeeHub.jsx', 'utf8')
const HIVESHELL = readFileSync('components/hive/HiveShell.jsx', 'utf8')

describe('no Classic control renders on the Clients view', () => {
  it('HiveShell renders no "Back to classic" hatch (desktop or mobile)', () => {
    setWidth(1280)
    expect(renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />)).not.toContain('Back to classic')
    setWidth(390)
    expect(renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />)).not.toContain('Back to classic')
  })

  it('the exitEl definition + onExitBeta prop are retained for a one-line revert', () => {
    // Removal is verified by render (no "Back to classic" above); here we pin
    // that the element and its prop stay in the source so restoring Classic
    // access is a one-line revert, not a rebuild.
    expect(HIVESHELL).toContain('const exitEl = (')
    expect(HIVESHELL).toContain('onExitBeta')
  })
})

describe('the Classic board is structurally unreachable', () => {
  it('the new Hive view renders whenever the gate is open, not gated on view state', () => {
    expect(BEEHUB).toContain('if (newBoardAllowed) {')
    expect(BEEHUB).not.toContain("if (view==='engagements' && newBoardAllowed) {")
  })

  it('the HiveShell return short-circuits BEFORE any Classic control', () => {
    const guardIdx = BEEHUB.indexOf('if (newBoardAllowed) {')
    const classicToggleIdx = BEEHUB.indexOf("['list','kanban'].map")
    const personPanelIdx = BEEHUB.indexOf('<PersonPanel person={selected}')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(classicToggleIdx).toBeGreaterThan(-1)   // Classic code retained…
    expect(personPanelIdx).toBeGreaterThan(-1)     // …not deleted.
    // …but only reachable after the guard already returned the new view.
    expect(guardIdx).toBeLessThan(classicToggleIdx)
    expect(guardIdx).toBeLessThan(personPanelIdx)
  })

  it('the gate is open for every role, so that guard always wins', () => {
    for (const role of ['super_admin', 'corporate', 'franchise', 'lite_user', 'admin', 'owner', undefined]) {
      expect(canSeeBetaBoard(role)).toBe(true)
    }
  })
})

describe('saved Classic preference resolves to the new view (the sneaky dead-end)', () => {
  it('a browser stored on list/kanban lands on the new Hive view', () => {
    // Landing view = default (engagements) because hydrate ignores stored
    // Classic values while the gate is open. Net: engagements, every time.
    expect(defaultHiveView(true)).toBe('engagements')
    expect(hydrateHiveView(true, 'kanban')).toBe(null)
    expect(hydrateHiveView(true, 'list')).toBe(null)
    // And even if `view` were somehow forced to a Classic value, the render
    // guard (previous describe) ignores `view` entirely.
  })
})

describe('deep link /clients/[id] renders the new view, never the Classic panel', () => {
  it('the reachable (new-view) return drives the deep link via urlClientId', () => {
    // The new Hive view's ClientProfile overlay is seeded from urlClientId, and
    // this return is the one that always fires (gate open). The Classic
    // PersonPanel is only in the unreachable block below it.
    const guardIdx = BEEHUB.indexOf('if (newBoardAllowed) {')
    const urlClientIdx = BEEHUB.indexOf('urlClientId={selected?.id || null}')
    const personPanelIdx = BEEHUB.indexOf('<PersonPanel person={selected}')
    expect(urlClientIdx).toBeGreaterThan(guardIdx)          // inside the new-view return
    expect(urlClientIdx).toBeLessThan(personPanelIdx)       // before the Classic panel
  })
})

describe('beta→live is label-only (behavior unchanged)', () => {
  it('the live Hive chrome carries no "(beta)" badge', () => {
    setWidth(1280)
    expect(renderToString(<HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} />)).not.toContain('(beta)')
  })

  it('read-only policy is untouched — still role/crmStatus driven, not beta-gated', () => {
    // Elevated roles always write.
    expect(resolveBetaReadOnly({ role: 'super_admin', franchiseRole: 'owner', crmStatus: 'active' })).toBe(false)
    expect(resolveBetaReadOnly({ role: 'corporate', franchiseRole: 'owner', crmStatus: 'inactive' })).toBe(false)
    // Viewer/lite is read-only.
    expect(resolveBetaReadOnly({ role: 'franchise', franchiseRole: 'viewer', crmStatus: 'active' })).toBe(true)
    // Paused location locks; grace-period past_due keeps writing.
    expect(resolveBetaReadOnly({ role: 'franchise', franchiseRole: 'owner', crmStatus: 'inactive' })).toBe(true)
    expect(resolveBetaReadOnly({ role: 'franchise', franchiseRole: 'owner', crmStatus: 'pastdue' })).toBe(false)
  })
})
