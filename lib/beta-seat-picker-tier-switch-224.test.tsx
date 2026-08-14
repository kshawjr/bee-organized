// @vitest-environment happy-dom
//
// issue 224 — the component half. Mounts the REAL seat modals and reads the
// price beside the tier picker, which is where Kevin was standing when he
// asked why the number he was shown wasn't the number he'd pay.
//
// THE PROPERTY UNDER THE MOST PRESSURE IS THE SWITCH. Three tiers means
// switching between them means switching quotes, and the figure that is
// conveniently to hand during the wait — the tier the owner just left — is
// precisely the wrong number to paint. A wrong number on screen is what this
// whole arc has been about, so it gets its own describe block.
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

// No free seats anywhere, so the invite modal must BUY — the path that shows
// a price beside the picker.
function seatsValue(seats: any[] = [], pendingInvites: any[] = []) {
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

// The server's answer, PER TIER — the picker asks a different question for
// each tier and these tests care which answer came back for which.
type QuoteReply = { status?: number; body: any }
let repliesByTier: Record<string, QuoteReply> = {}
let held: Record<string, (r: QuoteReply) => void> = {}
let heldTiers: string[] = []
let quoteUrls: string[] = []

const paidQuote = (totalCents: number, annualCents: number, renewal = '2027-08-10') => ({
  body: {
    cost: {
      total_cents: totalCents,
      annual_total_cents: annualCents,
      per_seat_cents: [totalCents],
      renewal_date: renewal,
      source: 'server',
    },
    billing: { will_charge: true, reason: null, lines: [] },
  },
})

beforeEach(() => {
  document.body.innerHTML = ''
  quoteUrls = []
  held = {}
  heldTiers = []
  repliesByTier = {
    manager:  paidQuote(37260, 40000),
    readonly: paidQuote(4657, 5000),
    light:    paidQuote(18630, 20000),
  }
  ;(globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
    const u = String(url)
    if (u.includes('/api/seats/quote')) {
      quoteUrls.push(u)
      const tier = new URL(u, 'http://x').searchParams.get('tier') || ''
      // A tier listed in heldTiers never answers until the test releases it —
      // that is the in-between state.
      if (heldTiers.includes(tier)) {
        return await new Promise<any>(resolve => {
          held[tier] = (r: QuoteReply) => resolve({ ok: (r.status ?? 200) === 200, status: r.status ?? 200, json: async () => r.body })
        })
      }
      const r = repliesByTier[tier] || { status: 500, body: { error: 'no reply configured' } }
      return { ok: (r.status ?? 200) === 200, status: r.status ?? 200, json: async () => r.body }
    }
    return { ok: true, status: 200, json: async () => ({ id: 'seat-new', invite: { id: 'i' }, invite_url: 'https://x' }) }
  }) as any
})

function mount(node: React.ReactElement, seats: any[] = []) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(React.createElement(SeatsContext.Provider, { value: seatsValue(seats) } as any, node))
  })
  return { container, unmount: () => { act(() => { root.unmount() }); container.remove() } }
}

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

function clickText(container: HTMLElement, text: string) {
  const btn = Array.from(container.querySelectorAll('button')).find(b =>
    (b.textContent || '').includes(text),
  )
  if (!btn) throw new Error(`no button containing "${text}" — saw: ${
    Array.from(container.querySelectorAll('button')).map(b => b.textContent).join(' | ')}`)
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  return btn
}

const pickerToday  = (c: HTMLElement) => c.querySelector('[data-testid="seat-picker-today"]')?.textContent || ''
const pickerRenews = (c: HTMLElement) => c.querySelector('[data-testid="seat-picker-renews"]')?.textContent || ''
const pickerKind   = (c: HTMLElement) => {
  const el = c.querySelector('[data-testid^="seat-picker-price-"]')
  return el ? (el.getAttribute('data-testid') || '').replace('seat-picker-price-', '') : null
}

async function openAddSeats() {
  const view = mount(<AddSeatsModal locationId="loc-ftl" onClose={() => {}} onSeatsAdded={() => {}} />)
  await settle()
  return view
}

async function openInvite() {
  const view = mount(<InviteTeamMemberModal locationId="loc-ftl" onClose={() => {}} onInviteCreated={() => {}} />)
  await settle()
  return view
}

const SURFACES: Array<[string, () => Promise<ReturnType<typeof mount>>]> = [
  ['AddSeatsModal', openAddSeats],
  ['InviteTeamMemberModal', openInvite],
]

// ── both numbers, on the picker ───────────────────────────────────────
// issue 225 — the today figure now reads "About $372.60 today". Stripe
// settles that sum to the second against its own period while we work it out
// in whole days, so the picker forecasts it rather than quoting it. The
// annual line is untouched: it is the catalog price, which nothing prorates.
describe('issue 224 — the picker names what is charged today AND what renews', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  for (const [name, open] of SURFACES) {
    it(`${name} shows the server's figure for the selected tier`, async () => {
      view = await open()
      expect(pickerToday(view.container)).toBe('About $372.60 today')
    })

    it(`${name} shows the annual price with the renewal date`, async () => {
      view = await open()
      expect(pickerRenews(view.container)).toBe('Then $400 a year, starting Aug 10, 2027')
    })

    it(`${name} no longer defers the figure to a later screen`, async () => {
      view = await open()
      const txt = view.container.textContent || ''
      expect(txt).not.toMatch(/We.ll show you that (exact )?amount/i)
      expect(txt).not.toMatch(/before anything is charged/i)
    })

    it(`${name} asked the server on the FORM step, not only on the way to confirm`, async () => {
      view = await open()
      expect(quoteUrls.length).toBe(1)
      expect(quoteUrls[0]).toContain('/api/seats/quote')
      expect(quoteUrls[0]).toContain('tier=manager')
    })

    it(`${name} keeps the word "prorated" off the screen`, async () => {
      view = await open()
      expect((view.container.textContent || '').toLowerCase()).not.toContain('prorat')
    })
  }
})

// ── the figure is not computed here ───────────────────────────────────
describe('issue 224 — no figure is computed client-side', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  it('renders a total no rate × quantity on this side could produce', async () => {
    // TierPricesContext is absent, so every client-side rate is 0 here. A
    // figure on screen can therefore only have come from the server.
    repliesByTier.manager = paidQuote(13337, 99900)
    view = await openAddSeats()
    expect(pickerToday(view.container)).toBe('About $133.37 today')
    expect(pickerRenews(view.container)).toContain('$999')
  })

  it('the annual figure tracks the SERVER, not the tier price × quantity', async () => {
    // Two seats, and the server says the pair renews at $400 total — the
    // co-owner shape, where a client multiply would say twice that.
    repliesByTier.manager = paidQuote(37260, 40000)
    view = await openAddSeats()
    clickText(view.container, '+')
    await settle()
    expect(quoteUrls.some(u => u.includes('quantity=2'))).toBe(true)
    expect(pickerRenews(view.container)).toBe('Then $400 a year, starting Aug 10, 2027')
  })

  it('shows NO figure at all when the server will not give one', async () => {
    repliesByTier.manager = { status: 500, body: { error: 'could not quote this seat' } }
    view = await openAddSeats()
    expect(pickerKind(view.container)).toBe('error')
    expect(pickerToday(view.container)).not.toMatch(/\$/)
    expect(pickerRenews(view.container)).not.toMatch(/\$/)
  })
})

// ── THE SWITCH ────────────────────────────────────────────────────────
describe('issue 224 — switching tiers never shows the previous tier\'s number', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  it('the old figure is gone the instant the new tier is selected', async () => {
    heldTiers = ['readonly']           // Watcher's quote will not answer yet
    view = await openAddSeats()
    expect(pickerToday(view.container)).toBe('About $372.60 today')

    clickText(view.container, 'Honey Watcher')
    await settle()

    // Mid-switch: the Manager figure must be off the screen entirely, and no
    // other figure may have taken its place.
    const txt = view.container.textContent || ''
    expect(txt).not.toContain('$372.60')
    expect(txt).not.toContain('$400')
    expect(pickerKind(view.container)).toBe('pending')
    expect(pickerToday(view.container)).toMatch(/working out your cost/i)
  })

  it('the new tier\'s own figure lands when the server answers', async () => {
    heldTiers = ['readonly']
    view = await openAddSeats()
    clickText(view.container, 'Honey Watcher')
    await settle()

    heldTiers = []
    act(() => { held.readonly({ body: repliesByTier.readonly.body }) })
    await settle()

    expect(pickerToday(view.container)).toBe('About $46.57 today')
    expect(pickerRenews(view.container)).toBe('Then $50 a year, starting Aug 10, 2027')
  })

  it('a late answer for the tier the owner LEFT cannot land on the tier they are on', async () => {
    heldTiers = ['manager']
    view = await openAddSeats()
    expect(pickerKind(view.container)).toBe('pending')

    clickText(view.container, 'Honey Watcher')
    await settle()
    expect(pickerToday(view.container)).toBe('About $46.57 today')

    // Manager's slow quote finally arrives — for a tier that is no longer
    // selected. It is filed, not displayed.
    act(() => { held.manager({ body: repliesByTier.manager.body }) })
    await settle()
    expect(pickerToday(view.container)).toBe('About $46.57 today')
    expect(view.container.textContent || '').not.toContain('$372.60')
  })

  it('switching back is instant — a tier is quoted once and the answer is kept', async () => {
    view = await openAddSeats()
    expect(quoteUrls.length).toBe(1)

    clickText(view.container, 'Honey Watcher')
    await settle()
    expect(quoteUrls.length).toBe(2)

    clickText(view.container, 'Hive Manager')
    await settle()
    // No third round trip, and no wait state on the way back.
    expect(quoteUrls.length).toBe(2)
    expect(pickerToday(view.container)).toBe('About $372.60 today')
  })

  it('only the tier actually selected is quoted — the picker does not ask for all three', async () => {
    view = await openAddSeats()
    expect(quoteUrls.length).toBe(1)
    expect(quoteUrls.every(u => u.includes('tier=manager'))).toBe(true)
    // The deferred Worker Bee tier is never asked about at all.
    expect(quoteUrls.some(u => u.includes('tier=light'))).toBe(false)
  })
})

// ── the six issue-223 cases still read differently ON THE PICKER ──────
describe('issue 224 — the six cases stay six on the picker', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  const CASES: Array<[string, any, RegExp, RegExp]> = [
    ['charge', paidQuote(37260, 40000).body, /^About \$372\.60 today$/, /Then \$400 a year, starting Aug 10, 2027/],
    ['charge_unpriced', {
      cost: { total_cents: null, annual_total_cents: 40000, per_seat_cents: null, renewal_date: null, unpriced_reason: 'no_renewal_anchor', source: 'server' },
      billing: { will_charge: true, reason: null, lines: [] },
    }, /worked out when you pay/i, /Then \$400 a year at your renewal/],
    ['charge_zero_today', {
      cost: { total_cents: 0, annual_total_cents: 40000, per_seat_cents: [0], renewal_date: '2027-08-10', source: 'server' },
      billing: { will_charge: true, reason: null, lines: [] },
    }, /^Nothing to pay today$/, /Then \$400 a year, starting Aug 10, 2027/],
    ['free_tier', {
      cost: { total_cents: 0, annual_total_cents: 0, per_seat_cents: [0], renewal_date: '2027-08-10', source: 'server' },
      billing: { will_charge: false, reason: 'zero_rate', lines: [] },
    }, /^Free$/, /free at renewal too/i],
    ['covered', {
      cost: { total_cents: 37260, annual_total_cents: 40000, per_seat_cents: [37260], renewal_date: '2027-08-10', source: 'server' },
      billing: { will_charge: false, reason: 'non_paying', lines: [] },
    }, /^Nothing to pay$/, /billed separately/i],
    ['invoiced', {
      cost: { total_cents: 37260, annual_total_cents: 40000, per_seat_cents: [37260], renewal_date: '2027-08-10', source: 'server' },
      billing: { will_charge: false, reason: 'no_subscription', lines: [] },
    }, /\$372\.60 — we.ll invoice you/, /Then \$400 a year, starting Aug 10, 2027/],
  ]

  for (const [kind, body, today, renews] of CASES) {
    it(`${kind} reads as itself`, async () => {
      repliesByTier.manager = { body }
      view = await openInvite()
      expect(pickerKind(view.container)).toBe(kind)
      expect(pickerToday(view.container)).toMatch(today)
      expect(pickerRenews(view.container)).toMatch(renews)
    })
  }

  it('the six render six distinct labels, not one', async () => {
    const seen = new Set<string>()
    for (const [, body] of CASES) {
      repliesByTier.manager = { body }
      const v = await openInvite()
      seen.add(`${pickerToday(v.container)}||${pickerRenews(v.container)}`)
      v.unmount()
    }
    expect(seen.size).toBe(CASES.length)
  })

  it('a location with no subscription is never called free on the picker', async () => {
    repliesByTier.manager = { body: CASES.find(c => c[0] === 'invoiced')![1] }
    view = await openInvite()
    const txt = `${pickerToday(view.container)} ${pickerRenews(view.container)}`
    expect(txt).not.toMatch(/free/i)
    expect(txt).toContain('$372.60')
  })

  it('a location with no paid_through_date names no figure and invents no date', async () => {
    repliesByTier.manager = { body: CASES.find(c => c[0] === 'charge_unpriced')![1] }
    view = await openInvite()
    expect(pickerToday(view.container)).not.toMatch(/\$/)
    // The legacy March 1 fallback used to be formatted client-side here.
    expect(view.container.textContent || '').not.toMatch(/Mar 1/)
  })
})

// ── the legacy March 1 fallback is out of the seat flow entirely ──────
// It was found four times, across issues 216, 217, 223 and 224:
// legacyFixedRenewalDate belongs to the pre-Stripe cohort and is nobody's
// default, so a location with no paid_through_date was reading a renewal date
// that is not its own. Every remaining seat-flow surface now takes the date
// from the quote or names none. ScheduleRemovalModal keeps the helper — it
// pre-fills a date input before any quote exists — and issue 216 pins it there.
describe('issue 224 — no seat surface invents a renewal date', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  const noAnchor = {
    cost: { total_cents: null, annual_total_cents: 40000, per_seat_cents: null, renewal_date: null, unpriced_reason: 'no_renewal_anchor', source: 'server' },
    billing: { will_charge: true, reason: null, lines: [] },
  }

  it('the AddSeats header states the quote\'s date, not one it worked out', async () => {
    view = await openAddSeats()
    expect(view.container.textContent).toContain('before your renewal on Aug 10, 2027')
  })

  it('…and drops the clause entirely when the location has no renewal date', async () => {
    repliesByTier.manager = { body: noAnchor }
    view = await openAddSeats()
    const txt = view.container.textContent || ''
    expect(txt).toContain('before your renewal.')
    expect(txt).not.toMatch(/Mar 1/)
    // Still a sentence, not a gap where a date used to be.
    expect(txt).toContain("Today you'd only pay for what's left before your renewal.")
  })

  it('…and names no date at all while the quote is still in flight', async () => {
    heldTiers = ['manager']
    view = await openAddSeats()
    const txt = view.container.textContent || ''
    expect(txt).toContain('before your renewal.')
    expect(txt).not.toMatch(/Mar 1/)
  })

  for (const [name, open] of SURFACES) {
    it(`${name} shows no fabricated date anywhere when there is no anchor`, async () => {
      repliesByTier.manager = { body: noAnchor }
      view = await open()
      expect(view.container.textContent || '').not.toMatch(/Mar 1/)
    })
  }

  it('neither modal accepts a renewal anchor from its caller any more', async () => {
    // The props are gone. Passing one must not resurrect a date on screen —
    // if it did, a caller could still put a wrong one there.
    repliesByTier.manager = { body: noAnchor }
    view = mount(
      <AddSeatsModal
        locationId="loc-ftl"
        {...({ paidThroughDate: '2030-03-01' } as any)}
        onClose={() => {}}
        onSeatsAdded={() => {}}
      />,
    )
    await settle()
    expect(view.container.textContent || '').not.toContain('2030')
  })
})

// ── nothing is quoted for a seat that cannot be bought ────────────────
describe('issue 224 — the picker only prices what is for sale', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  it('a free seat already in the pool is not quoted at all', async () => {
    view = mount(
      <InviteTeamMemberModal locationId="loc-ftl" onClose={() => {}} onInviteCreated={() => {}} />,
      [{ id: 'mgr-open', tier: 'manager', user_id: null, status: 'active', scheduled_removal_at: null }],
    )
    await settle()
    expect(quoteUrls.length).toBe(0)
    expect(view.container.querySelector('[data-testid^="seat-picker-price-"]')).toBeNull()
    expect(view.container.textContent).toMatch(/1 Hive Manager seat available/i)
  })

  it('an owner seat being FILLED is not quoted — it can be filled but never bought', async () => {
    view = mount(
      <InviteTeamMemberModal locationId="loc-ftl" initialTier="owner" onClose={() => {}} onInviteCreated={() => {}} />,
      [{ id: 'own-open', tier: 'owner', user_id: null, status: 'active', scheduled_removal_at: null }],
    )
    await settle()
    expect(quoteUrls.length).toBe(0)
    expect(view.container.querySelector('[data-testid="invite-tier-locked"]')).toBeTruthy()
  })
})

// ── the confirm step inherits the answer ──────────────────────────────
describe('issue 224 — the confirm step agrees with the picker', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  it('shows the same figure the picker showed, without asking twice', async () => {
    view = await openAddSeats()
    expect(pickerToday(view.container)).toBe('About $372.60 today')
    const asked = quoteUrls.length

    clickText(view.container, 'Review order')
    await settle()

    expect(quoteUrls.length).toBe(asked)          // served from the modal's cache
    expect(view.container.textContent).toContain('$372.60')
    expect(view.container.querySelector('[data-testid="seat-notice-charge"]')).toBeTruthy()
  })

  it('issue 223 still holds — a failed quote blocks the purchase', async () => {
    repliesByTier.manager = { status: 500, body: { error: 'could not quote this seat' } }
    view = await openAddSeats()
    clickText(view.container, 'Review order')
    await settle()
    const labels = Array.from(view.container.querySelectorAll('button')).map(b => b.textContent || '')
    expect(labels.some(l => /Confirm/.test(l))).toBe(false)
    expect(view.container.textContent).toMatch(/couldn.t work out the cost/i)
  })
})
