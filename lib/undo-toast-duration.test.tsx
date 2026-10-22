// @vitest-environment happy-dom
//
// The undo window is 6 seconds on the screen owners actually use.
//
// WHY THIS EXISTS (ClickUp 868kaxm2z). Kevin specified a 6-second undo on
// 11 July. The Inbox passed `duration: 6000`, but the live Clients screen is
// drawn by App, whose toast host hardcoded 3000 and ignored the duration — so
// owners got 3 seconds, the original complaint. It shipped because the only
// test was a source regex that found the duration-aware host in
// DashboardScreen and never looked at App's.
//
// So these tests mount the REAL App on the Clients route and measure how long
// the toast actually stays on screen, with a fake clock. HiveShell (the lens
// content) is a next/dynamic chunk that never resolves under vitest; the
// dynamic stub below stands in for it and hands back the setToast App passes
// down, which is the exact function every Clients-screen undo calls.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

const captured = vi.hoisted(() => ({ setToast: null as null | ((t: any) => void) }))

vi.mock('next/dynamic', () => ({
  default: () => function DynamicStub(props: any) {
    // HiveShell is the dynamic child that receives the host's setToast.
    if (props && typeof props.setToast === 'function' && 'people' in props) captured.setToast = props.setToast
    return null
  },
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/clients',
  useSearchParams: () => new URLSearchParams(),
}))

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

import App from '@/components/BeeHub'
import ClientProfile from '@/components/hive/ClientProfile'
import { undoToast } from '@/components/hive/shared/cardKit'

const KC = 'dca50888-949f-436d-b24e-b6c8a4984905'
const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const appProps = () => ({
  initialRoute: 'clients',
  initialRole: 'franchise',
  initialFranchiseRole: 'owner',
  initialLocFilter: KC,
  initialScopeLocationId: KC,
  initialLocations: [{ id: KC, name: 'Kansas City', state: 'MO', crmStatus: 'active' }],
  initialUsers: [], initialSeats: [], initialPendingInvites: [], initialLookups: {},
  initialPeople: [], initialBinPeople: [], initialTransferPeople: [], initialEngagements: [],
  initialPartners: [], initialCompanies: [], initialGuideSlides: [], initialManualSlides: [],
  initialTierPrices: [],
  currentUser: { id: 'u1', email: 'owner@example.com', name: 'Owner', role: 'franchise', locationId: KC },
  currentLocation: null,
  currentSubscription: null,
})

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const fn of cleanup) await fn()
  cleanup = []
  captured.setToast = null
  document.body.innerHTML = ''
})

async function mountClients() {
  ;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) as any
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => { root.render(React.createElement(App as any, appProps())) })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  cleanup.push(async () => { await act(async () => { root.unmount() }); errSpy.mockRestore(); host.remove() })
  expect(captured.setToast, 'App handed its toast setter down to the Clients screen').toBeTypeOf('function')
  return host
}

// Raise a toast through the host's own setter, then move the fake clock.
async function raise(toast: any) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await act(async () => { captured.setToast!(toast) })
}
const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms) })

describe('the Clients screen toast host (App)', () => {
  it('an undo toast stays up for 6000ms, not 3000', async () => {
    const host = await mountClients()
    await raise(undoToast('Marked as junk', () => {}, 6000))
    expect(host.textContent).toContain('Marked as junk')

    await advance(3000)
    expect(host.textContent, 'still up at 3s — the old hardcoded window').toContain('Marked as junk')
    await advance(2999)
    expect(host.textContent, 'still up at 5.999s').toContain('Marked as junk')
    await advance(1)
    expect(host.textContent, 'gone at 6s').not.toContain('Marked as junk')
  })

  it('a new toast replaces the old one AND its timer — the first toast\'s 6s cannot cut the second short', async () => {
    // Undo's own follow-up ("Sarah restored") or the next action's undo lands
    // while the first toast's timer is still running. If that old timer
    // survived, it would clear the NEW toast at 6s instead of letting it run
    // its own window.
    const host = await mountClients()
    await raise(undoToast('First undo', () => {}, 6000))
    await advance(1000)
    await act(async () => { captured.setToast!(undoToast('Second undo', () => {}, 6000)) })
    expect(host.textContent, 'one toast at a time — the new one replaces the old').not.toContain('First undo')
    expect(host.textContent).toContain('Second undo')

    await advance(5000) // 6s since the first toast: its timer would fire here
    expect(host.textContent, 'still up at 6s — the first timer did not clear it').toContain('Second undo')
    await advance(900)
    expect(host.textContent, 'still up at 6.9s').toContain('Second undo')
    await advance(100)
    expect(host.textContent, 'gone at 7s — 6s after it was raised').not.toContain('Second undo')
  })

  it('a toast with no duration still goes at 3000ms (success and error messages unchanged)', async () => {
    const host = await mountClients()
    await raise({ kind: 'success', msg: 'Saved the thing' })
    await advance(2999)
    expect(host.textContent).toContain('Saved the thing')
    await advance(1)
    expect(host.textContent).not.toContain('Saved the thing')
  })
})

// ── the card's junk undo carries 6000 into that host ───────────────────
const profilePayload = () => ({
  client: {
    id: 'lead-9', name: 'Sarah Watts', first_name: 'Sarah', last_name: 'Watts',
    email: 'sarah@email.com', phone: '(561) 555-0199', address: '12 Oak St',
    stage: 'New', created_at: daysAgo(30), tags: [], jobber_client_id: null,
    is_junk: false, snoozed_until: null, inbox_dismissed_at: null, assigned_to: null,
  },
  referred_us: [], referred_us_total: 0, contacts: [], engagements: [],
  touchpoints: [], buzz_notes: [], job_notes: [], tags: [],
  aggregates: { owing: 0, paid: 0, invoiced: 0 },
})

describe('client card undos', () => {
  const openCard = async (toasts: any[]) => {
    ;(globalThis as any).fetch = vi.fn(async (url: any) => {
      if (/\/profile/.test(String(url))) return { ok: true, json: async () => profilePayload() } as any
      return { ok: true, json: async () => ({}) } as any
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<ClientProfile clientId="lead-9" onClose={() => {}} setToast={(t: any) => toasts.push(t)} />)
    })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })
    cleanup.push(async () => { await act(async () => { root.unmount() }); host.remove() })
    const more = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'More')
    await act(async () => { more!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  }
  const pick = (id: string) => act(async () => {
    document.querySelector(`[data-testid="${id}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

  it('Mark as junk on the card raises its undo with duration 6000', async () => {
    const toasts: any[] = []
    await openCard(toasts)
    await pick('menu-junk')
    await pick('menu-confirm-junk-yes')
    expect(toasts.at(-1)?.kind).toBe('success')
    expect(toasts.at(-1)?.duration).toBe(6000)
  })

  it('Dismiss on the card raises its undo with duration 6000, matching the Inbox', async () => {
    const toasts: any[] = []
    await openCard(toasts)
    await pick('menu-dismiss')
    await pick('menu-confirm-dismiss-yes')
    expect(toasts.at(-1)?.kind).toBe('success')
    expect(toasts.at(-1)?.duration).toBe(6000)
  })
})
