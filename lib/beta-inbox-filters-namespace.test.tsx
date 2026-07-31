// @vitest-environment happy-dom
//
// issue 123 — Inbox view filters were persisted under a single CONSTANT
// localStorage key (bee_hive_inbox_filters), so they were per-browser-profile:
// they survived logout and followed the user across every location. The
// `sources` filter is drawn from each location's OWN leads, so a source set at
// Location A hid every lead at Location B (B's leads lack that source) — the
// original report, needing no memory of having set anything.
//
// The fix namespaces the key by scope: bee_hive_inbox_filters:${locFilter}.
// Every scope — including the all-locations 'all' scope — gets its own
// ':scope' namespace, so a filter set under one scope can never leak into
// another. Because BeeHub owns locFilter as in-place useState (HiveShell is a
// prop change, NOT a remount), useStoredState re-keys live when the location
// switches; the hook resets to defaults when the new key holds nothing, so the
// previous scope's filter cannot linger under a scope that never stored it.
//
// These tests mount HiveShell (badge) + InboxScreen (list + #119 strip) and
// switch locFilter by re-rendering the same root — exactly the production path.
import { describe, it, expect, vi, beforeAll, afterEach, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
  const store = new Map<string, string>()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    // test-only escape hatch: read the backing map so a test can assert what
    // was (or was not) written to a given key.
    __raw: store,
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

const KC = 'dca50888-949f-436d-b24e-b6c8a4984905' // Location A
const LX = '11111111-2222-3333-4444-555555555555' // Location B

// A live NEW, email-only lead: countable by the badge, and hidden by a
// hasPhone view filter. `sources` is the real cross-location field, but
// hasPhone hides a lead identically and needs no per-location vocabulary,
// so it's the clean probe for "is a filter active in THIS scope".
const emailOnly = (name: string, locationId: string) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name, email: `${name.replace(/\s/g, '')}@x.com`, phone: '',
  locationId, created: new Date(Date.now() - 3 * 86400000).toISOString(),
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null, jobberRef: null,
  outreachTimeline: [], atLocOther: false,
  originCity: null, originState: null, originZip: null, project: '',
})

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })
beforeEach(() => { try { localStorage.clear() } catch {} })

const base = (over: any = {}) => ({
  engagements: [], people: [], transferPeople: [],
  locFilter: KC, locationRequired: false,
  locations: [{ id: KC, name: 'Kansas City' }, { id: LX, name: 'Lexington' }],
  locationUsers: [], currentUserId: 'u1', currentLocationUuid: KC,
  closedCount: 0, closedWonCount: 0,
  ...over,
})

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

async function mount(props: any) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => { root.render(React.createElement(HiveShell as any, props)) })
  await settle()
  cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })
  return { host, root }
}

// Re-render the SAME root with a new locFilter — the production location
// switch (BeeHub setLocFilter state change), not a remount.
async function switchLoc(root: any, props: any) {
  await act(async () => { root.render(React.createElement(HiveShell as any, props)) })
  await settle()
}

const inboxTab = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('button')).find(b => /inbox/i.test(b.textContent || '')) as HTMLButtonElement
const badgeCount = (host: HTMLElement) => {
  const m = (inboxTab(host).textContent || '').match(/(\d+)/)
  return m ? Number(m[1]) : 0
}
const openInbox = async (host: HTMLElement) => {
  await act(async () => { inboxTab(host).click() })
  await settle()
}
const stripShown = (host: HTMLElement) => /hidden by your filters/.test(host.textContent || '')
const clearBtn = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('button.bee-clear-all')).find(b => /clear all/i.test(b.textContent || '')) as HTMLButtonElement

describe('issue 123 — Inbox filters are namespaced per location scope', () => {
  it('a filter set at location A does NOT apply after switching to location B', async () => {
    // A filter lives under A's namespace only; B (never stored) reads defaults.
    localStorage.setItem(`bee_hive_inbox_filters:${KC}`, JSON.stringify({ hasPhone: true }))
    const { host, root } = await mount(base({
      people: [emailOnly('Kaycee', KC), emailOnly('Beeport', LX)],
    }))
    await openInbox(host)
    // At A: the filter hides Kaycee → the #119 strip shows.
    expect(host.textContent).not.toContain('Kaycee')
    expect(stripShown(host)).toBe(true)

    // Switch to B: B's namespace is empty → no filter active → Beeport shows.
    await switchLoc(root, base({
      locFilter: LX, currentLocationUuid: LX,
      people: [emailOnly('Kaycee', KC), emailOnly('Beeport', LX)],
    }))
    expect(host.textContent).toContain('Beeport')
    expect(stripShown(host)).toBe(false) // no filter leaked from A
  })

  it('returning to location A restores its filter (B never overwrote it)', async () => {
    localStorage.setItem(`bee_hive_inbox_filters:${KC}`, JSON.stringify({ hasPhone: true }))
    const people = [emailOnly('Kaycee', KC), emailOnly('Beeport', LX)]
    const { host, root } = await mount(base({ people }))
    await openInbox(host)
    expect(stripShown(host)).toBe(true)

    await switchLoc(root, base({ locFilter: LX, currentLocationUuid: LX, people }))
    expect(stripShown(host)).toBe(false)

    // Back to A: the filter is still there.
    await switchLoc(root, base({ locFilter: KC, currentLocationUuid: KC, people }))
    expect(host.textContent).not.toContain('Kaycee')
    expect(stripShown(host)).toBe(true)
    // A's stored value was never clobbered by the B visit.
    expect(JSON.parse(localStorage.getItem(`bee_hive_inbox_filters:${KC}`) || 'null'))
      .toMatchObject({ hasPhone: true })
  })

  it('clearing the filter at A does NOT clear it at B', async () => {
    // Both scopes independently filtered.
    localStorage.setItem(`bee_hive_inbox_filters:${KC}`, JSON.stringify({ hasPhone: true }))
    localStorage.setItem(`bee_hive_inbox_filters:${LX}`, JSON.stringify({ hasPhone: true }))
    const people = [emailOnly('Kaycee', KC), emailOnly('Beeport', LX)]
    const { host, root } = await mount(base({ people }))
    await openInbox(host)
    expect(stripShown(host)).toBe(true)

    // Clear at A.
    const btn = clearBtn(host)
    expect(btn).toBeTruthy()
    await act(async () => { btn.click() })
    await settle()
    expect(stripShown(host)).toBe(false)
    expect(host.textContent).toContain('Kaycee') // A's lead returns

    // Switch to B: B's namespace was untouched → still filtered.
    await switchLoc(root, base({ locFilter: LX, currentLocationUuid: LX, people }))
    expect(host.textContent).not.toContain('Beeport')
    expect(stripShown(host)).toBe(true)
    // B's namespace still carries its filter; A's was reset (hasPhone false).
    expect(JSON.parse(localStorage.getItem(`bee_hive_inbox_filters:${LX}`) || 'null'))
      .toMatchObject({ hasPhone: true })
    const kc = JSON.parse(localStorage.getItem(`bee_hive_inbox_filters:${KC}`) || 'null')
    expect(kc?.hasPhone ?? false).toBe(false)
  })

  it("the 'all' scope is its own namespace — a location filter never leaks into it, and vice versa", async () => {
    // Decision: locFilter==='all' keys as bee_hive_inbox_filters:all. An
    // all-locations filter set is legitimate but isolated from every location.
    localStorage.setItem(`bee_hive_inbox_filters:${KC}`, JSON.stringify({ hasPhone: true }))
    const people = [emailOnly('Kaycee', KC), emailOnly('Beeport', LX)]

    // Under 'all', the KC filter does NOT apply → both leads visible.
    const { host, root } = await mount(base({ locFilter: 'all', currentLocationUuid: null, people }))
    await openInbox(host)
    expect(host.textContent).toContain('Kaycee')
    expect(host.textContent).toContain('Beeport')
    expect(stripShown(host)).toBe(false)

    // Reverse: a filter set under 'all' does NOT apply to a specific location.
    // Use LX, whose namespace was never seeded (KC's was, in this test's setup).
    localStorage.setItem('bee_hive_inbox_filters:all', JSON.stringify({ hasPhone: true }))
    await switchLoc(root, base({ locFilter: LX, currentLocationUuid: LX, people }))
    expect(host.textContent).toContain('Beeport') // LX namespace empty → no filter
    expect(stripShown(host)).toBe(false)
  })

  it('the pre-namespacing key is dropped and never migrated into a location', async () => {
    // Existing users have a filter under the OLD constant key. It resets
    // (silently vanishes) rather than migrating — adopting it into whichever
    // location loads first would re-seed the exact cross-location leak. The
    // orphan is removed so it can't linger.
    localStorage.setItem('bee_hive_inbox_filters', JSON.stringify({ hasPhone: true }))
    const { host } = await mount(base({ people: [emailOnly('Kaycee', KC)] }))
    await openInbox(host)
    expect(host.textContent).toContain('Kaycee') // legacy filter did NOT apply
    expect(stripShown(host)).toBe(false)
    expect(localStorage.getItem('bee_hive_inbox_filters')).toBeNull() // orphan cleaned
    // The namespaced key holds only defaults (the hook's write-through), NOT the
    // legacy {hasPhone:true} — the filter reset rather than migrating.
    const kc = JSON.parse(localStorage.getItem(`bee_hive_inbox_filters:${KC}`) || 'null')
    expect(kc?.hasPhone).not.toBe(true)
  })

  it('#119 strip still reconciles with the badge under the namespaced key', async () => {
    // The badge counts A's one email-only New lead; the filter hides it from
    // the list; the strip reports (badge − visible) = 1, keyed per location.
    localStorage.setItem(`bee_hive_inbox_filters:${KC}`, JSON.stringify({ hasPhone: true }))
    const { host } = await mount(base({ people: [emailOnly('Kaycee', KC)] }))
    expect(badgeCount(host)).toBe(1)
    await openInbox(host)
    expect(host.textContent).not.toContain('Kaycee')
    expect(host.textContent).toContain('1 lead is hidden by your filters')
  })
})
