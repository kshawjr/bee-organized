// @vitest-environment happy-dom
//
// lib/beta-seat-roster-ui-226.test.tsx — issue 226 step 5.
//
// The roster and the admin Add-a-seat path. Two things are worth pinning
// hardest: that the headline figure on every row is the ANNUAL rate rather
// than the historical prorated_cost, and that the first admin surface able to
// move money says whose money it is before it moves.

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

import { SeatRosterSection, AdminAddSeatModal, TierPricesContext, LocationUsersContext } from '@/components/BeeHub'

const LIVE_PRICES = { owner: 550, manager: 400, light: 200, readonly: 0 }
// The roster resolves seat.user_id through LocationUsersContext, which the
// elevated page feed populates for every location.
const HUB_USERS = [{ id: 'u1', name: 'Lynette Ewy', email: 'lewy@x.com', locationId: 'loc-ftl' }]
const LOC = { id: 'loc-ftl', name: 'Fort Lauderdale' }

// Fort Lauderdale live: owner assigned, owner OPEN, manager OPEN, one
// unaccepted manager invite.
const SEATS = [
  { id: 'own-1', tier: 'owner',   user_id: 'u1', status: 'active', is_primary: true,  prorated_cost: 55000, added_at: '2026-08-14', scheduled_removal_at: null },
  { id: 'own-2', tier: 'owner',   user_id: null, status: 'active', is_primary: false, prorated_cost: 40000, added_at: '2026-08-15', scheduled_removal_at: null },
  { id: 'mgr-1', tier: 'manager', user_id: null, status: 'active', is_primary: false, prorated_cost: 40000, added_at: '2026-08-16', scheduled_removal_at: null },
]
const INVITES = [
  { id: 'inv-1', tier: 'manager', email: 'newhire@x.com', full_name: 'New Hire', accepted_at: null, created_at: '2026-08-13T10:00:00Z', invite_expires_at: '2099-01-01T00:00:00Z' },
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let posts: any[]

const QUOTE = {
  cost: { total_cents: 41200, annual_total_cents: 40000, renewal_date: '2027-08-14' },
  billing: { will_charge: true, reason: null },
}

beforeEach(() => {
  posts = []
  ;(globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
    const u = String(url)
    if (init?.method === 'POST') {
      posts.push({ url: u, body: init.body ? JSON.parse(init.body) : null })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    if (u.includes('/api/seats/quote')) return { ok: true, json: async () => QUOTE }
    if (u.includes('/api/seats')) return { ok: true, json: async () => SEATS }
    if (u.includes('/api/pending_invites')) return { ok: true, json: async () => INVITES }
    return { ok: true, json: async () => [] }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function mount(node: React.ReactNode) {
  await act(async () => {
    root.render(
      <TierPricesContext.Provider value={{ livePrices: LIVE_PRICES, getTierPrice: (t: string) => (LIVE_PRICES as any)[t] ?? 0 }}>
        <LocationUsersContext.Provider value={HUB_USERS}>
          {node}
        </LocationUsersContext.Provider>
      </TierPricesContext.Provider>,
    )
  })
}

const roster = (props: any = {}) =>
  mount(<SeatRosterSection location={LOC} role="super_admin" {...props} />)

// Clickable seat rows. happy-dom normalises inline styles, so match on the
// property name rather than the exact "cursor:pointer" string.
const seatRowFor = (text: string) =>
  Array.from(container.querySelectorAll('div'))
    .find(d => d.getAttribute('style')?.includes('cursor') && d.textContent?.includes(text)) as HTMLElement | undefined

const buttonContaining = (text: string) =>
  Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes(text))

const buttonByText = (text: string) =>
  Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text)

const click = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('the three states read differently', () => {
  it('shows held, invited and empty on the same roster', async () => {
    await roster()
    expect(container.textContent).toContain('Active')
    expect(container.textContent).toContain('Invited')
    expect(container.textContent).toContain('Empty')
    expect(container.textContent).toContain('1 held · 1 invited · 1 empty')
  })

  it('names the invitee and the date the invitation went out', async () => {
    await roster()
    expect(container.textContent).toContain('New Hire')
    expect(container.textContent).toContain('Invited Aug 13, 2026 — not accepted yet')
  })

  // The state that earns its own place: it reads as a standing cost with no
  // story that ends by itself.
  it('says an empty seat is nobody-invited AND still billed', async () => {
    await roster()
    expect(container.textContent).toContain('Nobody in this seat')
    expect(container.textContent).toContain('Nobody invited yet — still billed')
  })
})

describe('what a seat costs', () => {
  it('headlines the ANNUAL rate, with the co-owner rule applied', async () => {
    await roster()
    // owner #1 at the owner rate, owner #2 at the manager rate, manager at its own
    expect(container.textContent).toContain('$550/yr')
    expect(container.textContent).toContain('$400/yr')
    expect(container.textContent).toContain('$1,350/yr')   // the roster header total
  })

  it('resolves a held seat to the person holding it', async () => {
    await roster()
    expect(container.textContent).toContain('Lynette Ewy')
  })

  it('keeps prorated_cost off the headline and in the row detail', async () => {
    await roster()
    // Not on the collapsed row…
    expect(container.textContent).not.toContain('Charged when added')
    // …and there when the row is opened. $550.00 is what was CHARGED; $550/yr
    // is what the seat COSTS. Both are true and only one is the headline.
    await click(seatRowFor('Lynette Ewy')!)
    expect(container.textContent).toContain('Charged when added: $550.00')
    expect(container.textContent).toContain('$550/yr')
  })
})

describe('resend', () => {
  it('offers resend on an invited row and POSTs to that invite', async () => {
    await roster()
    // Open the invited row.
    await click(seatRowFor('New Hire')!)
    const btn = buttonByText('Resend invitation')!
    expect(btn).toBeTruthy()
    await click(btn)
    expect(posts.some(p => p.url.includes('/api/pending_invites/inv-1/resend'))).toBe(true)
  })
})

describe('the free-seat lever', () => {
  it('is offered to super_admin', async () => {
    await roster({ role: 'super_admin' })
    expect(buttonByText('🎁 Give a free seat')).toBeTruthy()
  })

  it('is not offered to corporate — the route is super_admin only', async () => {
    await roster({ role: 'corporate' })
    expect(buttonByText('🎁 Give a free seat')).toBeUndefined()
    // Adding a seat is still available; it is a purchase, not a comp.
    expect(buttonByText('+ Add a seat')).toBeTruthy()
  })
})

// The first admin surface that can move money.
describe('Add a seat', () => {
  const addSeat = () => mount(<AdminAddSeatModal location={LOC} onClose={() => {}} onAdded={() => {}} />)

  it('says whose account is billed, before anything else', async () => {
    await addSeat()
    expect(container.textContent).toContain('bills')
    expect(container.textContent).toContain('Fort Lauderdale')
    expect(container.textContent).toContain('not yours')
  })

  it('keeps that line on the confirm step too', async () => {
    await addSeat()
    await click(buttonByText('Review')!)
    expect(container.textContent).toContain('not yours')
  })

  it('shows the server figure and issue 223’s notice before confirming', async () => {
    await addSeat()
    await click(buttonByText('Review')!)
    // The heading and the confirm label both come from seatChargeNotice, and
    // both hedge with "about" (issue 225) because Stripe does the final sum.
    expect(container.textContent).toContain('about $412.00')
    // PaymentConfirmStep appends its own arrow, so match on the label text.
    expect(buttonContaining('Confirm & Pay about $412.00')).toBeTruthy()
  })

  it('never offers the owner tier — the co-owner path is not a purchase here', async () => {
    await addSeat()
    expect(container.textContent).not.toContain('Zee Bee')
  })

  it('POSTs tier and quantity to /api/seats and no price', async () => {
    await addSeat()
    await click(buttonByText('Review')!)
    await click(buttonContaining('Confirm & Pay about $412.00')!)
    const post = posts.find(p => p.url === '/api/seats')!
    expect(post).toBeTruthy()
    expect(post.body).toEqual({ location_id: 'loc-ftl', tier: 'manager', quantity: 1 })
    // issue 217 — the client does not send money math. The server prices it.
    expect(post.body).not.toHaveProperty('prorated_cost')
  })
})
