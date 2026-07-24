// @vitest-environment happy-dom
//
// HomeSystemHealth — Home, for an elevated user viewing 'All Locations'. The
// compact system-health summary that STANDS IN FOR the operational Home on
// that one scope. The pins here encode the deliberate calls in this build:
//
//   A) ONE VERDICT SOURCE. This reads the SAME /api/admin/system-health
//      endpoint as the Admin → System Health deep view and renders the SAME
//      server-computed verdict (data.verdict.level). The two cannot disagree
//      because neither recomputes it. Mounted here.
//
//   B) THE CLIENT-SIDE ROLE GATE (the view-as trap). The server session stays
//      super_admin under view-as, so a health panel would leak into an
//      impersonated owner's Home without a CLIENT-SIDE gate. The gate is
//      `isElevated && locFilter==='all'`, and `isElevated = isElevatedRole(role)`
//      reads the EFFECTIVE (impersonated) role — so an owner under view-as
//      (role flipped to 'franchise') reads false and gets the operational Home.
//      isElevatedRole is pinned by unit assertion; the branch + its byte-
//      identical operational-Home sibling are pinned by source match (the
//      DashboardScreen internal has no export to mount — the
//      beta-notification-log / beta-system-health posture).
//
//   C) TOKENS, NOT LITERALS. Like SystemHealthScreen, the panel carries no
//      color literal of its own — this file sweeps its source.
//
//   D) THE HONESTY RULE. Unknowns render as explicit gaps, never fake zeros.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import HomeSystemHealth from '@/components/hive/HomeSystemHealth'
import { isElevatedRole, viewAsIdentityFor } from '@/lib/view-as-identity'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const PANEL_SRC = readFileSync('components/hive/HomeSystemHealth.jsx', 'utf8')
const BEEHUB_SRC = readFileSync('components/BeeHub.jsx', 'utf8')

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const health = (over: any = {}) => ({
  generatedAt: '2026-07-24T12:00:00.000Z',
  window: '24h',
  verdict: { level: 'green', problems: [], cautions: [], attention: 0 },
  digest: { tracked: true, lastRunAt: '2026-07-24T10:00:00.000Z', suppressed: true, posted: false, allClear: true, stale: false },
  jobber: { total: 8, connected: 8, autoRefreshing: 2, reconnectRequired: 0, disconnected: 0, problems: [] },
  webhooks: { total: 142, failed: 0, notLanded: 0 },
  imports: { running: [], failed7d: 0, failed24h: 0, stalled: 0 },
  emails: { tracked: true, total: 37, failed: 0 },
  needsALook: [],
  activity: {
    leadsIn: 6, bySource: [{ label: 'Website', count: 4 }], byLocation: [{ label: 'Portland', count: 3 }],
    perDay: [], requests: 3, quotesSent: 2, jobsBooked: 1, invoicesPaid: 2, wonCount: 1, wonValue: 2450,
  },
  feedback: { open: 2, newest: [] },
  ...over,
})

// The panel makes ONE fetch — /api/admin/system-health?window=24h — and reads
// feedback straight off that payload (no second call, keeping it Home-sized).
const stubFetch = (body: any) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => body })))

beforeEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

// ── A) one verdict source ──────────────────────────────────────────
describe('one verdict source — same endpoint, same server verdict', () => {
  it('fetches /api/admin/system-health at the 24h window', async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => health() }))
    vi.stubGlobal('fetch', f)
    const { unmount } = await mount(<HomeSystemHealth />)
    expect(f.mock.calls.some(c => String(c[0]).includes('/api/admin/system-health'))).toBe(true)
    expect(f.mock.calls.some(c => String(c[0]).includes('window=24h'))).toBe(true)
    await unmount()
  })

  it('renders the server verdict LEVEL, never a recomputed one', async () => {
    stubFetch(health({ verdict: { level: 'green', problems: [], cautions: [], attention: 0 } }))
    const { host, unmount } = await mount(<HomeSystemHealth />)
    expect(host.textContent).toMatch(/System healthy/i)
    expect(host.textContent).toContain('Healthy')     // jobber tile
    expect(host.textContent).toContain('$2,450')      // won value from payload
    await unmount()
  })

  it('a red verdict reads "Needs attention" and names the broken thing', async () => {
    stubFetch(health({
      verdict: { level: 'red', problems: ['Portland needs a Jobber reconnect'], cautions: [], attention: 0 },
      jobber: { total: 8, connected: 7, autoRefreshing: 1, reconnectRequired: 1, disconnected: 0,
                problems: [{ name: 'Portland', status: 'reconnect_required', label: 'Reconnect required' }] },
    }))
    const { host, unmount } = await mount(<HomeSystemHealth />)
    expect(host.textContent).toMatch(/Needs attention/i)
    expect(host.textContent).toContain('Portland needs a Jobber reconnect')
    await unmount()
  })

  it('the digest heartbeat rides the banner subline (stale-cron detector)', async () => {
    stubFetch(health({
      verdict: { level: 'amber', problems: [], cautions: [], attention: 0 },
      digest: { tracked: true, lastRunAt: '2026-07-23T22:00:00.000Z', suppressed: true, posted: false, allClear: true, stale: true },
    }))
    const { host, unmount } = await mount(<HomeSystemHealth />)
    expect(host.textContent).toMatch(/stale cron/i)
    await unmount()
  })
})

// ── B) the client-side role gate (the view-as trap) ────────────────
describe('client-side role gate — view-as cannot leak the panel', () => {
  it('isElevatedRole is true only for super_admin + corporate', () => {
    expect(isElevatedRole('super_admin')).toBe(true)
    expect(isElevatedRole('corporate')).toBe(true)
    expect(isElevatedRole('franchise')).toBe(false)
    expect(isElevatedRole('admin')).toBe(false)
    expect(isElevatedRole(null)).toBe(false)
  })

  it('view-as as an owner flips role to franchise → isElevated=false', () => {
    // The exact identity the picker lands on for an owner: viewAsIdentityFor
    // returns role:'franchise', which drives isElevated=false client-side even
    // though the server session is still super_admin.
    const owner = { id: 'u1', role: 'owner', locationId: 'loc_pdx' }
    const next = viewAsIdentityFor(owner)
    expect(next.role).toBe('franchise')
    expect(isElevatedRole(next.role)).toBe(false)
  })

  it('view-as as a corporate user stays elevated on all (its own health scope)', () => {
    const corp = { id: 'u2', role: 'corporate' }
    const next = viewAsIdentityFor(corp)
    expect(next.role).toBe('corporate')
    expect(next.locFilter).toBe('all')
    expect(isElevatedRole(next.role)).toBe(true)
  })

  it("DashboardScreen gates the health branch on `isElevated && locFilter==='all'` and mounts HomeSystemHealth", () => {
    expect(BEEHUB_SRC).toMatch(/if \(isElevated && locFilter==='all'\) return \(/)
    expect(BEEHUB_SRC).toMatch(/if \(isElevated && locFilter==='all'\) return \([\s\S]{0,2400}?<HomeSystemHealth/)
  })

  it('isElevated is derived from the EFFECTIVE role (isElevatedRole(role)), which view-as flips', () => {
    expect(BEEHUB_SRC).toMatch(/const isElevated\s+= isElevatedRole\(role\)/)
  })

  it('the operational Home return still exists below the branch (byte-identical sibling)', () => {
    // The health branch is a NEW return; the operational Home is unchanged and
    // still reached by scoped / non-elevated users. Its signature markers survive.
    expect(BEEHUB_SRC).toContain('<HomeGreeting ownerName={ownerName} ownerEmail={ownerEmail} />')
    expect(BEEHUB_SRC).toContain('Needs attention')
    expect(BEEHUB_SRC).toMatch(/<HomeMetricTile label="Open engagements"/)
  })

  it('the "View full system health" link deep-links to Admin → System Health', () => {
    expect(BEEHUB_SRC).toMatch(/onOpenSystemHealth=\{\(\)=>\{[\s\S]{0,500}?setAdminDeepLinkSection\('health'\)[\s\S]{0,120}?nav\('admin'\)/)
  })
})

// ── C) tokens, not literals ────────────────────────────────────────
describe('token sweep — the panel carries no color literal of its own', () => {
  const HEX = /#[0-9a-fA-F]{3,8}\b/
  const RGBA = /rgba?\(/
  it('no hex/rgba literal anywhere in the panel (comments included)', () => {
    expect(HEX.test(PANEL_SRC)).toBe(false)
    expect(RGBA.test(PANEL_SRC)).toBe(false)
  })
  it('resolves color through the token objects, never a raw value', () => {
    expect(PANEL_SRC).toMatch(/from '@\/components\/hive\/shared\/tokens'/)
    expect(PANEL_SRC).toMatch(/T\.(state|family)\./)
  })
})

// ── D) honesty rule + the compact sections ─────────────────────────
describe('HomeSystemHealth panel', () => {
  it('untracked email counts read "Not tracked yet", not a fake zero', async () => {
    stubFetch(health({ emails: { tracked: false, total: null, failed: null } }))
    const { host, unmount } = await mount(<HomeSystemHealth />)
    expect(host.textContent).toMatch(/Not tracked yet/i)
    await unmount()
  })

  it('an untracked digest admits the gap instead of implying a run', async () => {
    stubFetch(health({ digest: { tracked: false, lastRunAt: null, suppressed: null, posted: null, allClear: null, stale: false } }))
    const { host, unmount } = await mount(<HomeSystemHealth />)
    expect(host.textContent).toMatch(/isn’t wired yet/i)
    await unmount()
  })

  it('needs-a-look rows render (max 3) and tap through', async () => {
    const onOpenFull = vi.fn()
    stubFetch(health({ needsALook: [
      { key: 'unrouted', label: '4 unrouted leads waiting at Corporate' },
      { key: 'rate', label: 'Boise — emails held: no rate set' },
      { key: 'quiet', label: 'Reno — no new leads in the last 7 days' },
      { key: 'invites', label: '2 expired invites still counting against seats' },
    ] }))
    const { host, unmount } = await mount(<HomeSystemHealth onOpenFull={onOpenFull} />)
    expect(host.textContent).toContain('4 unrouted leads waiting at Corporate')
    // Only three rows shown; the fourth folds into a "1 more" affordance.
    expect(host.textContent).toContain('1 more')
    const row = Array.from(host.querySelectorAll('button')).find(b => /unrouted leads/i.test(b.textContent || ''))
    expect(row).toBeTruthy()
    await act(async () => { row!.dispatchEvent(new Event('click', { bubbles: true })) })
    expect(onOpenFull).toHaveBeenCalled()
    await unmount()
  })

  it('empty look-list reads "Nothing needs a look"', async () => {
    stubFetch(health({ needsALook: [] }))
    const { host, unmount } = await mount(<HomeSystemHealth />)
    expect(host.textContent).toMatch(/Nothing needs a look/i)
    await unmount()
  })

  it('surfaces quiet locations as the absence signal in the 24h section', async () => {
    stubFetch(health({ needsALook: [
      { key: 'quiet', label: 'Reno — no new leads in the last 7 days' },
      { key: 'quiet', label: 'Tulsa — no new leads in the last 7 days' },
    ] }))
    const { host, unmount } = await mount(<HomeSystemHealth />)
    expect(host.textContent).toMatch(/2 locations quiet/i)
    await unmount()
  })

  it('surfaces open feedback from the same payload (no second fetch)', async () => {
    stubFetch(health({ feedback: { open: 1, newest: [
      { id: 'f1', type: 'bug', title: 'CSV export cuts off', createdAt: '2026-07-24T11:00:00.000Z', locationName: 'Portland' },
    ] } }))
    const { host, unmount } = await mount(<HomeSystemHealth />)
    expect(host.textContent).toContain('CSV export cuts off')
    await unmount()
  })

  it('the deep-view link calls onOpenFull', async () => {
    const onOpenFull = vi.fn()
    stubFetch(health())
    const { host, unmount } = await mount(<HomeSystemHealth onOpenFull={onOpenFull} />)
    const link = Array.from(host.querySelectorAll('button')).find(b => /View full system health/i.test(b.textContent || ''))
    expect(link).toBeTruthy()
    await act(async () => { link!.dispatchEvent(new Event('click', { bubbles: true })) })
    expect(onOpenFull).toHaveBeenCalled()
    await unmount()
  })
})
