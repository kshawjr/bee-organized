// @vitest-environment happy-dom
//
// #119 — the Inbox nav badge could show a count over an empty (or
// transfer-only) list with nothing on screen to explain it.
//
// #89 made the badge and the New/Attempting list agree on SOFT-REMOVALS
// (junk/snooze/dismiss/transfer) via a shared predicate. But VIEW filters
// (source/phone/email/touch-band/age) stay OUT of the badge on purpose —
// folding them in would read as "no work" when there is work. So a filter
// can hide the only New lead while the badge still counts it: badge 1,
// list empty. FilteredEmpty only fired when ALL sections were empty and it
// counted FILTERS ("Filters · 2"), never the leads — so it never reconciled
// with the badge, and it vanished the moment the transfer section rendered.
//
// The fix: a persistent "N leads are hidden by your filters" strip whose
// count is, by construction, (badge − visible). It derives that count from
// the SAME isInboxCountable rule the badge uses (New/Attempting AND not
// soft-removed), so it cannot drift from the badge the way the list did.
//
// These tests pin the CONTRACT, mounted: the shared predicate in isolation,
// then HiveShell (badge) + InboxScreen (list + strip) rendered together so
// their agreement is executed, not asserted about strings that "look right".
import { describe, it, expect, vi, beforeAll, afterEach, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { isInboxCountable } from '@/components/hive/shared/inboxCountable'

const NOW = 1_750_000_000_000 // fixed epoch ms — pure, no Date.now() drift
const recent = new Date(NOW - 3 * 86400000).toISOString()
const past = new Date(NOW - 7 * 86400000).toISOString()

// ── The shared count predicate, in isolation ────────────────────────────────
// This is the number the badge shows; the strip counts the leads it KEEPS
// that a view filter then drops. Filters are NOT part of it — by design.
describe('isInboxCountable — the shared badge/strip count predicate', () => {
  const p = (o: any = {}) => ({
    id: 'x', email: 's@x.com', phone: '(561) 555-0100', created: recent,
    isJunk: false, snoozeUntil: null, inboxDismissedAt: null,
    outreachTimeline: [], ...o,
  })
  const noOpen = new Set<string>(), noWon = new Set<string>()

  it('a live New lead counts', () => {
    expect(isInboxCountable(p(), noOpen, noWon, NOW)).toBe(true)
  })
  it('a soft-removed (dismissed) lead does NOT count', () => {
    expect(isInboxCountable(p({ inboxDismissedAt: past }), noOpen, noWon, NOW)).toBe(false)
  })
  it('honors the caller session Sets (the list caller)', () => {
    const sets = { junkedIds: new Set(['x']) }
    expect(isInboxCountable(p(), noOpen, noWon, NOW, sets)).toBe(false)
  })
  it('a no-contact lead (no email AND no phone) is not New/Attempting → does not count', () => {
    expect(isInboxCountable(p({ email: '', phone: '' }), noOpen, noWon, NOW)).toBe(false)
  })
})

// ── Badge + list + strip, mounted together ──────────────────────────────────
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
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
// A loc_other transfer-queue lead (corp/admin routing target).
const locOtherLead = (o: any = {}) => newLead({
  name: 'Global Lead', locationId: 'loc-other-uuid', atLocOther: true,
  originCity: 'Austin', originState: 'TX', originZip: '78701', project: 'Garage', ...o,
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

const badgeCount = (host: HTMLElement) => {
  const m = (inboxTab(host).textContent || '').match(/(\d+)/)
  return m ? Number(m[1]) : 0
}
const openInbox = async (host: HTMLElement) => {
  await act(async () => { inboxTab(host).click() })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}
// The strip's own number — read from its OWN span, not host.textContent,
// which would concatenate adjacent counts (e.g. the transfer "· 1") onto it.
const stripCount = (host: HTMLElement) => {
  const span = Array.from(host.querySelectorAll('span'))
    .find(s => /hidden by your filters/.test(s.textContent || ''))
  const m = (span?.textContent || '').match(/(\d+)\s+leads?\s+(?:is|are)\s+hidden by your filters/)
  return m ? Number(m[1]) : 0
}
const stripShown = (host: HTMLElement) => /hidden by your filters/.test(host.textContent || '')
// The strip reuses the shared "Clear all" affordance.
const clearBtn = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('button.bee-clear-all')).find(b => /clear all/i.test(b.textContent || '')) as HTMLButtonElement

describe('#119 Inbox — hidden-by-filters strip reconciles with the badge', () => {
  it('filter hides the only New lead, nothing else on screen → strip shows "1 lead", count matches the badge', async () => {
    // hasPhone filter hides a phone-less (email-only) New lead from the list.
    localStorage.setItem(`bee_hive_inbox_filters:${KC}`, JSON.stringify({ hasPhone: true }))
    const host = await mount(base({ people: [newLead({ name: 'Emailonly Lead', phone: '', email: 'e@x.com' })] }))
    expect(badgeCount(host)).toBe(1)          // badge still counts it
    await openInbox(host)
    expect(host.textContent).not.toContain('Emailonly Lead') // list hides it
    expect(stripShown(host)).toBe(true)
    expect(host.textContent).toContain('1 lead is hidden by your filters')
    expect(stripCount(host)).toBe(badgeCount(host)) // strip == badge, the point
    // The strip OWNS this case — the filter-count empty state must not double up.
    expect(host.textContent).not.toContain('No inbox leads match the active filters')
  })

  it('filter hides a New lead AND the transfer section is rendering → strip STILL shows (the gap FilteredEmpty missed)', async () => {
    localStorage.setItem(`bee_hive_inbox_filters:${KC}`, JSON.stringify({ hasPhone: true }))
    const host = await mount(base({
      people: [newLead({ name: 'Emailonly Lead', phone: '', email: 'e@x.com' })],
      transferPeople: [locOtherLead()],
    }))
    expect(badgeCount(host)).toBe(1) // loc_other is never counted; the KC lead is
    await openInbox(host)
    expect(host.textContent).toContain('Not yet routed') // transfer section on screen
    expect(stripShown(host)).toBe(true)                  // strip shows anyway
    expect(stripCount(host)).toBe(1)
  })

  it('no filters active → no strip', async () => {
    const host = await mount(base({ people: [newLead({ name: 'Plain New' })] }))
    expect(badgeCount(host)).toBe(1)
    await openInbox(host)
    expect(host.textContent).toContain('Plain New')
    expect(stripShown(host)).toBe(false)
  })

  it('filters active but nothing hidden → no strip', async () => {
    // hasPhone filter is on, but the lead HAS a phone, so nothing is hidden.
    localStorage.setItem(`bee_hive_inbox_filters:${KC}`, JSON.stringify({ hasPhone: true }))
    const host = await mount(base({ people: [newLead({ name: 'Has Phone', phone: '(561) 555-0000' })] }))
    expect(badgeCount(host)).toBe(1)
    await openInbox(host)
    expect(host.textContent).toContain('Has Phone')
    expect(stripShown(host)).toBe(false)
  })

  it('Clear resets the filters: strip disappears and the hidden lead returns', async () => {
    localStorage.setItem(`bee_hive_inbox_filters:${KC}`, JSON.stringify({ hasPhone: true }))
    const host = await mount(base({ people: [newLead({ name: 'Emailonly Lead', phone: '', email: 'e@x.com' })] }))
    await openInbox(host)
    expect(stripShown(host)).toBe(true)
    const btn = clearBtn(host)
    expect(btn).toBeTruthy()
    await act(async () => { btn.click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(stripShown(host)).toBe(false)                 // strip gone
    expect(host.textContent).toContain('Emailonly Lead') // lead now visible
  })

  it('mixed set: badge == visible rows + strip count', async () => {
    // Two email-only New leads are hidden by hasPhone; one phone-having New
    // lead stays visible. Badge counts all three; strip counts the two hidden.
    localStorage.setItem(`bee_hive_inbox_filters:${KC}`, JSON.stringify({ hasPhone: true }))
    const host = await mount(base({
      people: [
        newLead({ name: 'Hidden A', phone: '', email: 'a@x.com' }),
        newLead({ name: 'Hidden B', phone: '', email: 'b@x.com' }),
        newLead({ name: 'Visible Phone', phone: '(561) 555-0000' }),
      ],
    }))
    expect(badgeCount(host)).toBe(3)
    await openInbox(host)
    expect(host.textContent).toContain('Visible Phone')     // 1 visible
    expect(host.textContent).not.toContain('Hidden A')
    expect(host.textContent).not.toContain('Hidden B')
    expect(stripCount(host)).toBe(2)                        // 2 hidden
    expect(1 + stripCount(host)).toBe(badgeCount(host))     // visible + hidden == badge
  })
})
