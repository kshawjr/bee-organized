// @vitest-environment happy-dom
//
// "Report a problem with this engagement" — the EngagementPanel "···" masthead
// menu item (#131b). MOUNT tests on the LIVE surface (EngagementPanel is the
// only engagement surface with an actions menu; the board card + grouped-list
// rows open the panel on click and have none). Same seam as #131: the item
// hands an ID-ONLY context up via onReportProblem (which BeeHub wires to open
// the shared FeedbackModal).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import EngagementPanel from '@/components/hive/EngagementPanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const eng = (over: any = {}) => ({
  id: 'e-1', client_id: 'c1', client_name: 'Pat Tester', location_uuid: 'loc-uuid-1',
  title: 'Garage organization', stage: 'Estimate', founded_by: 'quote',
  created_at: daysAgo(3), stage_entered_at: daysAgo(3),
  total_invoiced: 900, total_paid: 900, balance_owing: 0, repeat_count: 1,
  ...over,
})
const emptyChildren = () => ({ service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] })
const client = (over: any = {}) => ({
  id: 'c1', name: 'Pat Tester', email: 'pat@x.com', phone: '(561) 555-0100', source: null,
  referred_by_kind: null, referred_by_id: null, referred_by_name: null, buzz: [],
  lifetime_paid: 900, prior_engagements: 0, other_open: 0,
  jobber_connected: false, reviews_link: null, location_name: 'Palm Beach',
  ...over,
})

let panelPayload: any = null
const fetchMock = vi.fn(async (url: any, init?: any) => {
  const method = init?.method
  if (method === 'PATCH') return { ok: true, json: async () => ({ id: 'e-1', stage: JSON.parse(init.body).stage }) } as any
  return { ok: true, json: async () => panelPayload } as any
})

const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

beforeEach(() => {
  panelPayload = null
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('localStorage', lsMock)
  lsStore.clear()
  document.body.innerHTML = ''
})
afterEach(() => { vi.unstubAllGlobals() })

function mount(el: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(el) })
  return container
}
async function fire(node: Element, type = 'click') {
  await act(async () => { node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })) })
}
const settle = () => act(async () => {})
const recordTrigger = (c: Element) => c.querySelector('[data-bee-record-menu-trigger]') as HTMLButtonElement | null
const openMenu = async (c: Element) => { const t = recordTrigger(c); if (t) await fire(t) }
const menuItem = (t: string) =>
  [...document.querySelectorAll('[data-bee-record-menu] button')].find(b => (b.textContent || '').includes(t)) as HTMLButtonElement | undefined

const mountPanel = async (engagement: any, over: any = {}) => {
  panelPayload = { engagement, children: emptyChildren(), client: client() }
  const onReportProblem = over.onReportProblem || vi.fn()
  const container = mount(
    <EngagementPanel engagementId={engagement.id} seed={engagement}
      onClose={() => {}} onChanged={() => {}} setToast={() => {}}
      onReportProblem={onReportProblem} readOnly={over.readOnly || false} />
  )
  await settle()
  return { container, onReportProblem }
}

describe('menu item — present on the engagement panel and opens the feedback flow', () => {
  it('the "···" menu offers "Report a problem with this engagement"', async () => {
    const { container } = await mountPanel(eng())
    await openMenu(container)
    expect(menuItem('Report a problem with this engagement')).toBeTruthy()
    // Alongside the open-engagement close-out action.
    expect(menuItem('Mark as Closed Lost')).toBeTruthy()
  })

  it('clicking it fires onReportProblem (the seam BeeHub uses to open FeedbackModal)', async () => {
    const onReportProblem = vi.fn()
    const { container } = await mountPanel(eng(), { onReportProblem })
    await openMenu(container)
    await fire(menuItem('Report a problem with this engagement')!)
    expect(onReportProblem).toHaveBeenCalledTimes(1)
  })
})

describe('the context — kind "engagement" with engagement_id + lead_id, and NO PII', () => {
  it('carries kind/engagement_id/lead_id/location_id/stage', async () => {
    const onReportProblem = vi.fn()
    const { container } = await mountPanel(eng({ stage: 'Estimate' }), { onReportProblem })
    await openMenu(container)
    await fire(menuItem('Report a problem with this engagement')!)

    const arg = onReportProblem.mock.calls[0][0]
    expect(arg.context).toEqual({
      kind: 'engagement',
      engagement_id: 'e-1',
      lead_id: 'c1',
      location_id: 'loc-uuid-1',
      stage: 'Estimate',
      screen: 'Clients',
      path: '/clients/c1?e=e-1',
      origin: 'engagement_panel_menu',
    })
  })

  it('the context contains NO client name, deal title, email, phone, or financials', async () => {
    const onReportProblem = vi.fn()
    const { container } = await mountPanel(eng(), { onReportProblem })
    await openMenu(container)
    await fire(menuItem('Report a problem with this engagement')!)

    const ctx = JSON.stringify(onReportProblem.mock.calls[0][0].context)
    expect(ctx).not.toContain('Pat Tester')          // no client name
    expect(ctx).not.toContain('Garage organization')  // no deal title
    expect(ctx).not.toContain('pat@x.com')            // no email
    expect(ctx).not.toContain('555')                  // no phone
    expect(ctx).not.toContain('900')                  // no financials
  })
})

describe('read-only visibility — everyone can report', () => {
  it('read-only still shows Report, but hides the mutating close-out actions', async () => {
    const onReportProblem = vi.fn()
    const { container } = await mountPanel(eng({ stage: 'Estimate' }), { readOnly: true, onReportProblem })
    // The "···" trigger renders (menu is non-empty because of Report)…
    expect(recordTrigger(container)).toBeTruthy()
    await openMenu(container)
    expect(menuItem('Report a problem with this engagement')).toBeTruthy()
    expect(menuItem('Mark as Closed Lost')).toBeFalsy()
    // …and it still fires.
    await fire(menuItem('Report a problem with this engagement')!)
    expect(onReportProblem).toHaveBeenCalledTimes(1)
  })
})
