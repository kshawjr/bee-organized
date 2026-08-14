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

beforeEach(() => {
  document.body.innerHTML = ''
  fetchCalls = []
  ;(globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
    fetchCalls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null })
    return {
      ok: true,
      status: 200,
      json: async () => ({ invite: { id: 'new', email: 'x@y.com', tier: 'owner' }, invite_url: 'https://x/y' }),
    }
  }) as any
})

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

  // A super_admin view has no CurrentLocationContext, so the prop is the only
  // source. Pick a tier with NO free seat so the prorated quote renders.
  it('quotes against paid_through_date, not the legacy fixed March 1', () => {
    view = mount(withSeats(
      <InviteTeamMemberModal
        locationId="loc-ftl"
        initialTier="readonly"
        paidThroughDate="2027-08-14"
        onClose={() => {}}
        onInviteCreated={() => {}}
      />,
      seatsValue(SEATS, []),
    ))
    const txt = view.container.textContent || ''
    expect(txt).toContain('Aug 14, 2027')
    expect(txt).not.toContain('Mar 1, 2027')
  })

  it('without the anchor it would fall back to the legacy date — the bug', () => {
    view = mount(withSeats(
      <InviteTeamMemberModal
        locationId="loc-ftl"
        initialTier="readonly"
        onClose={() => {}}
        onInviteCreated={() => {}}
      />,
      seatsValue(SEATS, []),
    ))
    // proves the prop is what carries the fix (legacy fallback is Mar 1)
    expect(view.container.textContent || '').toContain('Mar 1')
  })

  it('TeamSection threads paidThroughOverride into the invite modal', () => {
    // The renewal date only renders where a PURCHASE is quoted, so drop the
    // free manager seat: "+ Invite" then opens on manager with none available
    // and must prorate to the location's own date. This is the super_admin
    // path — no CurrentLocationContext, so the prop is the only anchor.
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
    const txt = view.container.textContent || ''
    // issue 223 replaced the "Prorated to <date>" summary row (which quoted a
    // client-computed figure) with prose, and the confirm step now gets the
    // amount from the server. The property THIS test pins is unchanged and is
    // the second assertion: the anchor is the location's own renewal date,
    // arriving via the prop, and never the legacy fixed March 1.
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
