// @vitest-environment happy-dom
//
// NETWORK (Phase 2) — the screen that replaced the Classic Contacts list.
// Mount tests against the real NetworkScreen module (props-only, §8.5):
//
//   A) MIXED ROWS (Option C): a company renders SQUARE (radius.control,
//      not 50%) with "N people"; a person renders ROUND. No type labels.
//   B) ONE FLAT LIST sorted by name (tag merge 2026-10-15 — Kevin: the
//      specialty bands were noise on a list of four or five, and only
//      existed because there was no real filter). No band headings.
//   C) THE TAG FILTER — searchable, multi-pick, any-of, over the one tag
//      list; it finds a person by ANY of their tags (the old filter only
//      saw the first specialty); a company shows when one of ITS people
//      matches, the rest are hidden WITH a line saying how many; a
//      pre-merge saved view (specFilter slug) still works.
//   D) Stage chips render on person rows; 60d+ last-contact renders in
//      the danger tone (fresh rows don't; NULL renders quiet "no
//      touchpoints yet", not red).
//   E) The What's-next strip is RETIRED (2026-09-30): Reminders replaced
//      next_steps. Even with overdue steps in the data, nothing renders.
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

// THE one tag list (lookups ids; key = the pre-merge specialty slug).
const TAGS = [
  { id: 't-realtor', label: 'Realtor', key: 'real-estate' },
  { id: 't-senior', label: 'Senior Living', key: 'senior-living' },
  { id: 't-mover', label: 'Mover', key: 'moving-company' },   // nobody carries it
]

const PARTNERS = [
  {
    id: 'p1', name: 'Karen Martinez', type: 'partner', locationId: 'loc-1',
    title: 'Agent', company: 'Meridian Realty', companyId: 'co1',
    tagIds: ['t-realtor'], stage: 'Active Partner',
    lastContactedAt: daysAgo(10), isDeleted: false,
    nextSteps: [
      { id: 'ns1', text: 'Send referral gift', date: dateOnly(-2), done: false },
      { id: 'ns2', text: 'Lunch re: summer listings', date: dateOnly(3), done: false },
      { id: 'ns3', text: 'Done thing', date: dateOnly(-30), done: true },
    ],
  },
  {
    // Realtor is their SECOND tag — the pre-merge filter (first specialty
    // only) could never find them under it.
    id: 'p2', name: 'Stale Sam', type: 'contact', locationId: 'loc-1',
    title: 'Broker', company: 'Meridian Realty', companyId: 'co1',
    tagIds: ['t-senior', 't-realtor'], stage: 'Building',
    lastContactedAt: daysAgo(90), isDeleted: false, nextSteps: [],
  },
  {
    id: 'p3', name: 'Warm Wendy', type: 'partner', locationId: 'loc-1',
    tagIds: [], stage: 'Reaching Out',
    lastContactedAt: null, isDeleted: false, nextSteps: [],
  },
  {
    id: 'p4', name: 'Just Met Jim', type: 'contact', locationId: 'loc-1',
    tagIds: [], stage: '',
    lastContactedAt: null, isDeleted: false, nextSteps: [],
  },
]

const COMPANIES = [
  { id: 'co1', name: 'Meridian Realty', industry: 'Real Estate', locationId: 'loc-1', isDeleted: false },
  // Nobody linked — under any filter it has no one to match through.
  { id: 'co2', name: 'Oak Movers', industry: 'Moving', locationId: 'loc-1', isDeleted: false },
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
        tags={TAGS}
        {...props}
      />
    )
  })
  await act(async () => {}) // flush the summary fetch
}

const list = () => host.querySelector('[data-testid="network-list"]') as HTMLElement
const rowNames = () => [...list().querySelectorAll('[data-rowtype]')].map(r => r.querySelector('p')!.textContent)
const button = (text: string) => [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text) as HTMLElement
const openFilters = async () => { await act(async () => { button('Filters').click() }) }
const tagOption = (labelStart: string) =>
  [...host.querySelectorAll('[data-testid="network-tag-options"] button')].find(b => (b.textContent || '').includes(labelStart)) as HTMLElement
const typeInto = async (el: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor((globalThis as any).window.HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
})

beforeEach(() => {
  vi.stubGlobal('localStorage', lsMock)
  lsStore.clear()
})
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  host?.remove()
  vi.unstubAllGlobals()
})

describe('A) mixed rows — square company, round person, no type labels', () => {
  it('a company is ONE row: square avatar + "N people"; a person is round', async () => {
    await mount()
    const companyRow = list().querySelector('[data-rowtype="company"]') as HTMLElement
    expect(companyRow).toBeTruthy()
    expect(companyRow.textContent).toContain('Meridian Realty')
    expect(companyRow.textContent).toContain('2 people')
    const sq = companyRow.querySelector('[data-avatar="company"]') as HTMLElement
    expect(sq.style.borderRadius).toBe(T.radius.control)   // SQUARE-ish, never a circle

    const personRow = list().querySelector('[data-rowtype="person"]') as HTMLElement
    expect(personRow).toBeTruthy()
    const round = personRow.querySelector('div') as HTMLElement
    expect(round.style.borderRadius).toBe(T.radius.round)  // 50%

    // The shape IS the affordance — no "Partner"/"Contact"/"Company" labels.
    expect(list().textContent).not.toContain('👤 Contact')
    expect(list().textContent).not.toMatch(/\bCompany\b/)
  })

  it('company subtitle counts its linked people', async () => {
    await mount()
    const companyRow = list().querySelector('[data-rowtype="company"]') as HTMLElement
    expect(companyRow.textContent).toContain('2 people · Real Estate')
  })

  it("a person's subtitle leads with their tags, by label", async () => {
    await mount()
    const sam = [...list().querySelectorAll('[data-rowtype="person"]')].find(r => r.textContent!.includes('Stale Sam'))!
    expect(sam.textContent).toContain('Senior Living, Realtor · Broker · Meridian Realty')
  })
})

describe('B) one flat list, sorted by name — no bands', () => {
  it('people and companies together, A→Z, with no group headings', async () => {
    await mount()
    expect(rowNames()).toEqual(['Just Met Jim', 'Karen Martinez', 'Meridian Realty', 'Oak Movers', 'Stale Sam', 'Warm Wendy'])
    expect(host.querySelector('[data-testid="network-companies-hidden"]')).toBeNull()
    expect(host.querySelector('[data-band]')).toBeNull()
    expect(host.textContent).not.toContain('Potential customers')
    expect(host.textContent).not.toContain('Just met · no intent yet')
  })

  it('per-row numbers are the rollup joins, not jsonb zeros', async () => {
    await mount()
    const karen = [...list().querySelectorAll('[data-rowtype]')].find(r => r.textContent!.includes('Karen'))!
    expect(karen.textContent).toContain('3 referred')
    expect(karen.textContent).toContain('$4,500')
  })
})

describe('C) the tag filter — searchable, any-of, over the one list', () => {
  it('offers only tags someone here carries, most-used first, with counts', async () => {
    await mount()
    await openFilters()
    const opts = [...host.querySelectorAll('[data-testid="network-tag-options"] button')].map(b => b.textContent)
    expect(opts).toEqual(['Realtor (2)', 'Senior Living (1)'])   // Mover: nobody carries it
  })

  it('the search box narrows the options', async () => {
    await mount()
    await openFilters()
    await typeInto(host.querySelector('[aria-label="Search tags"]') as HTMLInputElement, 'sen')
    const opts = [...host.querySelectorAll('[data-testid="network-tag-options"] button')].map(b => b.textContent)
    expect(opts).toEqual(['Senior Living (1)'])
    await typeInto(host.querySelector('[aria-label="Search tags"]') as HTMLInputElement, 'zzz')
    expect(host.querySelector('[data-testid="network-tag-options"]')!.textContent).toContain('No tag matches')
  })

  it('one click on Realtor shows both realtors — including the one whose Realtor tag is SECOND', async () => {
    await mount()
    await openFilters()
    await act(async () => { tagOption('Realtor').click() })
    // Meridian Realty stays: Karen and Sam work there. Oak Movers has no
    // one who matches, so it's hidden — and the screen says so.
    expect(rowNames()).toEqual(['Karen Martinez', 'Meridian Realty', 'Stale Sam'])
    expect(host.querySelector('[data-testid="network-companies-hidden"]')!.textContent).toMatch(/^1 company hidden/)
    // The pick shows as a removable chip outside the popover.
    expect(host.querySelector('[data-active-tag="t-realtor"]')!.textContent).toContain('Realtor')
    expect(button('Filters · 1')).toBeTruthy()
  })

  it('two picks are any-of, and removing the chip restores the full list', async () => {
    await mount()
    await openFilters()
    await act(async () => { tagOption('Senior Living').click() })
    expect(rowNames()).toEqual(['Meridian Realty', 'Stale Sam'])
    await act(async () => { tagOption('Realtor').click() })
    expect(rowNames()).toEqual(['Karen Martinez', 'Meridian Realty', 'Stale Sam'])
    await act(async () => { (host.querySelector('[aria-label="Remove tag filter Realtor"]') as HTMLElement).click() })
    await act(async () => { (host.querySelector('[aria-label="Remove tag filter Senior Living"]') as HTMLElement).click() })
    expect(rowNames()).toHaveLength(6)
    expect(host.querySelector('[data-testid="network-companies-hidden"]')).toBeNull()
  })

  it('a view saved before the merge (specFilter slug) maps onto the tag with that slug', async () => {
    lsStore.set('bee_network_saved_views', JSON.stringify({
      views: [{ id: 'v1', name: 'Realtors', filters: { stageFilter: '', specFilter: 'real-estate' } }],
      activeViewId: null,
    }))
    await mount()
    await act(async () => { button('Realtors').click() })
    expect(rowNames()).toEqual(['Karen Martinez', 'Meridian Realty', 'Stale Sam'])
  })

  it('a view saved now stores tag ids', async () => {
    await mount()
    await openFilters()
    await act(async () => { tagOption('Senior Living').click() })
    await act(async () => { button('+ Save view').click() })
    const nameBox = host.querySelector('[placeholder="View name"]') as HTMLInputElement
    await typeInto(nameBox, 'Senior')
    await act(async () => { button('Save').click() })
    const saved = JSON.parse(lsStore.get('bee_network_saved_views')!)
    expect(saved.views[0].filters).toEqual({ stageFilter: '', tagIds: ['t-senior'] })
  })

  it('a tag nobody at a company has hides every company, and the count says 2', async () => {
    await mount({ partners: PARTNERS.map(p => (p.id === 'p3' ? { ...p, tagIds: ['t-mover'] } : p)) })
    await openFilters()
    await act(async () => { tagOption('Mover').click() })
    expect(rowNames()).toEqual(['Warm Wendy'])   // Wendy works for no company
    expect(host.querySelector('[data-testid="network-companies-hidden"]')!.textContent).toMatch(/^2 companies hidden/)
  })

  it('the stage filter follows the same people-first rule', async () => {
    await mount()
    await openFilters()
    await act(async () => { button('Building').click() })
    expect(rowNames()).toEqual(['Meridian Realty', 'Stale Sam'])
    expect(host.querySelector('[data-testid="network-companies-hidden"]')!.textContent).toMatch(/^1 company hidden/)
  })

  it('the hidden count only counts companies the search box let through', async () => {
    await mount()
    await typeInto(host.querySelector('input[placeholder^="Search people"]') as HTMLInputElement, 'meridian')
    await openFilters()
    await act(async () => { tagOption('Realtor').click() })
    expect(host.querySelector('[data-testid="network-companies-hidden"]')).toBeNull()   // Oak Movers was already searched out
  })

  it('nobody tagged → the section says so instead of an empty list', async () => {
    await mount({ partners: PARTNERS.map(p => ({ ...p, tagIds: [] })) })
    await openFilters()
    expect(host.textContent).toContain('No one here is tagged yet')
  })
})

describe('D) stage chips + staleness', () => {
  it('person rows carry their pipeline stage chip', async () => {
    await mount()
    const chips = [...list().querySelectorAll('[data-stage-chip]')].map(c => c.textContent)
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

describe('E) the retired What’s-next strip', () => {
  it('renders nothing from next_steps any more — Reminders replaced it', async () => {
    await mount()
    expect(host.querySelector('[data-testid="whats-next"]')).toBeNull()
    expect(host.textContent).not.toContain('What’s next')
    expect(host.textContent).not.toContain('Send referral gift') // an overdue step in the data
    expect(host.textContent).not.toContain('overdue')
  })
})

describe('F) honest stats', () => {
  it('renders the real joined numbers once the summary resolves', async () => {
    await mount()
    const stats = host.querySelector('[data-testid="network-stats"]') as HTMLElement
    expect(stats.textContent).toContain('6')        // in network (4 people + 2 companies)
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
    const companyRow = list().querySelector('[data-rowtype="company"]') as HTMLElement
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
