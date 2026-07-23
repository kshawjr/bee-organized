// @vitest-environment happy-dom
//
// Fix 2 / Phase 4b — the record lenses on 'All Locations', MOUNTED.
//
// 'All Locations' is a corporate overview, not a data scope. Every surface that
// enumerates records belonging to a specific location asks you to pick one; the
// cross-location surfaces (the unrouted transfer queue, the home overview,
// search) stay live.
//
// Phase 4 kept the Engagements board live on 'all', blending Kansas City,
// Portland and Temecula deals into shared stage columns. That is a blend, not a
// view — no column of it is workable. 4b puts it behind the same prompt.
//
// These MOUNT rather than pin source, for the reason the Home hotfix exists:
// BeeHub/HiveShell are JS, `next build` cannot catch an unbound identifier, and
// a readFileSync+toContain pin cannot either — the string is present, it just
// doesn't resolve. Only executing the render does. (App's own lens content is a
// next/dynamic chunk that will not resolve under vitest, so HiveShell is
// mounted directly here; App's shell/Home bindings are covered in
// lib/beta-home-mounts.test.tsx.)
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
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
const now = Date.now()

const person = (o: any = {}) => ({
  id: `p-${Math.random().toString(36).slice(2, 8)}`,
  name: 'Sarah Mitchell', email: 's@x.com', phone: '(561) 555-0199',
  locationId: KC, created: new Date(now - 3 * 86400000).toISOString(),
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null, jobberRef: null,
  outreachTimeline: [], atLocOther: false,
  originCity: null, originState: null, originZip: null, project: '',
  ...o,
})

const locOther = (o: any = {}) => person({
  name: 'Global Lead', locationId: 'loc-other-uuid', atLocOther: true,
  originCity: 'Austin', originState: 'TX', originZip: '78701', project: 'Garage', ...o,
})

const engagement = (o: any = {}) => ({
  id: `e-${Math.random().toString(36).slice(2, 8)}`,
  client_id: 'c1', client_name: 'Sarah Mitchell', stage: 'Estimate',
  location_uuid: KC, created_at: new Date(now).toISOString(),
  quotes: [], jobs: [], invoices: [], assessments: [], service_requests: [],
  ...o,
})

let cleanup: Array<() => void> = []
afterEach(() => { cleanup.forEach(fn => fn()); cleanup = [] })

async function mount(props: any) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  await act(async () => { root.render(React.createElement(HiveShell as any, props)) })
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  cleanup.push(() => { errSpy.mockRestore(); try { root.unmount() } catch {} host.remove() })
  return host
}

const base = (over: any = {}) => ({
  engagements: [], people: [], transferPeople: [],
  locFilter: 'all', locations: [{ id: KC, name: 'Kansas City' }],
  locationUsers: [], currentUserId: 'u1', currentLocationUuid: null,
  closedCount: 0, closedWonCount: 0,
  ...over,
})

describe("HiveShell on 'All Locations' — every record lens prompts", () => {
  it('ENGAGEMENTS shows the prompt instead of a blended board', async () => {
    // The 4b change. A board mixing several locations' deals into one set of
    // stage columns is not a view anyone can work.
    const host = await mount(base({
      locationRequired: true,
      engagements: [engagement()],   // even WITH rows, 'all' must not render them
      onOpenLocationPicker: vi.fn(),
    }))
    expect(host.textContent).toContain('Engagements work one location at a time')
    expect(host.textContent).toContain('All Locations')
  })

  it('the prompt OPENS the switcher — the picker is one click away', async () => {
    const onPick = vi.fn()
    const host = await mount(base({ locationRequired: true, onOpenLocationPicker: onPick }))
    const btn = Array.from(host.querySelectorAll('button')).find(b => (b.textContent || '').includes('Choose a location'))
    expect(btn).toBeTruthy()
    await act(async () => { (btn as HTMLButtonElement).click() })
    expect(onPick).toHaveBeenCalled()
  })

  it('CLIENT LIST shows the same prompt, from the same component', async () => {
    const host = await mount(base({ locationRequired: true, initialIntent: { tab: 'clients' }, onOpenLocationPicker: vi.fn() }))
    const clientsTab = Array.from(host.querySelectorAll('button')).find(b => /client list/i.test(b.textContent || ''))
    if (clientsTab) await act(async () => { clientsTab.click() })
    expect(host.textContent).toContain('one location at a time')
  })

  it('the INBOX keeps the transfer queue AND prompts below it', async () => {
    // The Phase 4 regression this fixes: the prompt replaced the WHOLE Inbox,
    // taking the loc_other routing queue down on 'all'. Leslie routes unrouted
    // leads from there, and they belong to no location — so the queue is
    // cross-location work that 'all' is exactly the right scope for.
    const host = await mount(base({
      locationRequired: true,
      transferPeople: [locOther()],
      onOpenLocationPicker: vi.fn(),
    }))
    const inboxTab = Array.from(host.querySelectorAll('button')).find(b => /inbox/i.test(b.textContent || ''))
    expect(inboxTab).toBeTruthy()
    await act(async () => { (inboxTab as HTMLButtonElement).click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(host.textContent).toContain('Needs transfer')
    expect(host.textContent).toContain('Global Lead')
    expect(host.textContent).toContain('The inbox works one location at a time')
  })

  it('copy never says the data is missing — it says how the product works', async () => {
    const host = await mount(base({ locationRequired: true, onOpenLocationPicker: vi.fn() }))
    const text = host.textContent || ''
    expect(text).toContain('one location at a time')
    // Never "no results" / "nothing loaded" / an error — the prompt describes
    // how the product works, not an absence of data.
    for (const wrong of ['No engagements', 'No results', 'nothing loaded', 'No data']) {
      expect(text).not.toContain(wrong)
    }
  })
})

describe('HiveShell on a SCOPED load — unchanged', () => {
  it('renders the board, never the prompt', async () => {
    const host = await mount(base({
      locFilter: KC,
      locationRequired: false,
      engagements: [engagement({ client_name: 'Sarah Mitchell' })],
      people: [person({ id: 'c1' })],
    }))
    // Positive assertion: the board actually rendered this engagement's client,
    // so "no prompt" cannot pass by rendering nothing at all.
    expect(host.textContent).toContain('Sarah Mitchell')
    expect(host.textContent).not.toContain('one location at a time')
  })

  it('the Inbox renders New/Attempting normally when scoped', async () => {
    const host = await mount(base({
      locFilter: KC,
      locationRequired: false,
      people: [person({ id: 'c9', name: 'Fresh Lead' })],
    }))
    const inboxTab = Array.from(host.querySelectorAll('button')).find(b => /inbox/i.test(b.textContent || ''))
    await act(async () => { (inboxTab as HTMLButtonElement).click() })
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(host.textContent).toContain('Fresh Lead')
    expect(host.textContent).not.toContain('one location at a time')
  })
})
