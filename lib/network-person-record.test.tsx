// @vitest-environment happy-dom
//
// NETWORK Phase 3 — the person record (NetworkPersonRecord), the module
// that retires Classic's PartnerPanel. Mount tests:
//
//   A) BADGES derive from FACTS: Refers-us appears only once the rollup
//      confirms real referrals; Potential-customer from the warm/Customer
//      signal; Client from is_customer — deep-linking via
//      customer_lead_id (a legacy flag with no link renders unlinked).
//   B) STAGE RAIL is the partner vocabulary, editable — clicking a
//      segment PATCHes stage via the host's onUpdate. Never engagement
//      stages.
//   C) STATS: '—' while /referrals is pending; the real joined numbers
//      once it resolves.
//   D) TOUCHPOINTS: TouchpointModal is mounted VERBATIM and THIS record
//      owns the POST — /api/touchpoints with partner_id (the one
//      writer); a confirmed write updates the local last-talked state.
//   E) WHAT'S NEXT: steps render, checking one PATCHes nextSteps.
//   F) CUSTOMER PATH: "Add as client" matches an existing client FIRST
//      (no duplicate lead), else POSTs /api/leads and stores the REAL id.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NetworkPersonRecord from '@/components/hive/NetworkPersonRecord'
import { deriveNetworkBadges } from '@/components/hive/shared/networkKit'
import { T } from '@/components/hive/shared/tokens'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const PARTNER = {
  id: 'p1', name: 'Karen Martinez', type: 'partner', locationId: 'loc-1',
  title: 'Agent', company: 'Meridian Realty', companyId: 'co1',
  phone: '(816) 555-0916', email: 'karen@meridian.com', website: '',
  specialties: ['real-estate'], stage: 'Building', tags: [],
  lastContactedAt: daysAgo(5), isCustomer: false, customerLeadId: null,
  howWeMet: 'Denver Expo', metDate: 'Nov 2024',
  addresses: [], notes: [], nextSteps: [
    { id: 'ns1', text: 'Send gift', date: '2026-07-20', done: false },
  ], referrals: [], activity: [], isDeleted: false,
}

const REFERRALS = {
  partner: { id: 'p1', name: 'Karen Martinez', type: 'partner' },
  referred: [
    { id: 'L1', name: 'Lisa Patel', created_at: daysAgo(20), converted: true, revenue: 1200, engagement_count: 1, status: 'client' },
    { id: 'L2', name: 'Mark Johnson', created_at: daysAgo(10), converted: false, revenue: 0, engagement_count: 1, status: 'active' },
  ],
  totals: { count: 2, converted: 1, revenue: 1200 },
  total: 2,
}

let host: HTMLDivElement
let root: Root
let fetchMock: any
let fetchCalls: Array<{ url: string; init: any }>

const installFetch = (handlers: Record<string, any> = {}) => {
  fetchCalls = []
  fetchMock = vi.fn(async (url: any, init: any = {}) => {
    const u = String(url)
    fetchCalls.push({ url: u, init })
    for (const [frag, resp] of Object.entries(handlers)) {
      if (u.includes(frag)) {
        const r = typeof resp === 'function' ? (resp as any)(u, init) : resp
        if (r instanceof Promise) return r
        return { ok: true, status: 200, json: async () => r }
      }
    }
    if (u.includes('/referrals')) return { ok: true, status: 200, json: async () => REFERRALS }
    if (u.includes('/timeline')) return { ok: true, status: 200, json: async () => ({ touchpoints: [] }) }
    return { ok: true, status: 200, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchMock)
}

const mount = async (props: any = {}) => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<NetworkPersonRecord partner={PARTNER} companies={[{ id: 'co1', name: 'Meridian Realty' }]} people={[]} {...props} />)
  })
  await act(async () => {}) // flush fetches
}

beforeEach(() => installFetch())
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  host?.remove()
  vi.unstubAllGlobals()
})

describe('A) badges derive from facts', () => {
  it('Refers us appears only on a CONFIRMED referral count; potential/client from their signals', () => {
    expect(deriveNetworkBadges({ partner: PARTNER, referralCount: null })).toEqual([]) // unknown ≠ refers
    expect(deriveNetworkBadges({ partner: PARTNER, referralCount: 0 })).toEqual([])
    expect(deriveNetworkBadges({ partner: PARTNER, referralCount: 2 }).map(b => b.key)).toEqual(['refers'])
    expect(deriveNetworkBadges({ partner: { ...PARTNER, tags: ['warm'] }, referralCount: 0 }).map(b => b.key)).toEqual(['potential'])
    const client = deriveNetworkBadges({ partner: { ...PARTNER, isCustomer: true, customerLeadId: 'lead-9' }, referralCount: 0 })
    expect(client[0]).toMatchObject({ key: 'client', clientLeadId: 'lead-9' })
    // Legacy flag with no link → badge still shows, unlinked.
    expect(deriveNetworkBadges({ partner: { ...PARTNER, isCustomer: true }, referralCount: 0 })[0].clientLeadId).toBe(null)
  })

  it('renders them: Refers us appears after the rollup lands; Client deep-links', async () => {
    await mount({ partner: { ...PARTNER, isCustomer: true, customerLeadId: 'lead-9' } })
    expect(host.querySelector('[data-badge="refers"]')).toBeTruthy()
    const clientBadge = host.querySelector('[data-badge="client"]') as HTMLAnchorElement
    expect(clientBadge).toBeTruthy()
    expect(clientBadge.getAttribute('href')).toBe('/clients/lead-9')
  })
})

describe('B) stage rail — the partner vocabulary, editable', () => {
  it('renders the five relationship stages and PATCHes on click', async () => {
    const onUpdate = vi.fn()
    await mount({ onUpdate })
    const rail = host.querySelector('[data-testid="stage-rail"]')!
    const segs = [...rail.querySelectorAll('[data-stage-seg]')].map(s => s.getAttribute('data-stage-seg'))
    expect(segs).toEqual(['New Contact', 'Reaching Out', 'Building', 'Active Partner', 'Dormant'])
    // Never the engagement vocabulary.
    expect(segs).not.toContain('Request')
    expect(segs).not.toContain('Closed Won')
    // Building = index 2 → three filled segments.
    expect(rail.querySelectorAll('[data-filled="true"]')).toHaveLength(3)
    await act(async () => { (rail.querySelector('[data-stage-seg="Active Partner"]') as HTMLElement).click() })
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1', stage: 'Active Partner' }))
  })
})

describe('C) honest stats', () => {
  it("'—' while the rollup is pending — never a fake zero", async () => {
    installFetch({ '/referrals': () => new Promise(() => {}) }) // never resolves
    await mount()
    const stats = host.querySelector('[data-testid="person-stats"]')!
    expect(stats.textContent).toContain('—')
    expect(stats.textContent).not.toContain('$0')
  })

  it('real joined numbers once resolved; referred leads deep-link', async () => {
    await mount()
    const stats = host.querySelector('[data-testid="person-stats"]')!
    expect(stats.textContent).toContain('2')
    expect(stats.textContent).toContain('$1,200')
    const referred = host.querySelector('[data-testid="leads-referred"]')!
    const lisa = [...referred.querySelectorAll('a')].find(a => a.textContent!.includes('Lisa Patel'))!
    expect(lisa.getAttribute('href')).toBe('/clients/L1')
    expect(lisa.textContent).toContain('$1,200')
  })
})

describe('D) touchpoints — the record owns the POST', () => {
  it('logs via /api/touchpoints with partner_id and reconciles last-talked', async () => {
    const onUpdate = vi.fn()
    installFetch({
      '/api/touchpoints': { touchpoint: { id: 'tp-9', occurred_at: daysAgo(0) } },
    })
    await mount({ onUpdate })
    await act(async () => {
      ([...host.querySelectorAll('button')].find(b => b.textContent === '+ Log touchpoint') as HTMLElement).click()
    })
    // The VERBATIM modal is up (its method tiles + verb-restating button).
    const logBtn = [...document.querySelectorAll('button')].find(b => b.textContent === 'Log call')!
    expect(logBtn).toBeTruthy()
    await act(async () => { logBtn.click() })
    const post = fetchCalls.find(c => c.url.includes('/api/touchpoints') && c.init?.method === 'POST')!
    expect(post).toBeTruthy()
    const body = JSON.parse(post.init.body)
    expect(body).toMatchObject({ partner_id: 'p1', kind: 'reach_out', method: 'call' })
    expect(body).not.toHaveProperty('lead_id')
    // last-talked reconciled into state (state-only; lastContactedAt is
    // not a PATCHable field).
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ lastContactedAt: expect.any(String) }))
  })
})

describe("E) what's next", () => {
  it('renders open steps and checking one PATCHes nextSteps', async () => {
    const onUpdate = vi.fn()
    await mount({ onUpdate })
    const section = host.querySelector('[data-testid="next-steps"]')!
    expect(section.textContent).toContain('Send gift')
    await act(async () => {
      (section.querySelector('[aria-label="Mark done: Send gift"]') as HTMLElement).click()
    })
    const patched = onUpdate.mock.calls[0][0]
    expect(patched.nextSteps.find((s: any) => s.id === 'ns1').done).toBe(true)
  })
})

describe('F) customer path — link, never a blind copy', () => {
  it('matches an existing client first: links their REAL id, no lead POST', async () => {
    const onUpdate = vi.fn()
    const existing = { id: 'lead-77', name: 'Karen Martinez', email: 'karen@meridian.com', phone: '', isJunk: false }
    await mount({ onUpdate, people: [existing] })
    await act(async () => {
      (host.querySelector('[aria-label="Partner actions"]') as HTMLElement).click()
    })
    const item = [...document.querySelectorAll('button')].find(b => b.textContent!.includes('Add as client'))!
    await act(async () => { item.click() })
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ isCustomer: true, customerLeadId: 'lead-77' }))
    expect(fetchCalls.some(c => c.url.includes('/api/leads') && c.init?.method === 'POST')).toBe(false)
  })

  it('no match → POST /api/leads and store the REAL created id (the Classic copy stored nothing)', async () => {
    const onUpdate = vi.fn()
    installFetch({
      '/api/leads': (u: string, init: any) => (init?.method === 'POST'
        ? { lead: { id: 'lead-new-1', name: 'Karen Martinez' } }
        : {}),
    })
    await mount({ onUpdate, people: [] })
    await act(async () => {
      (host.querySelector('[aria-label="Partner actions"]') as HTMLElement).click()
    })
    const item = [...document.querySelectorAll('button')].find(b => b.textContent!.includes('Add as client'))!
    await act(async () => { item.click() })
    const post = fetchCalls.find(c => c.url.includes('/api/leads') && c.init?.method === 'POST')!
    expect(JSON.parse(post.init.body)).toMatchObject({ name: 'Karen Martinez', location_id: 'loc-1' })
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ isCustomer: true, customerLeadId: 'lead-new-1' }))
  })
})
