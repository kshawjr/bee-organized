// @vitest-environment happy-dom
//
// NETWORK on 'All Locations' (Phase 4b, extended) + the two silent caps.
//
// Network shipped after the Phase 4b work but on Phase-1-era semantics: an
// elevated user on 'all' got every location's partners and companies BLENDED —
// the exact pattern the Inbox, Client List and Engagements retired. These
// tests pin the new posture, MOUNTED (per the allOverview hotfix: a source pin
// cannot catch an unbound identifier — only executing the render can):
//
//   A) locationRequired → the SHARED PickALocation prompt (no second empty
//      state), no bands, no Add button, no fake zeros.
//   B) What survives on 'all': the tenant-wide /api/network/summary rollup —
//      the three summary-backed stat tiles render REAL cross-location numbers;
//      the two row-derived tiles (In network / Gone cold) are dropped, the
//      same suppression posture as the shell's tab badges.
//   C) Scoped + franchise loads: byte-identical — bands render, never the
//      prompt.
//   D) Truncation is VISIBLE: the networkTruncated banner renders past the
//      cap, never silently.
//   E) ReferrerPicker reads the new { rows, total, truncated } shape from
//      /api/partners + /api/companies, states a truthful total when the pool
//      is short, and still reads the legacy bare-array shape.
//
// The server side (the hub-page gate + the route pagination) cannot mount
// under vitest, so that wiring is pinned by source below — the same split
// lib/beta-hub-scope-phase4.test.ts uses.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NetworkScreen from '@/components/hive/NetworkScreen'
import ReferrerPicker from '@/components/hive/ReferrerPicker'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// happy-dom v20 ships no localStorage — stub (established pattern).
const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}
Object.defineProperty(globalThis, 'localStorage', { value: lsMock, configurable: true })

const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'

const SPECIALTIES = [{ id: 'real-estate', label: '🏠 Realtor' }]

const PARTNERS = [
  {
    id: 'p1', name: 'Karen Martinez', type: 'partner', locationId: KC,
    title: 'Agent', company: 'Meridian Realty', companyId: 'co1',
    specialties: ['real-estate'], stage: 'Active Partner', tags: [],
    lastContactedAt: null, isDeleted: false, nextSteps: [],
  },
]
const COMPANIES = [
  { id: 'co1', name: 'Meridian Realty', industry: 'Real Estate', locationId: KC, isDeleted: false },
]

const SUMMARY = {
  referrers: [{ kind: 'partner', id: 'p1', count: 12, converted: 5, revenue: 6500 }],
  totals: { count: 12, converted: 5, revenue: 6500 },
}

let fetchCalls: string[] = []
beforeEach(() => {
  lsStore.clear()
  fetchCalls = []
  ;(globalThis as any).fetch = vi.fn(async (url: any) => {
    const u = String(url)
    fetchCalls.push(u)
    if (u.includes('/api/network/summary')) {
      return { ok: true, status: 200, json: async () => SUMMARY }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
})

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })

async function mount(el: React.ReactElement) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(el) })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  cleanup.push(() => { try { root.unmount() } catch {} host.remove() })
  return host
}

const netProps = (over: any = {}) => ({
  partners: PARTNERS, companies: COMPANIES, specialties: SPECIALTIES,
  locFilter: 'all', ...over,
})

describe("NetworkScreen on 'All Locations' — the record list prompts", () => {
  it('shows the SHARED prompt instead of a blended list — even with rows in the props', async () => {
    const onPick = vi.fn()
    const host = await mount(React.createElement(NetworkScreen as any, netProps({
      locationRequired: true, onOpenLocationPicker: onPick,
    })))
    expect(host.textContent).toContain('The network works one location at a time')
    expect(host.textContent).toContain('All Locations')
    // No record rows, no bands — the blend is the retired pattern.
    expect(host.textContent).not.toContain('Karen Martinez')
    expect(host.querySelector('[data-band]')).toBeNull()
    // The prompt's button opens the switcher in place.
    const btn = Array.from(host.querySelectorAll('button')).find(b => (b.textContent || '').includes('Choose a location'))
    expect(btn).toBeTruthy()
    await act(async () => { (btn as HTMLButtonElement).click() })
    expect(onPick).toHaveBeenCalled()
  })

  it('keeps the tenant-wide rollup: summary-backed tiles show REAL cross-location numbers', async () => {
    const host = await mount(React.createElement(NetworkScreen as any, netProps({
      locationRequired: true, onOpenLocationPicker: vi.fn(),
    })))
    // The summary was fetched TENANT-WIDE (no location_id) — the kept surface.
    const summaryCall = fetchCalls.find(u => u.includes('/api/network/summary'))
    expect(summaryCall).toBeTruthy()
    expect(summaryCall).not.toContain('location_id')
    const stats = host.querySelector('[data-testid="network-stats"]') as HTMLElement
    expect(stats).toBeTruthy()
    expect(stats.textContent).toContain('12')       // leads referred
    expect(stats.textContent).toContain('5')        // converted
    expect(stats.textContent).toContain('$6,500')   // revenue
  })

  it('row-derived tiles are DROPPED, not shown as fake zeros', async () => {
    const host = await mount(React.createElement(NetworkScreen as any, netProps({
      // Empty arrays — what 'all' actually ships now. A rendered "In network:
      // 0" would read as "your network is empty", not "not counted here".
      partners: [], companies: [],
      locationRequired: true, onOpenLocationPicker: vi.fn(),
    })))
    const stats = host.querySelector('[data-testid="network-stats"]') as HTMLElement
    expect(stats.textContent).not.toContain('In network')
    expect(stats.textContent).not.toContain('Gone cold')
    // Header subtitle names the scope rather than counting nothing.
    expect(host.textContent).toContain('Referral totals across all locations')
    expect(host.textContent).not.toContain('0 in your referral network')
  })

  it('the Add door is hidden — creating a network record needs a location', async () => {
    const host = await mount(React.createElement(NetworkScreen as any, netProps({
      locationRequired: true, onOpenLocationPicker: vi.fn(),
    })))
    const add = Array.from(host.querySelectorAll('button')).find(b => (b.textContent || '').trim() === '+ Add')
    expect(add).toBeFalsy()
  })

  it('copy never says the data is missing — it says how the product works', async () => {
    const host = await mount(React.createElement(NetworkScreen as any, netProps({
      partners: [], companies: [],
      locationRequired: true, onOpenLocationPicker: vi.fn(),
    })))
    const text = host.textContent || ''
    expect(text).toContain('one location at a time')
    for (const wrong of ['No results', 'nothing loaded', 'No data', 'Your network starts here']) {
      expect(text).not.toContain(wrong)
    }
  })
})

describe('NetworkScreen SCOPED — unchanged (franchise + elevated alike)', () => {
  it('renders the bands and never the prompt (locationRequired defaults false)', async () => {
    const host = await mount(React.createElement(NetworkScreen as any, netProps({ locFilter: KC })))
    // Bands render collapsed by default — the band header (with its referred
    // rollup) is the proof the list rendered; the prompt must be absent.
    const band = host.querySelector('[data-band]') as HTMLElement
    expect(band).toBeTruthy()
    expect(band.textContent).toContain('Realtor')
    expect(host.textContent).not.toContain('one location at a time')
    // Full stats strip, including the row-derived tiles.
    const stats = host.querySelector('[data-testid="network-stats"]') as HTMLElement
    expect(stats.textContent).toContain('In network')
    expect(stats.textContent).toContain('Gone cold 60d+')
    // Scoped summary fetch carries the location.
    expect(fetchCalls.some(u => u.includes(`location_id=${KC}`))).toBe(true)
  })
})

describe('Truncation is VISIBLE, never silent', () => {
  it('the banner renders when the SSR load hit its ceiling', async () => {
    const host = await mount(React.createElement(NetworkScreen as any, netProps({
      locFilter: KC, truncated: true,
    })))
    const banner = host.querySelector('[data-testid="network-truncated"]') as HTMLElement
    expect(banner).toBeTruthy()
    expect(banner.textContent).toContain("Some network records weren't loaded")
    expect(banner.textContent).toContain('incomplete')
  })

  it('no banner on a complete load', async () => {
    const host = await mount(React.createElement(NetworkScreen as any, netProps({ locFilter: KC })))
    expect(host.querySelector('[data-testid="network-truncated"]')).toBeNull()
  })
})

describe('ReferrerPicker — truthful totals from /api/partners + /api/companies', () => {
  const pickerFetch = (partnersPayload: any, companiesPayload: any) => {
    ;(globalThis as any).fetch = vi.fn(async (url: any) => {
      const u = String(url)
      fetchCalls.push(u)
      if (u.includes('/api/partners')) return { ok: true, status: 200, json: async () => partnersPayload }
      if (u.includes('/api/companies')) return { ok: true, status: 200, json: async () => companiesPayload }
      return { ok: true, status: 200, json: async () => ({}) }
    })
  }

  it('reads the wrapped { rows, total, truncated } shape and states the shortfall', async () => {
    pickerFetch(
      { rows: [{ id: 'p1', name: 'Karen Martinez', title: 'Agent', company: 'Meridian Realty', isDeleted: false }], total: 6000, truncated: true },
      { rows: [], total: 0, truncated: false },
    )
    const host = await mount(React.createElement(ReferrerPicker as any, { locationUuid: KC }))
    expect(host.textContent).toContain('Karen Martinez')
    const note = host.querySelector('[data-testid="referrer-pool-truncated"]') as HTMLElement
    expect(note).toBeTruthy()
    expect(note.textContent).toContain('Showing the first 1 of 6,000 network records')
  })

  it('a complete wrapped response shows NO truncation note', async () => {
    pickerFetch(
      { rows: [{ id: 'p1', name: 'Karen Martinez', isDeleted: false }], total: 1, truncated: false },
      { rows: [{ id: 'co1', name: 'Meridian Realty', industry: 'Real Estate', isDeleted: false }], total: 1, truncated: false },
    )
    const host = await mount(React.createElement(ReferrerPicker as any, { locationUuid: KC }))
    expect(host.textContent).toContain('Karen Martinez')
    expect(host.textContent).toContain('Meridian Realty')
    expect(host.querySelector('[data-testid="referrer-pool-truncated"]')).toBeNull()
  })

  it('still reads the legacy bare-array shape (older mocks/responses degrade to complete)', async () => {
    pickerFetch(
      [{ id: 'p1', name: 'Karen Martinez', isDeleted: false }],
      [{ id: 'co1', name: 'Meridian Realty', industry: 'Real Estate', isDeleted: false }],
    )
    const host = await mount(React.createElement(ReferrerPicker as any, { locationUuid: KC }))
    expect(host.textContent).toContain('Karen Martinez')
    expect(host.textContent).toContain('Meridian Realty')
    expect(host.querySelector('[data-testid="referrer-pool-truncated"]')).toBeNull()
  })
})

// ── Server-side wiring — pinned by source (cannot mount under vitest) ───────
describe('_hub-page — the network load follows the overviewOnly gate (source)', () => {
  const src = readFileSync('app/_hub-page.tsx', 'utf8')

  it("no partner/company bulk fetch on 'all' — the load sits behind !overviewOnly", () => {
    const truncDecl = src.indexOf('let networkTruncated = false')
    const loader = src.indexOf('loadNetworkRows')
    expect(truncDecl).toBeGreaterThan(0)
    expect(loader).toBeGreaterThan(truncDecl)
    // The gate opens between the flag declaration and the loader — the same
    // `if (!overviewOnly)` posture the leads/bin loads use.
    expect(src.slice(truncDecl, loader)).toContain('if (!overviewOnly) {')
  })

  it('the silent .limit(2000) cap is gone — paginated with a stated ceiling', () => {
    expect(src).not.toContain('.limit(2000)')
    expect(src).toContain('MAX_NETWORK_ROWS')
    expect(src).toContain('networkTruncated = true')
    expect(src).toContain('initialNetworkTruncated={networkTruncated}')
  })
})

describe('BeeHub wiring — Network gets the same gate as the record lenses (source)', () => {
  const src = readFileSync('components/BeeHub.jsx', 'utf8')

  it('PartnersScreen receives server truth, the picker opener, and the flag', () => {
    // Server truth (!!initialAllOverview), NOT locFilter === 'all' — a
    // franchise user must never trip the prompt.
    expect(src).toContain('locationRequired={!!initialAllOverview} onOpenLocationPicker={()=>setShowLocPicker(true)} networkTruncated={!!initialNetworkTruncated}')
  })

  it('⌘K partner hits come from the server when available — local scan is the fallback', () => {
    expect(src).toContain('const matchedPartners = (!remote.failed && remote.partners) ? remote.partners.slice(0,4) : localPartnerScan')
  })
})

describe('/api/partners + /api/companies GET — the invisible 1,000-row default is dead (source)', () => {
  for (const route of ['app/api/partners/route.ts', 'app/api/companies/route.ts']) {
    it(`${route} paginates and returns a truthful total`, () => {
      const src = readFileSync(route, 'utf8')
      expect(src).toContain('.range(from, from + PAGE - 1)')
      expect(src).toContain("count: 'exact', head: true")
      expect(src).toContain('rows, total, truncated')
    })
  }
})

describe('/api/search — partners ride the same fence (source)', () => {
  const src = readFileSync('app/api/search/route.ts', 'utf8')
  it('searches partners server-side, scoped for franchise, tenant-wide for elevated', () => {
    expect(src).toContain("from('partners')")
    expect(src).toContain('partners: partnerHits')
    // The fence: same scopeUuid the lead search uses.
    expect(src).toContain("if (scopeUuid) pq = pq.eq('location_id', scopeUuid)")
  })
})
