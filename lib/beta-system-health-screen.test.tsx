// @vitest-environment happy-dom
//
// SystemHealthScreen — the Admin → System Health summary's read surface.
//
// The pins here encode the DELIBERATE calls in this build:
//
//   A) TOKENS, NOT LITERALS. Like AdminNotificationsScreen, this screen is
//      built entirely on tokens + shared primitives with NO color literal of
//      its own — this file sweeps the source so a "match the neighbour" paste
//      can't reintroduce hex.
//
//   B) ONE ELEVATED GATE, ALL THREE PLACES. The nav item (SuperAdminLayout),
//      the deep-link, and the API route all gate on super_admin + admin/
//      corporate — the same rule Feedback uses. Pinned here.
//
//   C) THE HONESTY RULE. A health screen never shows a fabricated figure:
//      the two known day-one gaps (digest heartbeat, email counts) render as
//      explicit "not wired / not tracked yet" states, not fake zeros.
//
// SuperAdminLayout is a BeeHub.jsx internal with no export to mount, so its
// gate + mount are pinned by SOURCE MATCH (the beta-notification-log posture).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import SystemHealthScreen from '@/components/admin/SystemHealthScreen'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SCREEN_SRC = readFileSync('components/admin/SystemHealthScreen.jsx', 'utf8')
const ROUTE_SRC = readFileSync('app/api/admin/system-health/route.ts', 'utf8')
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
    perDay: [{ day: '2026-07-18', count: 2 }, { day: '2026-07-19', count: 1 }, { day: '2026-07-20', count: 3 },
             { day: '2026-07-21', count: 0 }, { day: '2026-07-22', count: 4 }, { day: '2026-07-23', count: 2 },
             { day: '2026-07-24', count: 6 }],
    requests: 3, quotesSent: 2, jobsBooked: 1, invoicesPaid: 2, wonCount: 1, wonValue: 2450,
  },
  feedback: { open: 2, newest: [] },
  ...over,
})

const feedbackList = (items: any[] = []) => ({ items })

// Route fetch by URL: the screen calls /api/admin/system-health AND
// /api/admin/feedback on mount.
const stubFetch = (healthBody: any, fbBody: any = feedbackList()) =>
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (String(url).includes('/system-health') ? healthBody : fbBody),
  })))

beforeEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

// ── A) tokens, not literals ────────────────────────────────────────
describe('token sweep — the screen carries no color literal of its own', () => {
  const HEX = /#[0-9a-fA-F]{3,8}\b/
  const RGBA = /rgba?\(/

  it('no hex/rgba literal anywhere in the screen (comments included)', () => {
    expect(HEX.test(SCREEN_SRC)).toBe(false)
    expect(RGBA.test(SCREEN_SRC)).toBe(false)
  })

  it('composes the SHARED primitives rather than re-rolling them', () => {
    expect(SCREEN_SRC).toContain("from '@/components/ui/FilterChips'")
    expect(SCREEN_SRC).toContain("from '@/components/ui/StatusChip'")
    expect(SCREEN_SRC).toMatch(/from '@\/components\/hive\/shared\/tokens'/)
  })

  it('resolves color through the token objects, never a raw value', () => {
    expect(SCREEN_SRC).toMatch(/T\.ink\./)
    expect(SCREEN_SRC).toMatch(/T\.(state|family)\./)
  })
})

// ── B) one elevated gate, all the places ───────────────────────────
describe('role gate — elevated (super_admin + admin/corporate)', () => {
  it('the API route gates on ELEVATED_ROLES', () => {
    expect(ROUTE_SRC).toContain("const ELEVATED_ROLES = ['super_admin', 'admin']")
    expect(ROUTE_SRC).toMatch(/!ELEVATED_ROLES\.includes\(caller\.role\)/)
    expect(ROUTE_SRC).toMatch(/status: 403/)
  })

  it('SuperAdminLayout gates the nav item on showFeedback (super_admin + corporate + admin)', () => {
    expect(BEEHUB_SRC).toMatch(
      /showFeedback \? \[\{ key:'health', label:'System Health'/,
    )
  })

  it('the deep-link honors the same elevated gate', () => {
    expect(BEEHUB_SRC).toMatch(
      /t === 'health' && \(role === 'super_admin' \|\| role === 'corporate'\)/,
    )
  })

  it('the shell MOUNTS the screen in a renderContent case', () => {
    expect(BEEHUB_SRC).toMatch(/case 'health':[\s\S]{0,400}?<SystemHealthScreen/)
  })
})

// ── C) the honesty rule + verdict behavior ─────────────────────────
describe('SystemHealthScreen', () => {
  it('renders the green verdict and the activity stats', async () => {
    stubFetch(health())
    const { host, unmount } = await mount(<SystemHealthScreen />)
    const text = host.textContent || ''
    expect(text).toMatch(/All clear/i)
    expect(text).toContain('Healthy')       // jobber tile
    expect(text).toContain('$2,450')        // won value, reduced in JS
    await unmount()
  })

  it('a red verdict names the broken thing', async () => {
    stubFetch(health({
      verdict: { level: 'red', problems: ['Portland needs a Jobber reconnect'], cautions: [], attention: 0 },
      jobber: { total: 8, connected: 7, autoRefreshing: 1, reconnectRequired: 1, disconnected: 0,
                problems: [{ name: 'Portland', status: 'reconnect_required', label: 'Reconnect required' }] },
    }))
    const { host, unmount } = await mount(<SystemHealthScreen />)
    expect(host.textContent).toContain('Portland needs a Jobber reconnect')
    await unmount()
  })

  it('an untracked digest admits the gap instead of implying a run', async () => {
    stubFetch(health({ digest: { tracked: false, lastRunAt: null, suppressed: null, posted: null, allClear: null, stale: false } }))
    const { host, unmount } = await mount(<SystemHealthScreen />)
    expect(host.textContent).toMatch(/run tracking isn’t wired yet/i)
    expect(host.textContent).toMatch(/digest_runs\.sql/)
    await unmount()
  })

  it('untracked email counts read "Not tracked yet", not a fake zero', async () => {
    stubFetch(health({ emails: { tracked: false, total: null, failed: null } }))
    const { host, unmount } = await mount(<SystemHealthScreen />)
    expect(host.textContent).toMatch(/Not tracked yet/i)
    expect(host.textContent).toMatch(/notification_log\.sql/)
    await unmount()
  })

  it('a stale digest flips to the stale-cron caution', async () => {
    stubFetch(health({
      verdict: { level: 'amber', problems: [], cautions: ["the Slack digest hasn't run in 14h — likely a stale-deployment cron"], attention: 0 },
      digest: { tracked: true, lastRunAt: '2026-07-23T22:00:00.000Z', suppressed: true, posted: false, allClear: true, stale: true },
    }))
    const { host, unmount } = await mount(<SystemHealthScreen />)
    expect(host.textContent).toMatch(/stale-deployment cron/i)
    await unmount()
  })

  it('needs-a-look items render as rows', async () => {
    stubFetch(health({ needsALook: [{ key: 'unrouted', label: '4 unrouted leads waiting at Corporate' }] }))
    const { host, unmount } = await mount(<SystemHealthScreen />)
    expect(host.textContent).toContain('4 unrouted leads waiting at Corporate')
    await unmount()
  })

  it('an empty look-list reads "Nothing needs a look"', async () => {
    stubFetch(health({ needsALook: [] }))
    const { host, unmount } = await mount(<SystemHealthScreen />)
    expect(host.textContent).toMatch(/Nothing needs a look/i)
    await unmount()
  })

  it('surfaces feedback from the existing triage list', async () => {
    stubFetch(
      health(),
      feedbackList([{ id: 'f1', type: 'bug', title: 'CSV export cuts off', created_at: '2026-07-24T11:00:00.000Z', location_name: 'Portland' }]),
    )
    const { host, unmount } = await mount(<SystemHealthScreen />)
    expect(host.textContent).toContain('CSV export cuts off')
    await unmount()
  })

  it('the window toggle refetches with window=7d', async () => {
    const f = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (String(url).includes('/system-health') ? health() : feedbackList()),
    }))
    vi.stubGlobal('fetch', f)
    const { unmount } = await mount(<SystemHealthScreen />)
    // FilterChips renders the two window segments as buttons; clicking "Last
    // 7 days" must drive a window=7d fetch.
    const btn = Array.from(document.querySelectorAll('button')).find(b => /Last 7 days/i.test(b.textContent || ''))
    expect(btn).toBeTruthy()
    await act(async () => { btn!.dispatchEvent(new Event('click', { bubbles: true })) })
    expect(f.mock.calls.some(c => String(c[0]).includes('window=7d'))).toBe(true)
    await unmount()
  })
})
