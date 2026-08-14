// @vitest-environment happy-dom
//
// issue 223 — the component half. Mounts the REAL seat modals and reads what
// an owner would actually see on the confirm step, so the promise and the
// charge can't drift apart again behind a passing unit test.
//
// THE BUG: both modals rendered "Online payment isn't set up yet, so no card
// will be charged. Confirming records this purchase and Bee Organized will
// invoice you for it separately." — then /api/seats charged. These pin that
// the screen now says what will happen, using the SERVER's figure.
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

import { AddSeatsModal, InviteTeamMemberModal, SeatsContext } from '@/components/BeeHub'
import {
  seatCountsByTier,
  availableSeatsForTier,
  availableSeatRows,
  pendingInviteCount,
  invitableSeatIds,
} from '@/lib/seat-availability'

// No free seats anywhere, so the invite modal must BUY — which is the path
// that reaches the confirm step.
const SEATS: any[] = []
const INVITES: any[] = []

function seatsValue(seats = SEATS, pendingInvites = INVITES) {
  return {
    seats,
    setSeats: vi.fn(),
    pendingInvites,
    setPendingInvites: vi.fn(),
    seatCountsByTier: () => seatCountsByTier(seats, pendingInvites),
    availableSeatsByTier: () => availableSeatRows(seats, pendingInvites),
    availableSeatsByTierWithPending: (t: string) => availableSeatsForTier(seats, pendingInvites, t),
    pendingInviteCount: (t: string) => pendingInviteCount(pendingInvites, t),
    invitableSeatIds: () => invitableSeatIds(seats, pendingInvites),
  }
}

// The server's answer. Every test drives the screen through this and nothing
// else — the modal has no figure of its own to fall back on.
let quoteResponse: any = null
let quoteStatus = 200
let quoteUrls: string[] = []
let postBodies: any[] = []

beforeEach(() => {
  document.body.innerHTML = ''
  quoteUrls = []
  postBodies = []
  quoteStatus = 200
  quoteResponse = {
    cost: { total_cents: 21945, per_seat_cents: [21945], renewal_date: '2027-08-14', source: 'server' },
    billing: { will_charge: true, reason: null, lines: [] },
  }
  ;(globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
    const u = String(url)
    if (u.includes('/api/seats/quote')) {
      quoteUrls.push(u)
      return { ok: quoteStatus === 200, status: quoteStatus, json: async () => quoteResponse }
    }
    if (init?.body) postBodies.push(JSON.parse(init.body))
    return { ok: true, status: 200, json: async () => ({ id: 'seat-new', invite: { id: 'i' }, invite_url: 'https://x' }) }
  }) as any
})

function mount(node: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(node) })
  return { container, unmount: () => { act(() => { root.unmount() }); container.remove() } }
}

const withSeats = (ui: React.ReactElement) =>
  React.createElement(SeatsContext.Provider, { value: seatsValue() } as any, ui)

function clickText(container: HTMLElement, text: string) {
  const btn = Array.from(container.querySelectorAll('button')).find(b =>
    (b.textContent || '').includes(text),
  )
  if (!btn) throw new Error(`no button containing "${text}" — saw: ${
    Array.from(container.querySelectorAll('button')).map(b => b.textContent).join(' | ')}`)
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  return btn
}

function typeInto(container: HTMLElement, selector: string, value: string) {
  const el = container.querySelector(selector) as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

// Let the quote's promise chain settle.
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

// Drive AddSeatsModal to the confirm step.
async function addSeatsAtConfirm() {
  const view = mount(withSeats(
    <AddSeatsModal locationId="loc-ftl" paidThroughDate="2027-08-14" onClose={() => {}} onSeatsAdded={() => {}} />,
  ))
  clickText(view.container, 'Review order')
  await settle()
  return view
}

// Drive InviteTeamMemberModal to the confirm step (no free seats → buy).
async function inviteAtConfirm() {
  const view = mount(withSeats(
    <InviteTeamMemberModal locationId="loc-ftl" paidThroughDate="2027-08-14" onClose={() => {}} onInviteCreated={() => {}} />,
  ))
  typeInto(view.container, 'input[type="email"]', 'new@example.com')
  clickText(view.container, 'Buy & Send Invite')
  await settle()
  return view
}

const SURFACES: Array<[string, () => Promise<ReturnType<typeof mount>>]> = [
  ['AddSeatsModal', addSeatsAtConfirm],
  ['InviteTeamMemberModal', inviteAtConfirm],
]

// ── a paid tier shows the real figure and claims no free lunch ─────────
describe('issue 223 — a seat that will be charged', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  for (const [name, open] of SURFACES) {
    it(`${name} shows the server's exact figure`, async () => {
      view = await open()
      expect(view.container.textContent).toContain('$219.45')
    })

    it(`${name} no longer says no card will be charged`, async () => {
      view = await open()
      const txt = view.container.textContent || ''
      expect(txt).not.toMatch(/no card will be charged/i)
      expect(txt).not.toMatch(/Online payment isn.t set up yet/i)
      expect(txt).not.toMatch(/will invoice you for it separately/i)
    })

    it(`${name} renders the charge notice, not a free one`, async () => {
      view = await open()
      expect(view.container.querySelector('[data-testid="seat-notice-charge"]')).toBeTruthy()
      expect(view.container.querySelector('[data-testid="seat-notice-free_tier"]')).toBeNull()
    })

    it(`${name} puts the amount on the confirm button`, async () => {
      view = await open()
      const labels = Array.from(view.container.querySelectorAll('button')).map(b => b.textContent || '')
      // issue 225 — "about", because Stripe does this arithmetic, not us.
      expect(labels.some(l => l.includes('Confirm & Pay about $219.45'))).toBe(true)
    })

    it(`${name} shows the SAME figure in the order summary and the notice`, async () => {
      // issue 225 — the order-summary rows rendered with showCents:'auto',
      // which drops cents above $100. A $372.60 seat printed "$373" one row
      // above a notice reading "about $372.60": two numbers, one purchase, on
      // the screen where someone commits. Both halves now carry the cents.
      quoteResponse = {
        cost: { total_cents: 37260, per_seat_cents: [37260], renewal_date: '2027-08-14', source: 'server' },
        billing: { will_charge: true, reason: null, lines: [] },
      }
      view = await open()
      const txt = view.container.textContent || ''
      expect(txt).toContain('$372.60')
      // The rounded figure must appear nowhere on the screen.
      expect(txt).not.toMatch(/\$373\b/)
      // And it is on the total row specifically, not only inside the notice.
      const total = Array.from(view.container.querySelectorAll('span'))
        .find(s => (s.previousElementSibling?.textContent || '') === 'Order total')
      expect(total?.textContent?.trim()).toBe('$372.60')
    })

    it(`${name} asked the server rather than computing it`, async () => {
      view = await open()
      expect(quoteUrls.length).toBeGreaterThan(0)
      expect(quoteUrls[0]).toContain('/api/seats/quote')
      expect(quoteUrls[0]).toContain('location_id=loc-ftl')
    })
  }

  it('the figure on screen is the one the server sent, not a client multiply', async () => {
    // A total that no rate×quantity on this side would produce.
    quoteResponse = {
      cost: { total_cents: 13337, per_seat_cents: [13337], renewal_date: '2027-08-14', source: 'server' },
      billing: { will_charge: true, reason: null, lines: [] },
    }
    view = await addSeatsAtConfirm()
    expect(view.container.textContent).toContain('$133.37')
  })
})

// ── a $0 tier says free ───────────────────────────────────────────────
describe('issue 223 — a $0 tier', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  beforeEach(() => {
    quoteResponse = {
      cost: { total_cents: 0, per_seat_cents: [0], renewal_date: '2027-08-14', source: 'server' },
      billing: { will_charge: false, reason: 'zero_rate', lines: [] },
    }
  })

  for (const [name, open] of SURFACES) {
    it(`${name} says it is free`, async () => {
      view = await open()
      expect(view.container.querySelector('[data-testid="seat-notice-free_tier"]')).toBeTruthy()
      expect(view.container.textContent).toMatch(/at no cost/i)
    })

    it(`${name} does not ask for a payment on the button`, async () => {
      view = await open()
      const labels = Array.from(view.container.querySelectorAll('button')).map(b => b.textContent || '')
      expect(labels.some(l => /Confirm & Pay/.test(l))).toBe(false)
    })
  }
})

// ── no subscription says invoiced, NOT free ───────────────────────────
describe('issue 223 — a location with no Stripe subscription', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  beforeEach(() => {
    quoteResponse = {
      cost: { total_cents: 21945, per_seat_cents: [21945], renewal_date: '2027-08-14', source: 'server' },
      billing: { will_charge: false, reason: 'no_subscription', lines: [] },
    }
  })

  for (const [name, open] of SURFACES) {
    it(`${name} says it will be invoiced`, async () => {
      view = await open()
      expect(view.container.querySelector('[data-testid="seat-notice-invoiced"]')).toBeTruthy()
      expect(view.container.textContent).toMatch(/send you an invoice/i)
    })

    it(`${name} does NOT call the seat free — money is owed`, async () => {
      view = await open()
      const txt = view.container.textContent || ''
      expect(view.container.querySelector('[data-testid="seat-notice-free_tier"]')).toBeNull()
      expect(txt).not.toMatch(/at no cost/i)
      // and still names what is owed
      expect(txt).toContain('$219.45')
    })
  }
})

// ── the wait, and the refusal ─────────────────────────────────────────
describe('issue 223 — before the quote lands', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  it('shows a working state and offers no Confirm button until the figure arrives', () => {
    // Never resolves — the in-flight state.
    ;(globalThis as any).fetch = vi.fn(() => new Promise(() => {})) as any
    view = mount(withSeats(
      <AddSeatsModal locationId="loc-ftl" paidThroughDate="2027-08-14" onClose={() => {}} onSeatsAdded={() => {}} />,
    ))
    clickText(view.container, 'Review order')
    const txt = view.container.textContent || ''
    expect(txt).toMatch(/working out your cost/i)
    const labels = Array.from(view.container.querySelectorAll('button')).map(b => b.textContent || '')
    expect(labels.some(l => /Confirm/.test(l))).toBe(false)
  })

  it('a failed quote blocks the purchase instead of defaulting to "no charge"', async () => {
    quoteStatus = 500
    quoteResponse = { error: 'could not quote this seat' }
    view = await addSeatsAtConfirm()
    const txt = view.container.textContent || ''
    expect(txt).toMatch(/couldn.t work out the cost/i)
    expect(txt).not.toMatch(/no card will be charged/i)
    const labels = Array.from(view.container.querySelectorAll('button')).map(b => b.textContent || '')
    expect(labels.some(l => /Confirm/.test(l))).toBe(false)
  })
})

// ── the client stopped sending its own money math ─────────────────────
describe('issue 223 — the client no longer computes a cost', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  it('AddSeatsModal posts no prorated_cost', async () => {
    view = await addSeatsAtConfirm()
    clickText(view.container, 'Confirm & Pay')
    await settle()
    expect(postBodies.length).toBeGreaterThan(0)
    expect(postBodies[0]).not.toHaveProperty('prorated_cost')
  })

  it('InviteTeamMemberModal posts no prorated_cost', async () => {
    view = await inviteAtConfirm()
    clickText(view.container, 'Confirm & Pay')
    await settle()
    expect(postBodies.length).toBeGreaterThan(0)
    expect(postBodies[0]).not.toHaveProperty('prorated_cost')
  })

  it('the form step quotes no computed prorated amount', async () => {
    const v = mount(withSeats(
      <AddSeatsModal locationId="loc-ftl" paidThroughDate="2027-08-14" onClose={() => {}} onSeatsAdded={() => {}} />,
    ))
    const txt = v.container.textContent || ''
    // The old summary row put a client-computed figure right after the
    // label: "Prorated to Aug 14, 2027" / "$219.45". The rate ("$400/yr
    // each") is fine — it is a fact about the tier, not a claim about this
    // purchase.
    expect(txt).not.toMatch(/Prorated to [A-Z][a-z]{2} \d/)
    expect(txt).not.toMatch(/Review order — \$/)
    v.unmount()
  })

  it('the form step avoids the word "prorated" entirely — wrong register for the audience', async () => {
    const v = mount(withSeats(
      <AddSeatsModal locationId="loc-ftl" paidThroughDate="2027-08-14" onClose={() => {}} onSeatsAdded={() => {}} />,
    ))
    expect((v.container.textContent || '').toLowerCase()).not.toContain('prorat')
    v.unmount()
  })
})
