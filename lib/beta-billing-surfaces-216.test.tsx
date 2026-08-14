// @vitest-environment happy-dom
//
// issue 216 — the component halves of the billing-surface fixes. Mounts the
// REAL components so a future edit can't quietly reintroduce any of them.
//
//   A — the ghost row passes tier='owner' for a paid, unclaimed co-owner
//       seat. The modal's guard tested that against TIER_OPTIONS — a list of
//       what may be SOLD — so 'owner' failed a purchase test it was never
//       meant to take and fell through to TIER_OPTIONS[0], Hive Manager.
//       The seat was uninvitable and its Invite button opened a wrong-tier
//       purchase prompt. Owner must now be honoured for FILLING, and refused
//       for BUYING — lib/seat-stripe-sync maps tier→price 1:1, so a bought
//       co-owner seat would charge $550 where the rule says $400.
//   B — a seat held by an unaccepted invite must not advertise an Invite
//       button on the roster.
//   C — the proration anchor must come from the location's real
//       paid_through_date even when currentLocationCtx is null, which is the
//       normal state in a super_admin view.
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

import { InviteTeamMemberModal, TeamSection, ScheduleRemovalModal, SeatsContext } from '@/components/BeeHub'

// Fort Lauderdale's live shape (see the .ts sibling for the data).
const SEATS = [
  { id: 'own-assigned', tier: 'owner', user_id: 'u1', status: 'active', scheduled_removal_at: null },
  { id: 'own-open', tier: 'owner', user_id: null, status: 'active', scheduled_removal_at: null },
  { id: 'mgr-open', tier: 'manager', user_id: null, status: 'active', scheduled_removal_at: null },
]
const INVITES = [
  { id: 'i1', tier: 'owner', accepted_at: '2026-08-14T13:08:39Z', invite_expires_at: '2026-08-21T13:07:59Z' },
  { id: 'i2', tier: 'manager', accepted_at: null, invite_expires_at: '2099-01-01T00:00:00Z' },
]

// A real SeatsContext value, wired to the same lib the app wires it to.
import {
  seatCountsByTier,
  availableSeatsForTier,
  availableSeatRows,
  pendingInviteCount,
  invitableSeatIds,
} from '@/lib/seat-availability'

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

let fetchCalls: Array<{ url: string; body: any }> = []

// issue 224 — the seat modals ask GET /api/seats/quote from the form step now,
// because the tier picker names the price. C below drives the renewal date
// through this rather than through a prop.
let quoteReply: any = null

beforeEach(() => {
  document.body.innerHTML = ''
  fetchCalls = []
  quoteReply = {
    cost: { total_cents: 4657, annual_total_cents: 5000, per_seat_cents: [4657], renewal_date: '2027-08-14', source: 'server' },
    billing: { will_charge: true, reason: null, lines: [] },
  }
  ;(globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
    if (String(url).includes('/api/seats/quote')) {
      return { ok: true, status: 200, json: async () => quoteReply }
    }
    fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    return {
      ok: true,
      status: 200,
      json: async () => ({ invite: { id: 'new', email: 'x@y.com', tier: 'owner' }, invite_url: 'https://x/y' }),
    }
  }) as any
})

// Let the form-step quote's promise chain settle before reading the screen.
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

function mount(node: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(node) })
  return { container, unmount: () => { act(() => { root.unmount() }); container.remove() } }
}

const withSeats = (ui: React.ReactElement, value = seatsValue()) =>
  React.createElement(SeatsContext.Provider, { value } as any, ui)

function typeInto(container: HTMLElement, selector: string, value: string) {
  const el = container.querySelector(selector) as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function clickText(container: HTMLElement, text: string) {
  const btn = Array.from(container.querySelectorAll('button')).find(b =>
    (b.textContent || '').includes(text),
  )
  if (!btn) throw new Error(`no button containing "${text}"`)
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  return btn
}

// ── A — the passed tier is honoured ───────────────────────────────────
describe('issue 216 A — InviteTeamMemberModal honours an owner seat handed to it', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  it('opens on Zee Bee, not Hive Manager, when handed initialTier="owner"', () => {
    view = mount(withSeats(
      <InviteTeamMemberModal locationId="loc-ftl" initialTier="owner" onClose={() => {}} onInviteCreated={() => {}} />,
    ))
    const txt = view.container.textContent || ''
    expect(view.container.querySelector('[data-testid="invite-tier-locked"]')).toBeTruthy()
    expect(txt).toContain('Zee Bee')
    // the old fallback landed here and offered to sell a manager seat
    expect(txt).not.toContain('No Hive Manager seats available')
  })

  it('treats the seat as available and offers to SEND, never to buy', () => {
    view = mount(withSeats(
      <InviteTeamMemberModal locationId="loc-ftl" initialTier="owner" onClose={() => {}} onInviteCreated={() => {}} />,
    ))
    const txt = view.container.textContent || ''
    expect(txt).toContain('Send Invite')
    expect(txt).not.toContain('Buy & Send Invite')
    expect(txt).not.toContain('purchase 1 to invite')
  })

  it('sends the invite at tier "owner" against the existing seat', () => {
    view = mount(withSeats(
      <InviteTeamMemberModal locationId="loc-ftl" initialTier="owner" onClose={() => {}} onInviteCreated={() => {}} />,
    ))
    typeInto(view.container, 'input[type="email"]', 'coowner@example.com')
    clickText(view.container, 'Send Invite')
    const invite = fetchCalls.find(c => c.url.includes('/api/hub_users/invite'))
    expect(invite).toBeTruthy()
    expect(invite!.body.tier).toBe('owner')
    expect(invite!.body.location_id).toBe('loc-ftl')
    // and NOTHING went to the purchase endpoint
    expect(fetchCalls.some(c => c.url.includes('buy-and-invite'))).toBe(false)
  })

  it('does not offer owner in the picker when no owner seat is free', () => {
    // both owner seats claimed → nothing to fill
    const seats = [
      { id: 'a', tier: 'owner', user_id: 'u1', status: 'active', scheduled_removal_at: null },
      { id: 'b', tier: 'owner', user_id: 'u2', status: 'active', scheduled_removal_at: null },
    ]
    view = mount(withSeats(
      <InviteTeamMemberModal locationId="loc-ftl" initialTier="owner" onClose={() => {}} onInviteCreated={() => {}} />,
      seatsValue(seats, []),
    ))
    expect(view.container.querySelector('[data-testid="invite-tier-locked"]')).toBeFalsy()
    // falls back to a purchasable tier, and owner is not among the options
    expect(view.container.textContent || '').not.toContain('Zee Bee')
  })

  it('refuses owner when the free owner seat is itself held by a pending invite', () => {
    const invites = [{ id: 'p', tier: 'owner', accepted_at: null, invite_expires_at: '2099-01-01T00:00:00Z' }]
    view = mount(withSeats(
      <InviteTeamMemberModal locationId="loc-ftl" initialTier="owner" onClose={() => {}} onInviteCreated={() => {}} />,
      seatsValue(SEATS, invites),
    ))
    expect(view.container.querySelector('[data-testid="invite-tier-locked"]')).toBeFalsy()
  })

  it('the 2-owner cap keeps a THIRD owner seat unfillable', () => {
    // three active owner seats should never exist; if one ever did, the modal
    // must not treat it as a normal fill.
    const seats = [
      { id: 'a', tier: 'owner', user_id: 'u1', status: 'active', scheduled_removal_at: null },
      { id: 'b', tier: 'owner', user_id: 'u2', status: 'active', scheduled_removal_at: null },
      { id: 'c', tier: 'owner', user_id: null, status: 'active', scheduled_removal_at: null },
    ]
    view = mount(withSeats(
      <InviteTeamMemberModal locationId="loc-ftl" initialTier="owner" onClose={() => {}} onInviteCreated={() => {}} />,
      seatsValue(seats, []),
    ))
    expect(view.container.querySelector('[data-testid="invite-tier-locked"]')).toBeFalsy()
  })

  it('owner is never a selectable option in the purchase picker', () => {
    view = mount(withSeats(
      <InviteTeamMemberModal locationId="loc-ftl" initialTier={null} onClose={() => {}} onInviteCreated={() => {}} />,
    ))
    // manager / worker / watcher only — the picker is the SELL list
    expect(view.container.textContent || '').not.toContain('Zee Bee')
  })
})

// ── B — a reserved seat advertises nothing ────────────────────────────
describe('issue 216 B — the roster does not offer Invite on a reserved seat', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  const renderRoster = (value = seatsValue()) =>
    mount(withSeats(
      <TeamSection locationId="loc1" dbLocationIdOverride="loc-ftl" paidThroughOverride="2027-08-14" profile={{ firstName: 'K', email: 'k@x.com' }} />,
      value,
    ))

  it('the free owner seat keeps its Invite button', () => {
    view = renderRoster()
    const open = view.container.querySelectorAll('[data-testid="open-seat-row"]')
    expect(open.length).toBe(1)
    expect((open[0].textContent || '')).toContain('Paid for and ready')
    expect(open[0].querySelector('button')).toBeTruthy()
  })

  it('the manager seat held by a pending invite is shown WITHOUT an Invite button', () => {
    view = renderRoster()
    const reserved = view.container.querySelectorAll('[data-testid="reserved-seat-row"]')
    expect(reserved.length).toBe(1)
    expect((reserved[0].textContent || '')).toContain('hasn’t been accepted yet')
    // the row that cannot be invited into must not offer the action
    expect(reserved[0].querySelector('button')).toBeFalsy()
  })

  it('the paid seat is still VISIBLE — reserved, not hidden', () => {
    view = renderRoster()
    const rows = view.container.querySelectorAll('[data-testid="open-seat-row"],[data-testid="reserved-seat-row"]')
    // two paid open seats exist; both are still on screen
    expect(rows.length).toBe(2)
  })

  it('once the invite is accepted the seat becomes invitable again', () => {
    const accepted = [{ id: 'i2', tier: 'manager', accepted_at: '2026-08-15T00:00:00Z', invite_expires_at: '2099-01-01T00:00:00Z' }]
    view = renderRoster(seatsValue(SEATS, accepted))
    expect(view.container.querySelectorAll('[data-testid="reserved-seat-row"]').length).toBe(0)
    expect(view.container.querySelectorAll('[data-testid="open-seat-row"]').length).toBe(2)
  })
})

// ── C — the proration anchor is the location's own ────────────────────
describe('issue 216 C — proration anchors to the real paid_through_date', () => {
  let view: ReturnType<typeof mount> | null = null
  afterEach(() => { view?.unmount(); view = null })

  // ── issue 224 moved WHERE the anchor comes from, not WHAT it must be ──
  // These three used to drive the date through InviteTeamMemberModal's
  // paidThroughDate prop, because the modal formatted the renewal date itself
  // to write "…before your renewal on <date>". The tier picker now names the
  // date beside the figure and both arrive together on the server's quote, so
  // the prop is gone and the date is driven through the quote instead.
  //
  // THE TEETH ARE UNCHANGED AND ARE THE POINT: the date on screen is the
  // location's OWN renewal date and is never the legacy fixed March 1. What
  // changed is that a client with no anchor can no longer produce March 1 at
  // all — see the inverted test below, which is the same guarantee made
  // stronger. resolveLocationRenewalDate's fallback still exists and is still
  // pinned, on ScheduleRemovalModal, which still legitimately uses it.
  it('shows the location’s own renewal date, not the legacy fixed March 1', async () => {
    // A super_admin view has no CurrentLocationContext. Pick a tier with NO
    // free seat, so a PURCHASE is quoted and the price block renders.
    view = mount(withSeats(
      <InviteTeamMemberModal
        locationId="loc-ftl"
        initialTier="readonly"
        onClose={() => {}}
        onInviteCreated={() => {}}
      />,
      seatsValue(SEATS, []),
    ))
    await settle()
    const txt = view.container.textContent || ''
    expect(txt).toContain('Aug 14, 2027')
    expect(txt).not.toContain('Mar 1, 2027')
  })

  it('with no anchor it names NO date, rather than falling back to the legacy one', async () => {
    // The old shape of this test asserted that a modal with no anchor
    // rendered "Mar 1" — the legacy fallback — to prove the prop carried the
    // fix. issue 217 refuses to invent that anchor server-side and issue 224
    // stopped the screen inventing one too, so the honest assertion is now
    // the opposite: a location with no paid_through_date is told the price
    // renews "at your renewal" and is shown no date at all.
    quoteReply = {
      cost: { total_cents: null, annual_total_cents: 5000, per_seat_cents: null, renewal_date: null, unpriced_reason: 'no_renewal_anchor', source: 'server' },
      billing: { will_charge: true, reason: null, lines: [] },
    }
    view = mount(withSeats(
      <InviteTeamMemberModal
        locationId="loc-ftl"
        initialTier="readonly"
        onClose={() => {}}
        onInviteCreated={() => {}}
      />,
      seatsValue(SEATS, []),
    ))
    await settle()
    const txt = view.container.textContent || ''
    expect(txt).not.toContain('Mar 1')
    expect(txt).toContain('at your renewal')
  })

  it('TeamSection opens the invite modal against the right location', async () => {
    // The renewal date only renders where a PURCHASE is quoted, so drop the
    // free manager seat: "+ Invite" then opens on manager with none available.
    // paidThroughOverride no longer reaches this modal (the two
    // ScheduleRemovalModal tests below still pin that it reaches the modal
    // that needs it), so what this pins now is the thing the quote is keyed
    // on: dbLocationIdOverride, without which the server would price and
    // anchor against the wrong location entirely.
    const noFreeManager = SEATS.filter(s => s.id !== 'mgr-open')
    view = mount(withSeats(
      <TeamSection
        locationId="loc1"
        dbLocationIdOverride="loc-ftl"
        paidThroughOverride="2027-08-14"
        profile={{ firstName: 'K', email: 'k@x.com' }}
      />,
      seatsValue(noFreeManager, []),
    ))
    clickText(view.container, '+ Invite')
    await settle()
    const quotes = ((globalThis as any).fetch as any).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((u: string) => u.includes('/api/seats/quote'))
    expect(quotes.length).toBeGreaterThan(0)
    expect(quotes[0]).toContain('location_id=loc-ftl')
    const txt = view.container.textContent || ''
    expect(txt).toContain('Aug 14, 2027')
    expect(txt).not.toContain('Mar 1, 2027')
  })

  it('ScheduleRemovalModal defaults its removal date to the same anchor', () => {
    // The freed-seat prompt inside TeamSection renders this modal, and it had
    // the same missing prop — a removal scheduled against the wrong date ends
    // a paid seat early or late.
    view = mount(
      <ScheduleRemovalModal
        seat={{ id: 'mgr-open', tier: 'manager', user_id: null }}
        tierMeta={{ name: 'Hive Manager', icon: '🍯' }}
        paidThroughDate="2027-08-14"
        onClose={() => {}}
        onScheduled={() => {}}
      />,
    )
    const dateInput = view.container.querySelector('input[type="date"]') as HTMLInputElement
    expect(dateInput.value).toBe('2027-08-14')
  })

  it('…and falls back to the legacy fixed date only when there is no anchor', () => {
    view = mount(
      <ScheduleRemovalModal
        seat={{ id: 'mgr-open', tier: 'manager', user_id: null }}
        tierMeta={{ name: 'Hive Manager', icon: '🍯' }}
        onClose={() => {}}
        onScheduled={() => {}}
      />,
    )
    const dateInput = view.container.querySelector('input[type="date"]') as HTMLInputElement
    expect(dateInput.value).toMatch(/^\d{4}-03-01$/)
  })
})
