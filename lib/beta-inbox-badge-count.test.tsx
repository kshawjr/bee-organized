// @vitest-environment happy-dom
//
// #89 — the Inbox nav badge counted rows the list hid.
//
// The badge (HiveShell) and the New/Attempting list (InboxScreen) are two
// separate derivations. Both scope by location and test
// deriveClientStatus ∈ {New, Attempting}. The list then applied four
// PERSISTENT soft-removal exclusions (junk / snoozed / dismissed /
// transferred) that the badge omitted — so a dismissed lead, which still
// derives New/Attempting (deriveClientStatus is blind to the removal
// fields), rode the badge while the list dropped it. Prod, Palm Beach:
// badge 5, list 3, the two inbox_dismissed_at leads the gap.
//
// The fix extracts one shared predicate — isSoftRemovedFromInbox — that
// both sides call, so they cannot drift again. These tests pin the
// contract, not the source: the helper directly (pure), then the badge and
// the list MOUNTED together so their agreement is executed, not asserted
// about strings that "look right".
//
// The one case that must NEVER regress: a user's VIEW filter (hasPhone,
// source, …) hides a live lead from the LIST but must NOT remove it from
// the badge — folding filters into the count would read as "no work" when
// there is work. View filters are the list's own step, never the badge's.
import { describe, it, expect, vi, beforeAll, afterEach, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { isSoftRemovedFromInbox } from '@/components/hive/shared/inboxSoftRemoval'

const NOW = 1_750_000_000_000 // fixed epoch ms — pure, no Date.now() drift
const future = new Date(NOW + 7 * 86400000).toISOString()
const past = new Date(NOW - 7 * 86400000).toISOString()

// ── The shared predicate, in isolation ─────────────────────────────────────
describe('isSoftRemovedFromInbox — the shared soft-removal predicate', () => {
  const p = (o: any = {}) => ({ id: 'x', isJunk: false, snoozeUntil: null, inboxDismissedAt: null, ...o })

  it('a clean row is NOT removed', () => {
    expect(isSoftRemovedFromInbox(p(), NOW)).toBe(false)
  })
  it('inbox_dismissed_at set → removed (the #89 culprit)', () => {
    expect(isSoftRemovedFromInbox(p({ inboxDismissedAt: past }), NOW)).toBe(true)
  })
  it('snoozed to a FUTURE date → removed; a PAST snooze → not', () => {
    expect(isSoftRemovedFromInbox(p({ snoozeUntil: future }), NOW)).toBe(true)
    expect(isSoftRemovedFromInbox(p({ snoozeUntil: past }), NOW)).toBe(false)
  })
  it('is_junk → removed', () => {
    expect(isSoftRemovedFromInbox(p({ isJunk: true }), NOW)).toBe(true)
  })
  it('honors the caller session Sets (junk / snooze / dismiss / transfer)', () => {
    const sets = {
      junkedIds: new Set(['j']), snoozedIds: new Set(['s']),
      dismissedIds: new Set(['d']), transferredIds: new Set(['t']),
    }
    expect(isSoftRemovedFromInbox(p({ id: 'j' }), NOW, sets)).toBe(true)
    expect(isSoftRemovedFromInbox(p({ id: 's' }), NOW, sets)).toBe(true)
    expect(isSoftRemovedFromInbox(p({ id: 'd' }), NOW, sets)).toBe(true)
    expect(isSoftRemovedFromInbox(p({ id: 't' }), NOW, sets)).toBe(true)
    expect(isSoftRemovedFromInbox(p({ id: 'clean' }), NOW, sets)).toBe(false)
  })
  it('no session Sets (the badge caller) → persistent DB fields alone decide', () => {
    // transferred is session-only, so with no Sets it can never remove — the
    // row leaves the badge scope on reload when its location changes instead.
    expect(isSoftRemovedFromInbox(p(), NOW)).toBe(false)
    expect(isSoftRemovedFromInbox(p({ inboxDismissedAt: past }), NOW)).toBe(true)
  })
})

// ── Badge and list, mounted together ────────────────────────────────────────
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
  // happy-dom ships no localStorage here (useStoredState try/catches around
  // that), but the view-filter case needs a real one to seed a stored filter.
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
  }
})

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/clients',
  useSearchParams: () => new URLSearchParams(),
}))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200
;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ targets: [] }) })) as any

import HiveShell from '@/components/hive/HiveShell'

const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'

// A live NEW lead: contact info, recent, no reach-out, no engagement.
const newLead = (o: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Fresh Lead', email: 's@x.com', phone: '(561) 555-0199',
  locationId: KC, created: new Date(Date.now() - 3 * 86400000).toISOString(),
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null, jobberRef: null,
  outreachTimeline: [], atLocOther: false,
  originCity: null, originState: null, originZip: null, project: '',
  ...o,
})
// A live ATTEMPTING lead: a recent reach-out touchpoint.
const attemptingLead = (o: any = {}) => newLead({
  name: 'Worked Lead',
  outreachTimeline: [{ type: 'reach_out', occurred_at: new Date(Date.now() - 86400000).toISOString() }],
  ...o,
})

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })
beforeEach(() => { try { localStorage.clear() } catch {} })

async function mount(props: any) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => { root.render(React.createElement(HiveShell as any, props)) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })
  return host
}

const base = (over: any = {}) => ({
  engagements: [], people: [], transferPeople: [],
  locFilter: KC, locationRequired: false,
  locations: [{ id: KC, name: 'Kansas City' }],
  locationUsers: [], currentUserId: 'u1', currentLocationUuid: KC,
  closedCount: 0, closedWonCount: 0,
  ...over,
})

const inboxTab = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('button')).find(b => /inbox/i.test(b.textContent || '')) as HTMLButtonElement

// The badge count is the trailing number on the Inbox tab pill; the label
// "Inbox (New)" carries no digits, so the digits ARE the count (0 when the
// pill renders no badge span).
const badgeCount = (host: HTMLElement) => {
  const m = (inboxTab(host).textContent || '').match(/(\d+)/)
  return m ? Number(m[1]) : 0
}
const openInbox = async (host: HTMLElement) => {
  await act(async () => { inboxTab(host).click() })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

describe('#89 Inbox badge count matches the list', () => {
  it('a live New/Attempting lead is COUNTED and LISTED', async () => {
    const host = await mount(base({ people: [newLead({ name: 'Fresh Lead' })] }))
    expect(badgeCount(host)).toBe(1)
    await openInbox(host)
    expect(host.textContent).toContain('Fresh Lead')
  })

  it('a DISMISSED lead that still derives New is NOT counted and NOT listed', async () => {
    const host = await mount(base({
      people: [newLead({ name: 'Dismissed Lead', inboxDismissedAt: past })],
    }))
    expect(badgeCount(host)).toBe(0)
    await openInbox(host)
    expect(host.textContent).not.toContain('Dismissed Lead')
  })

  it('a lead SNOOZED to a future date is NOT counted and NOT listed', async () => {
    const host = await mount(base({
      people: [newLead({ name: 'Snoozed Lead', snoozeUntil: new Date(Date.now() + 7 * 86400000).toISOString() })],
    }))
    expect(badgeCount(host)).toBe(0)
    await openInbox(host)
    expect(host.textContent).not.toContain('Snoozed Lead')
  })

  it('MUST-NOT-REGRESS: a VIEW filter hides a live lead from the list but keeps it COUNTED', async () => {
    // hasPhone filter hides a phone-less (email-only) lead from the LIST. The
    // badge must still count it — filtering a view is not "no work".
    localStorage.setItem('bee_hive_inbox_filters', JSON.stringify({ hasPhone: true }))
    const host = await mount(base({
      people: [newLead({ name: 'Emailonly Lead', phone: '', email: 'e@x.com' })],
    }))
    expect(badgeCount(host)).toBe(1)          // counted
    await openInbox(host)
    expect(host.textContent).not.toContain('Emailonly Lead') // filtered from the list
  })

  it('a MIXED set: badge equals the number of live rows the list shows', async () => {
    const host = await mount(base({
      people: [
        newLead({ name: 'Live New' }),
        attemptingLead({ name: 'Live Attempting' }),
        newLead({ name: 'Gone Dismissed', inboxDismissedAt: past }),
        newLead({ name: 'Gone Snoozed', snoozeUntil: new Date(Date.now() + 7 * 86400000).toISOString() }),
        newLead({ name: 'Gone Junk', isJunk: true }),
      ],
    }))
    expect(badgeCount(host)).toBe(2)
    await openInbox(host)
    expect(host.textContent).toContain('Live New')
    expect(host.textContent).toContain('Live Attempting')
    expect(host.textContent).not.toContain('Gone Dismissed')
    expect(host.textContent).not.toContain('Gone Snoozed')
    expect(host.textContent).not.toContain('Gone Junk')
  })
})
