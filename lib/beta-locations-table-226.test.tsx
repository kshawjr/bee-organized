// @vitest-environment happy-dom
//
// lib/beta-locations-table-226.test.tsx — issue 226 step 3.
//
// The Locations screen's table. The assertions that matter are the money and
// the empty states: this is the screen an operator reads to decide who to
// chase, and a wrong or ambiguous figure here is worse than no screen.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
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

import { LocationsTable, TierPricesContext } from '@/components/BeeHub'
import { calculateSeatTotal } from '@/lib/subscription-math'

// The LIVE catalog, as production holds it. It differs from
// DEFAULT_TIER_PRICES on exactly one tier — Honey Watcher is $0 in
// tier_prices and $50 in the fallback — and that difference is the whole
// point of the "$0 is a real figure" case below.
const LIVE_PRICES = { owner: 550, manager: 400, light: 200, readonly: 0 }

// Production shapes. Fort Lauderdale carries the co-owner case that makes
// price × count wrong; Kansas City reaches the same total by another route.
const FTL = {
  id: 'ftl', name: 'Fort Lauderdale', state: 'FL', owner: 'A Owner',
  crmStatus: 'active', lifecycle_status: 'active', subscription_status: 'active',
  paid_through_date: '2027-08-14', stripe_subscription_id: 'sub_ftl',
  seatCount: 3, seatLines: [{ tier: 'owner', count: 2 }, { tier: 'manager', count: 1 }],
}
const KC = {
  id: 'kc', name: 'Kansas City', state: 'MO', owner: 'B Owner',
  crmStatus: 'active', lifecycle_status: 'active', subscription_status: 'active',
  paid_through_date: '2027-05-01', stripe_subscription_id: 'sub_kc',
  seatCount: 3, seatLines: [{ tier: 'owner', count: 1 }, { tier: 'manager', count: 2 }],
}
// Active, no Stripe subscription, prepaid into the future — the cohort.
const OMAHA = {
  id: 'omaha', name: 'Omaha', state: 'NE', owner: 'C Owner',
  crmStatus: 'active', lifecycle_status: 'active', subscription_status: 'active',
  paid_through_date: '2027-05-01', stripe_subscription_id: null,
  seatCount: 1, seatLines: [{ tier: 'owner', count: 1 }],
}
// Onboarding, never paid for anything, no seats.
const ONBOARDING = {
  id: 'onb', name: 'Fresh Franchise', state: 'TX', owner: null,
  crmStatus: 'onboarding', lifecycle_status: 'onboarding', subscription_status: 'deferred',
  paid_through_date: null, stripe_subscription_id: null,
  seatCount: 0, seatLines: [],
}
// A roster of Watchers only. tier_prices puts Watcher at $0, so this location
// genuinely bills zero — a real measurement, not a missing one.
const WATCHERS = {
  id: 'watch', name: 'Watcher Only', state: 'OR', owner: 'D Owner',
  crmStatus: 'active', lifecycle_status: 'active', subscription_status: 'active',
  paid_through_date: '2027-09-01', stripe_subscription_id: 'sub_w',
  seatCount: 2, seatLines: [{ tier: 'readonly', count: 2 }],
}

const FLEET = [FTL, KC, OMAHA, ONBOARDING, WATCHERS]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function mount(node: React.ReactNode) {
  act(() => {
    root.render(
      <TierPricesContext.Provider value={{ livePrices: LIVE_PRICES, getTierPrice: (t: string) => (LIVE_PRICES as any)[t] ?? 0 }}>
        {node}
      </TierPricesContext.Provider>,
    )
  })
}

function render(props: any = {}) {
  mount(<LocationsTable locations={FLEET} onSelect={() => {}} {...props} />)
}

const rowFor = (name: string) =>
  Array.from(container.querySelectorAll('tbody tr'))
    .find(tr => tr.textContent?.includes(name)) as HTMLTableRowElement | undefined

const cells = (name: string) =>
  Array.from(rowFor(name)?.querySelectorAll('td') || []).map(td => td.textContent?.trim())

describe('the per-year figure', () => {
  // The rule that has been restated wrong four times: a location's 2nd owner
  // seat bills at the MANAGER rate, so price × count is wrong for every
  // two-owner location. Only calculateSeatTotal knows that.
  it('prices Fort Lauderdale with the co-owner rule, not a multiply', () => {
    render()
    expect(cells('Fort Lauderdale')?.at(-1)).toBe('$1,350')
    // The multiply an earlier surface used: 550×2 + 400 = $1,500. Not this.
    expect(cells('Fort Lauderdale')?.at(-1)).not.toBe('$1,500')
  })

  it('agrees with calculateSeatTotal for every location that has seats', () => {
    render()
    for (const loc of FLEET.filter(l => l.seatLines.length > 0)) {
      const expected = calculateSeatTotal(loc.seatLines as any, LIVE_PRICES)
      const shown = cells(loc.name)?.at(-1)
      expect(shown).toBe(`$${expected.toLocaleString()}`)
    }
  })

  it('reaches $1,350 by both routes — 2 owners + 1 manager, and 1 + 2', () => {
    render()
    expect(cells('Fort Lauderdale')?.at(-1)).toBe('$1,350')
    expect(cells('Kansas City')?.at(-1)).toBe('$1,350')
  })
})

describe('a location with no seats', () => {
  it('shows an em dash for seats and for per-year, never a zero', () => {
    render()
    const c = cells('Fresh Franchise')!
    expect(c.at(-3)).toBe('—')   // seats
    expect(c.at(-1)).toBe('—')   // per year
    expect(c.at(-1)).not.toBe('$0')
  })

  it('shows an em dash for renews rather than inventing a legacy date', () => {
    // resolveLocationRenewalDate would return March 1 here. That helper is
    // right for pricing a seat and wrong for a list — it would stamp a
    // confident renewal date on a location that has never paid anything.
    render()
    expect(cells('Fresh Franchise')?.at(-2)).toBe('—')
    expect(rowFor('Fresh Franchise')?.textContent).not.toContain('March 1')
  })
})

describe('a real $0 is distinguishable from no seats', () => {
  it('shows $0 for an all-Watcher roster, because that is the true figure', () => {
    render()
    const c = cells('Watcher Only')!
    expect(c.at(-3)).toBe('2')    // seats — it HAS seats
    expect(c.at(-1)).toBe('$0')   // …and they cost nothing
  })
})

describe('billing state', () => {
  it('labels each row from the classifier', () => {
    render()
    expect(rowFor('Fort Lauderdale')?.textContent).toContain('Billing normally')
    expect(rowFor('Omaha')?.textContent).toContain('Owe money later')
    expect(rowFor('Fresh Franchise')?.textContent).toContain('Not live yet')
  })

  // The chips and the column read one classification map, so a chip count can
  // never disagree with the rows it filters to.
  it('chip counts match the rows they filter to', () => {
    render()
    const chip = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('Billing normally'))!
    expect(chip.textContent).toContain('3')      // FTL, KC, Watcher Only
    act(() => { chip.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelectorAll('tbody tr')).toHaveLength(3)
  })

  it('a canceled subscription reads as an alarm, not as Not live yet', () => {
    const canceled = { ...FTL, id: 'x', name: 'Cancelled Co', subscription_status: 'canceled', paid_through_date: null }
    mount(<LocationsTable locations={[canceled]} onSelect={() => {}} />)
    expect(rowFor('Cancelled Co')?.textContent).toContain('Active but not billing')
    expect(rowFor('Cancelled Co')?.textContent).not.toContain('Not live yet')
  })
})

describe('search and row selection', () => {
  it('matches on owner as well as location name', () => {
    render()
    const input = container.querySelector('input') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'C Owner')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(container.querySelector('tbody tr')?.textContent).toContain('Omaha')
  })

  it('opens the detail sheet for the row that was clicked', () => {
    const onSelect = vi.fn()
    mount(<LocationsTable locations={FLEET} onSelect={onSelect} />)
    act(() => { rowFor('Kansas City')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].id).toBe('kc')
  })
})

// The Dashboard's Locations Overview navigates here pre-filtered. Deleting
// the chip strip must not silently kill that button.
describe('the dashboard status deep-link', () => {
  it('filters by lifecycle status and says so visibly', () => {
    render({ statusFilter: 'onboarding' })
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(container.textContent).toContain('Showing')
    expect(container.textContent).toContain('Onboarding')
  })

  it('offers a way out', () => {
    const onClear = vi.fn()
    render({ statusFilter: 'onboarding', onClearStatusFilter: onClear })
    const btn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent === 'Show all')!
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onClear).toHaveBeenCalled()
  })

  it('shows everything when no status is passed', () => {
    render()
    expect(container.querySelectorAll('tbody tr')).toHaveLength(FLEET.length)
  })
})
