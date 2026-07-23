// @vitest-environment happy-dom
//
// NETWORK (Phase 2) — the screen that replaced the Classic Contacts list.
// Mount tests against the real NetworkScreen module (props-only, §8.5):
//
//   A) MIXED ROWS (Option C): a company renders SQUARE (radius.control,
//      not 50%) with "N people"; a person renders ROUND. No type labels.
//   B) BANDS group by primary specialty; headers count LEADS REFERRED +
//      revenue — never row count.
//   C) The two special bands render separately, at the bottom, in order:
//      Potential customers then Just met · no intent yet.
//   D) Stage chips render on person rows; 60d+ last-contact renders in
//      the danger tone (fresh rows don't; NULL renders quiet "no
//      touchpoints yet", not red).
//   E) What's-next strip: overdue + due-this-week counts and items,
//      overdue in danger; clicking an item opens the record.
//   F) STATS are honest: real numbers once /api/network/summary resolves
//      ('$6,500', 6) — and '—' while pending, NEVER a fake zero.
//   G) Routing: /network is canonical, /contacts stays a working alias.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import NetworkScreen from '@/components/hive/NetworkScreen'
import { T } from '@/components/hive/shared/tokens'
import { ROUTE_TO_NAV, NAV_TO_URL, parseHubUrl } from '@/components/hive/shared/hubUrl'
import { POTENTIAL_BAND, JUST_MET_BAND } from '@/components/hive/shared/networkGroups'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// happy-dom v20 ships no localStorage — stub (established pattern).
const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
const dateOnly = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10)

const SPECIALTIES = [
  { id: 'real-estate', label: '🏠 Realtor' },
  { id: 'senior-living', label: '🏥 Senior Living' },
]

const PARTNERS = [
  {
    id: 'p1', name: 'Karen Martinez', type: 'partner', locationId: 'loc-1',
    title: 'Agent', company: 'Meridian Realty', companyId: 'co1',
    specialties: ['real-estate'], stage: 'Active Partner', tags: [],
    lastContactedAt: daysAgo(10), isDeleted: false,
    nextSteps: [
      { id: 'ns1', text: 'Send referral gift', date: dateOnly(-2), done: false },
      { id: 'ns2', text: 'Lunch re: summer listings', date: dateOnly(3), done: false },
      { id: 'ns3', text: 'Done thing', date: dateOnly(-30), done: true },
    ],
  },
  {
    id: 'p2', name: 'Stale Sam', type: 'contact', locationId: 'loc-1',
    title: 'Broker', company: 'Meridian Realty', companyId: 'co1',
    specialties: ['real-estate'], stage: 'Building', tags: [],
    lastContactedAt: daysAgo(90), isDeleted: false, nextSteps: [],
  },
  {
    id: 'p3', name: 'Warm Wendy', type: 'partner', locationId: 'loc-1',
    specialties: ['real-estate'], stage: 'Reaching Out', tags: ['warm'],
    lastContactedAt: null, isDeleted: false, nextSteps: [],
  },
  {
    id: 'p4', name: 'Just Met Jim', type: 'contact', locationId: 'loc-1',
    specialties: [], stage: '', tags: [],
    lastContactedAt: null, isDeleted: false, nextSteps: [],
  },
]

const COMPANIES = [
  { id: 'co1', name: 'Meridian Realty', industry: 'Real Estate', locationId: 'loc-1', isDeleted: false },
]

const SUMMARY = {
  referrers: [
    { kind: 'partner', id: 'p1', count: 3, converted: 2, revenue: 4500 },
    { kind: 'partner', id: 'p2', count: 2, converted: 0, revenue: 0 },
    { kind: 'company', id: 'co1', count: 1, converted: 1, revenue: 2000 },
  ],
  totals: { count: 6, converted: 3, revenue: 6500 },
}

let host: HTMLDivElement
let root: Root

const mount = async (props: any = {}, fetchImpl?: any) => {
  vi.stubGlobal('fetch', fetchImpl || vi.fn(async () => ({ ok: true, json: async () => SUMMARY })))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <NetworkScreen
        partners={PARTNERS}
        companies={COMPANIES}
        locFilter="all"
        specialties={SPECIALTIES}
        {...props}
      />
    )
  })
  await act(async () => {}) // flush the summary fetch
}

const band = (key: string) => host.querySelector(`[data-band="${key}"]`) as HTMLElement | null
const expandAll = () => {
  lsStore.set('bee_network_bands_collapsed', JSON.stringify({
    'real-estate': true, [POTENTIAL_BAND]: true, [JUST_MET_BAND]: true,
  }))
}

beforeEach(() => {
  vi.stubGlobal('localStorage', lsMock)
  lsStore.clear()
  expandAll()
})
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  host?.remove()
  vi.unstubAllGlobals()
})

describe('A) mixed rows — square company, round person, no type labels', () => {
  it('a company is ONE row: square avatar + "N people"; a person is round', async () => {
    await mount()
    const re = band('real-estate')!
    const companyRow = re.querySelector('[data-rowtype="company"]') as HTMLElement
    expect(companyRow).toBeTruthy()
    expect(companyRow.textContent).toContain('Meridian Realty')
    expect(companyRow.textContent).toContain('2 people')
    const sq = companyRow.querySelector('[data-avatar="company"]') as HTMLElement
    expect(sq.style.borderRadius).toBe(T.radius.control)   // SQUARE-ish, never a circle

    const personRow = re.querySelector('[data-rowtype="person"]') as HTMLElement
    expect(personRow).toBeTruthy()
    const round = personRow.querySelector('div') as HTMLElement
    expect(round.style.borderRadius).toBe(T.radius.round)  // 50%

    // The shape IS the affordance — no "Partner"/"Contact"/"Company" labels.
    expect(re.textContent).not.toContain('👤 Contact')
    expect(re.textContent).not.toMatch(/\bCompany\b/)
  })

  it('company subtitle counts its linked people', async () => {
    await mount()
    const companyRow = band('real-estate')!.querySelector('[data-rowtype="company"]') as HTMLElement
    expect(companyRow.textContent).toContain('2 people · Real Estate')
  })
})

describe('B) bands by specialty — headers count leads referred, not rows', () => {
  it('groups by primary specialty and headers carry leads + revenue', async () => {
    await mount()
    const re = band('real-estate')!
    expect(re).toBeTruthy()
    // 3 rows in the band (Karen, Sam, Meridian) but the header counts the
    // 6 leads its members REFERRED — and the summed real revenue.
    const header = re.querySelector('[role="button"]') as HTMLElement
    expect(header.textContent).toContain('6 leads referred')
    expect(header.textContent).toContain('$6,500')
    expect(header.textContent).not.toContain('· 3') // never a row count
    expect(re.querySelectorAll('[data-rowtype]')).toHaveLength(3)
  })

  it('per-row numbers are the rollup joins, not jsonb zeros', async () => {
    await mount()
    const rows = [...band('real-estate')!.querySelectorAll('[data-rowtype]')] as HTMLElement[]
    const karen = rows.find(r => r.textContent!.includes('Karen'))!
    expect(karen.textContent).toContain('3 referred')
    expect(karen.textContent).toContain('$4,500')
  })
})

describe('C) the two special bands', () => {
  it('Potential customers and Just met render separately, in that order, at the bottom', async () => {
    await mount()
    const keys = [...host.querySelectorAll('[data-band]')].map(el => el.getAttribute('data-band'))
    expect(keys).toEqual(['real-estate', POTENTIAL_BAND, JUST_MET_BAND])
    expect(band(POTENTIAL_BAND)!.textContent).toContain('Potential customers')
    expect(band(POTENTIAL_BAND)!.textContent).toContain('Warm Wendy')
    expect(band(JUST_MET_BAND)!.textContent).toContain('Just met · no intent yet')
    expect(band(JUST_MET_BAND)!.textContent).toContain('Just Met Jim')
  })
})

describe('D) stage chips + staleness', () => {
  it('person rows carry their pipeline stage chip', async () => {
    await mount()
    const chips = [...band('real-estate')!.querySelectorAll('[data-stage-chip]')].map(c => c.textContent)
    expect(chips).toContain('Active Partner')
    expect(chips).toContain('Building')
  })

  it('60d+ renders the danger tone; fresh does not; never-contacted renders quiet', async () => {
    await mount()
    const stale = host.querySelector('[data-recency="stale"]') as HTMLElement
    expect(stale).toBeTruthy()
    expect(stale.style.color).toBe(T.state.danger.fg)
    const fresh = host.querySelector('[data-recency="fresh"]') as HTMLElement
    expect(fresh.style.color).not.toBe(T.state.danger.fg)
    const unknown = host.querySelector('[data-recency="unknown"]') as HTMLElement
    expect(unknown.textContent).toBe('no touchpoints yet')
    expect(unknown.style.color).not.toBe(T.state.danger.fg)
  })
})

describe('E) what’s-next strip', () => {
  it('surfaces overdue + due-this-week with correct counts; overdue in danger', async () => {
    await mount()
    const strip = host.querySelector('[data-testid="whats-next"]') as HTMLElement
    expect(strip).toBeTruthy()
    expect(strip.textContent).toContain('1 overdue')
    expect(strip.textContent).toContain('1 this week')
    expect(strip.textContent).toContain('Send referral gift')
    expect(strip.textContent).toContain('Karen Martinez')
    expect(strip.textContent).not.toContain('Done thing') // done steps stay out
  })

  it('clicking an item opens that record', async () => {
    const onOpenPerson = vi.fn()
    await mount({ onOpenPerson })
    const strip = host.querySelector('[data-testid="whats-next"]') as HTMLElement
    const item = [...strip.querySelectorAll('button')].find(b => b.textContent!.includes('Send referral gift'))!
    await act(async () => { item.click() })
    expect(onOpenPerson).toHaveBeenCalledTimes(1)
    expect(onOpenPerson.mock.calls[0][0].id).toBe('p1')
  })
})

describe('F) honest stats', () => {
  it('renders the real joined numbers once the summary resolves', async () => {
    await mount()
    const stats = host.querySelector('[data-testid="network-stats"]') as HTMLElement
    expect(stats.textContent).toContain('5')        // in network (4 people + 1 company)
    expect(stats.textContent).toContain('6')        // leads referred
    expect(stats.textContent).toContain('$6,500')   // revenue — REAL, not $0
    expect(stats.textContent).toContain('Gone cold')
  })

  it('shows "—" (never a fake zero) while the summary is pending', async () => {
    await mount({}, vi.fn(() => new Promise(() => {}))) // never resolves
    const stats = host.querySelector('[data-testid="network-stats"]') as HTMLElement
    expect(stats.textContent).toContain('—')
    // The referral tiles specifically hold '—', not 0.
    const tiles = [...stats.querySelectorAll('p')].map(p => p.textContent)
    expect(tiles).toContain('—')
    expect(tiles).not.toContain('$0')
  })

  it('gone cold counts only KNOWN-stale (null = unknown, not cold)', async () => {
    await mount()
    // p2 is 90d stale; p3/p4 have NULL last_contacted_at → not counted.
    const stats = host.querySelector('[data-testid="network-stats"]') as HTMLElement
    const cold = [...stats.querySelectorAll('div')].find(d => d.textContent!.includes('Gone cold'))!
    expect(cold.querySelector('p')!.textContent).toBe('1')
  })

  it('clicking a company row opens the company record', async () => {
    const onOpenCompany = vi.fn()
    await mount({ onOpenCompany })
    const companyRow = band('real-estate')!.querySelector('[data-rowtype="company"]') as HTMLElement
    await act(async () => { companyRow.click() })
    expect(onOpenCompany).toHaveBeenCalledTimes(1)
    expect(onOpenCompany.mock.calls[0][0].id).toBe('co1')
  })
})

describe('G) routing — /network canonical, /contacts alive', () => {
  it('both slugs resolve to the same nav key; canonical URL is /network', () => {
    expect(ROUTE_TO_NAV.network).toBe('partners')
    expect(ROUTE_TO_NAV.contacts).toBe('partners')   // the alias never breaks
    expect(NAV_TO_URL.partners).toBe('/network')
    expect(parseHubUrl('/network').nav).toBe('partners')
    expect(parseHubUrl('/contacts').nav).toBe('partners')
  })
})
