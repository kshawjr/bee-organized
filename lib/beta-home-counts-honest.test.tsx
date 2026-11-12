// @vitest-environment happy-dom
//
// Home's "Some records weren't loaded" banner — never silent when a number on
// screen is short, never shouting when none is.
//
// THE CASE. Philadelphia Suburbs has 18,931 active leads; the page loads the
// newest 5,000 (MAX_LEADS). The banner fired on every load, and it was RIGHT:
// Active clients read 19 when 22 clients had an open engagement, because it
// looked each client up in the cut-off people graph and three of their leads
// predate 6 Jan 2025.
//
// THE FIX, pinned here:
//   1. Active clients is counted from the open ENGAGEMENTS (uncapped load),
//      the way All Locations already does — 22, whatever the people graph holds.
//   2. A cut-off location gets the leads-derived numbers (Outstanding, the
//      new-uncontacted and aging-invoice cards) from the server reduction in
//      lib/hub-all-overview.ts, fenced to that location — exact, not short.
//   3. The banner follows the NUMBERS: it fires only when a number on screen
//      came from a short source — the server reduction missing, built for
//      another location, or itself over one of its limits.
//   4. The leads load pages on created_at AND id, so rows sharing a timestamp
//      cannot repeat or vanish between pages.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200
;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any

import App from '@/components/BeeHub'
import { buildAllOverview } from '@/lib/hub-all-overview'

const PHL = 'd21c632e-f5ad-4af5-b93a-672bde85c378'
const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'
const DAY = 86400000
const BANNER = "Some records weren't loaded"

// ── Philadelphia Suburbs, as the browser receives it on a cut-off load ──────
// 24 open engagements over 22 clients (two clients have two deals each). Only
// 19 of those 22 clients are in the loaded people graph; 5 loaded leads are
// from this week. Every invoice balance is 0.
const phlClientIds = Array.from({ length: 22 }, (_, i) => `phl-c${i + 1}`)
const phlEngagements = [
  ...phlClientIds.map((c, i) => ({ id: `phl-e${i + 1}`, client_id: c, stage: 'Request', location_uuid: PHL, quotes: [], assessments: [] })),
  { id: 'phl-e23', client_id: 'phl-c1', stage: 'Estimate', location_uuid: PHL, quotes: [], assessments: [] },
  { id: 'phl-e24', client_id: 'phl-c2', stage: 'Estimate', location_uuid: PHL, quotes: [], assessments: [] },
]
const person = (id: string, ageDays: number, locationId = PHL, invoices: any[] = []) => ({
  id, name: `Client ${id}`, email: `${id}@x.com`, phone: '2155550100', locationId,
  created: new Date(Date.now() - ageDays * DAY).toISOString(),
  isJunk: false, tags: [], invoices, jobs: [], quotes: [], touchpoints: [], outreachTimeline: [],
  importSource: 'jobber_initial',
})
const phlPeople = [
  // 19 of the 22 open-engagement clients made it into the newest 5,000
  ...phlClientIds.slice(0, 19).map(id => person(id, 300)),
  // 5 leads from this week
  ...[1, 2, 3, 4, 5].map(n => person(`phl-new${n}`, n === 5 ? 6 : 1)),
]
const exactOverview = (over: any = {}) => ({
  newUncontacted: { count: 0, oldestDays: 0 },
  estimateFollowUps: { count: 0, oldestDays: 0 },
  upcomingAssessments: [],
  agingInvoices: { count: 0, total: 0, oldestDays: 0 },
  openEngagementsCount: 24,
  activeClientsCount: 22,
  newThisWeekCount: 5,
  outstandingTotal: 0,
  leadCount: 18931,
  truncated: false,
  ...over,
})

const ownerProps = (loc: string, over: any = {}) => ({
  initialRoute: 'home',
  initialRole: 'franchise',
  initialFranchiseRole: 'owner',
  initialLocFilter: loc,
  initialScopeLocationId: loc,
  initialAllOverview: null,
  initialLocations: [
    { id: PHL, name: 'Philadelphia Suburbs', state: 'PA', crmStatus: 'active' },
    { id: KC, name: 'Kansas City', state: 'MO', crmStatus: 'active' },
  ],
  initialUsers: [], initialSeats: [], initialPendingInvites: [], initialLookups: {},
  initialPeople: [], initialBinPeople: [], initialTransferPeople: [], initialEngagements: [],
  initialPartners: [], initialCompanies: [], initialGuideSlides: [], initialManualSlides: [], initialTierPrices: [],
  currentUser: { id: 'u-kelly', email: 'owner@x.com', name: 'Owner', role: 'owner', locationId: loc },
  currentLocation: { id: loc, name: 'Location', jobber_connected: false, jobber_account_id: null, last_sync_status: null, token_expiry: null },
  currentSubscription: null,
  ...over,
})

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })

async function mountApp(props: any) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => { root.render(React.createElement(App as any, props)) })
  for (let i = 0; i < 8; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
  cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })
  return host
}

// The value <p> sits directly above its label <p> in HomeMetricTile.
const tile = (host: HTMLElement, label: string): string | null => {
  const p = Array.from(host.querySelectorAll('p')).find(el => el.textContent === label)
  return p?.previousElementSibling?.textContent ?? null
}

describe('Philadelphia Suburbs — a cut-off load with exact server counts', () => {
  it('reads 24 / 22 / 5 / $0.00 and shows NO banner', async () => {
    const host = await mountApp(ownerProps(PHL, {
      initialPeople: phlPeople, initialEngagements: phlEngagements,
      initialLeadsTruncated: true, initialScopedOverview: exactOverview(),
    }))
    expect(tile(host, 'Open engagements')).toBe('24')
    expect(tile(host, 'Active clients')).toBe('22')   // was 19: the people lookup missed 3
    expect(tile(host, 'New this week')).toBe('5')
    expect(tile(host, 'Outstanding')).toBe('$0.00')
    expect(host.textContent).not.toContain(BANNER)
  })

  it('takes the leads-derived numbers from the SERVER, not the short people graph', async () => {
    // The loaded leads carry no unpaid invoices and no new enquiries; the
    // server says otherwise for the leads it could see and the browser could
    // not. The server's numbers must be the ones on screen.
    const host = await mountApp(ownerProps(PHL, {
      initialPeople: phlPeople, initialEngagements: phlEngagements,
      initialLeadsTruncated: true,
      initialScopedOverview: exactOverview({
        outstandingTotal: 1234.5,
        agingInvoices: { count: 2, total: 800, oldestDays: 70 },
        newUncontacted: { count: 3, oldestDays: 9 },
      }),
    }))
    expect(tile(host, 'Outstanding')).toBe('$1,234.50')
    expect(host.textContent).toContain('$800.00 unpaid')
    expect(host.textContent).toContain('3 new leads not contacted')
    expect(host.textContent).not.toContain(BANNER)
  })
})

describe('The banner fires when a number on screen really is short', () => {
  it('the server reduction hit one of its own limits → banner', async () => {
    const host = await mountApp(ownerProps(PHL, {
      initialPeople: phlPeople, initialEngagements: phlEngagements,
      initialLeadsTruncated: true, initialScopedOverview: exactOverview({ truncated: true }),
    }))
    expect(host.textContent).toContain(BANNER)
  })

  it('the server reduction failed (null) on a cut-off load → banner', async () => {
    const host = await mountApp(ownerProps(PHL, {
      initialPeople: phlPeople, initialEngagements: phlEngagements,
      initialLeadsTruncated: true, initialScopedOverview: null,
    }))
    expect(host.textContent).toContain(BANNER)
  })

  it('a reduction built for ANOTHER location is not used → banner, and the short local number stays', async () => {
    const host = await mountApp(ownerProps(PHL, {
      initialPeople: [person('phl-c1', 300, PHL, [{ id: 'i1', balance: 50, date: new Date(Date.now() - 2 * DAY).toISOString() }])],
      initialEngagements: phlEngagements,
      initialLeadsTruncated: true,
      initialScopeLocationId: KC,   // the server built it for Kansas City
      initialScopedOverview: exactOverview({ outstandingTotal: 9999 }),
    }))
    expect(host.textContent).toContain(BANNER)
    expect(tile(host, 'Outstanding')).not.toBe('$9,999.00')
  })
})

describe('A small location is unchanged', () => {
  it('complete load → local numbers, no banner', async () => {
    const kcEngs = [
      { id: 'k1', client_id: 'kc1', stage: 'Request', location_uuid: KC, quotes: [], assessments: [] },
      { id: 'k2', client_id: 'kc1', stage: 'Estimate', location_uuid: KC, quotes: [], assessments: [] },
      { id: 'k3', client_id: 'kc2', stage: 'Request', location_uuid: KC, quotes: [], assessments: [] },
      { id: 'k4', client_id: 'kc3', stage: 'Closed Won', location_uuid: KC, quotes: [], assessments: [] },
    ]
    const kcPeople = [
      person('kc1', 1, KC, [{ id: 'i1', balance: 120, date: new Date(Date.now() - 2 * DAY).toISOString() }]),
      person('kc2', 40, KC),
      person('kc3', 2, KC),
    ]
    const host = await mountApp(ownerProps(KC, {
      initialPeople: kcPeople, initialEngagements: kcEngs,
      initialLeadsTruncated: false, initialScopedOverview: null,
    }))
    expect(tile(host, 'Open engagements')).toBe('3')
    expect(tile(host, 'Active clients')).toBe('2')
    expect(tile(host, 'New this week')).toBe('2')
    expect(tile(host, 'Outstanding')).toBe('$120.00')
    expect(host.textContent).not.toContain(BANNER)
  })
})

describe('Where the decision lives', () => {
  const dash = readFileSync('components/BeeHub.jsx', 'utf8')
  it('the banner reads the per-number verdict, not the page-level load flag', () => {
    expect(dash).toContain('{countsShort && (')
    expect(dash).not.toContain('{(leadsTruncated || overviewTruncated) && (')
    expect(dash).toContain('countsShort: leadsTruncated ? (!serverH || !!serverH.truncated) : false,')
  })
})

// ── The server side ──────────────────────────────────────────────────────────
function makeDb(tables: Record<string, any[]>) {
  const from = (table: string) => {
    let rows = [...(tables[table] || [])]
    let head = false
    const b: any = {
      select(_c: string, opts: any = {}) { head = !!opts.head; return b },
      not(col: string, op: string, val: any) { if (op === 'is' && val === true) rows = rows.filter(r => r[col] !== true); return b },
      eq(col: string, val: any) { rows = rows.filter(r => r[col] === val); return b },
      neq(col: string, val: any) { rows = rows.filter(r => r[col] !== val); return b },
      is(col: string, val: any) { rows = rows.filter(r => val === null ? r[col] == null : r[col] === val); return b },
      gt(col: string, val: any) { rows = rows.filter(r => Number(r[col]) > Number(val)); return b },
      gte(col: string, val: any) { rows = rows.filter(r => String(r[col]) >= String(val)); return b },
      lt(col: string, val: any) { rows = rows.filter(r => String(r[col]) < String(val)); return b },
      in(col: string, vals: any[]) { const s = new Set(vals); rows = rows.filter(r => s.has(r[col])); return b },
      order() { return b },
      range(a: number, z: number) { rows = rows.slice(a, z + 1); return b },
      then(res: any, rej: any) {
        return Promise.resolve(head ? { data: null, count: rows.length, error: null } : { data: rows, count: rows.length, error: null }).then(res, rej)
      },
    }
    return b
  }
  return { from }
}

const NOW = Date.UTC(2026, 10, 12, 12)
const iso = (d: number) => new Date(NOW - d * DAY).toISOString()
const tenant = () => makeDb({
  leads: [
    { id: 'p1', location_uuid: PHL, location_id: 'loc_phillysuburbs', import_source: 'manual', created_at: iso(2), email: 'a@x.com', phone: '2155550100', is_junk: false, archived_at: null },
    { id: 'k1', location_uuid: KC, location_id: 'loc_kc', import_source: 'manual', created_at: iso(2), email: 'b@x.com', phone: '8165550100', is_junk: false, archived_at: null },
    { id: 'k2', location_uuid: KC, location_id: 'loc_kc', import_source: 'manual', created_at: iso(3), email: 'c@x.com', phone: '8165550101', is_junk: false, archived_at: null },
  ],
  touchpoints: [], engagements: [], service_requests: [], quotes: [], jobs: [], partners: [],
  invoices: [
    { id: 'ip', location_id: 'loc_phillysuburbs', balance_owing: 40, issued_at: iso(90), status: 'sent' },
    { id: 'ik', location_id: 'loc_kc', balance_owing: 500, issued_at: iso(90), status: 'sent' },
  ],
})

describe('buildAllOverview fenced to one location', () => {
  it('counts only that location: its enquiries, its invoices, its leads', async () => {
    const ov = await buildAllOverview(tenant(), [], NOW, { uuid: PHL, slug: 'loc_phillysuburbs' })
    expect(ov.newUncontacted.count).toBe(1)
    expect(ov.outstandingTotal).toBe(40)
    expect(ov.agingInvoices.count).toBe(1)
    expect(ov.leadCount).toBe(1)
    expect(ov.truncated).toBe(false)
  })

  it('without a location it is the whole tenant, as before', async () => {
    const ov = await buildAllOverview(tenant(), [], NOW)
    expect(ov.newUncontacted.count).toBe(3)
    expect(ov.outstandingTotal).toBe(540)
    expect(ov.leadCount).toBe(3)
  })

  it('no slug → invoices cannot be fenced → it says so rather than counting the tenant', async () => {
    const ov = await buildAllOverview(tenant(), [], NOW, { uuid: PHL, slug: null })
    expect(ov.outstandingTotal).toBe(0)
    expect(ov.truncated).toBe(true)
  })
})

describe('The hub page', () => {
  const page = readFileSync('app/_hub-page.tsx', 'utf8')
  const leadsLoop = page.slice(page.indexOf('const MAX_LEADS = 5000'), page.indexOf('if (leadsError) {'))

  it('pages the leads load on created_at AND id (a stable order)', () => {
    expect(leadsLoop).toMatch(/\.order\('created_at', \{ ascending: false \}\)[\s\S]*?\.order\('id', \{ ascending: true \}\)[\s\S]*?\.range\(from, from \+ PAGE - 1\)/)
  })

  it('builds the location-fenced overview only for a cut-off scoped load, and ships it', () => {
    expect(page).toContain('if (leadsTruncated && scopeLocationUuid) {')
    expect(page).toContain('supabaseService, initialEngagements, Date.now(), { uuid: scopeLocationUuid, slug },')
    expect(page).toContain('initialScopedOverview={initialScopedOverview}')
  })
})
