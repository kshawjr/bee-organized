// @vitest-environment happy-dom
//
// Engagement close FLOWS (Part 1-4):
//   1) ··· masthead menu (RecordMenu) — portal-rendered so the overlay
//      card can't clip it; houses the close actions (no action-bar Close
//      button). Open engagement → Won/Lost; Closed Lost → Reopen;
//      Closed Won → no Reopen (out of scope).
//   2) Close-LOST wizard — reason step (Other requires a note) + follow-up
//      step that writes a REAL touchpoints marker.
//   3) Close-WON wizard — 4-step stepper; invoice total; satisfaction
//      branch (unhappy → real flag); Google review offer (link present vs
//      absent); re-engage marker; Won commits reason 'won'.
//   4) Reopen — the ··· item POSTs the reopen route.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import EngagementPanel from '@/components/hive/EngagementPanel'
import { CLOSED_WON, CLOSED_LOST } from '@/components/hive/shared/stageConfig'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const eng = (over: any = {}) => ({
  id: 'e-1', client_id: 'c1', client_name: 'Pat Tester', location_uuid: 'loc-uuid-1',
  title: 'Garage organization', stage: 'Estimate', founded_by: 'quote',
  created_at: daysAgo(3), stage_entered_at: daysAgo(3), nurture_started_at: null,
  total_invoiced: 0, total_paid: 0, balance_owing: 0, repeat_count: 1,
  ...over,
})
const emptyChildren = () => ({ service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] })
const client = (over: any = {}) => ({
  id: 'c1', name: 'Pat Tester', email: null, phone: null, source: null,
  referred_by_kind: null, referred_by_id: null, referred_by_name: null, buzz: [],
  lifetime_paid: 0, prior_engagements: 0, other_open: 0,
  jobber_connected: false, reviews_link: null, location_name: 'Palm Beach',
  ...over,
})

// ── fetch mock: records PATCH / touchpoint POST / reopen POST; GET
//    returns the queued panel payload. ──────────────────────────
let panelPayload: any = null
let patchCalls: { url: string; body: any }[] = []
let touchpointPosts: any[] = []
let reopenPosts: string[] = []
const fetchMock = vi.fn(async (url: any, init?: any) => {
  const u = String(url)
  const method = init?.method
  if (method === 'PATCH' && /\/api\/engagements\//.test(u)) {
    const body = JSON.parse(init.body)
    patchCalls.push({ url: u, body })
    return { ok: true, json: async () => ({ id: 'e-1', stage: body.stage, changed: true }) } as any
  }
  if (method === 'POST' && /\/api\/engagements\/[^/]+\/reopen$/.test(u)) {
    reopenPosts.push(u)
    return { ok: true, json: async () => ({ reopened: true, stage: 'Estimate', prev_stage: 'Closed Lost' }) } as any
  }
  if (method === 'POST' && /\/api\/touchpoints$/.test(u)) {
    const body = JSON.parse(init.body)
    touchpointPosts.push(body)
    return { ok: true, json: async () => ({ touchpoint: { id: 't1', ...body } }) } as any
  }
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
  panelPayload = null; patchCalls = []; touchpointPosts = []; reopenPosts = []
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
const buttons = (c: Element) => [...c.querySelectorAll('button')] as HTMLButtonElement[]
const btnByText = (c: Element, t: string) => buttons(c).find(b => (b.textContent || '').includes(t))
const recordTrigger = (c: Element) => c.querySelector('[data-bee-record-menu-trigger]') as HTMLButtonElement | null
const openMenu = async (c: Element) => { await fire(recordTrigger(c)!) }
const menu = () => document.querySelector('[data-bee-record-menu]') as HTMLElement | null
const menuItem = (t: string) =>
  [...document.querySelectorAll('[data-bee-record-menu] button')].find(b => (b.textContent || '').includes(t)) as HTMLButtonElement | undefined

const mountPanel = async (engagement: any, children: any, cl: any = client()) => {
  panelPayload = { engagement, children, client: cl }
  const onChanged = vi.fn()
  const container = mount(<EngagementPanel engagementId={engagement.id} seed={engagement} onClose={() => {}} onChanged={onChanged} />)
  await settle()
  return { container, onChanged }
}

// ── Part 1: the ··· portal menu ───────────────────────────────
describe('··· masthead menu — portal, close actions, reopen visibility', () => {
  it('open engagement: menu portals OUT of the panel container and offers Lost (Won never in the menu; Reopen is closed-only)', async () => {
    // eng() defaults to the Request stage — Lost is always available on an
    // OPEN engagement. Won is NEVER a menu item (the ready-to-close button
    // owns Close Won; the full matrix lives in beta-record-menu-visibility.test).
    const { container } = await mountPanel(eng(), emptyChildren())
    expect(btnByText(container, 'Close…')).toBeUndefined()
    await openMenu(container)
    const m = menu()!
    expect(m, 'menu renders').toBeTruthy()
    // Portaled to <body>, fixed — cannot be clipped by the overlay card.
    expect(m.parentElement).toBe(document.body)
    expect(container.contains(m)).toBe(false)
    expect(m.style.position).toBe('fixed')
    expect(menuItem('Mark as Closed Lost')).toBeTruthy()
    expect(menuItem('Mark as Closed Won')).toBeFalsy() // never a menu item
    expect(menuItem('Reopen')).toBeFalsy()
  })

  it('Closed LOST: menu offers Reopen, not close actions', async () => {
    const { container } = await mountPanel(eng({ stage: 'Closed Lost', closed_reason: 'lost_no_response' }), emptyChildren())
    await openMenu(container)
    expect(menuItem('Reopen')).toBeTruthy()
    expect(menuItem('Mark as Closed Won')).toBeFalsy()
    expect(menuItem('Mark as Closed Lost')).toBeFalsy()
  })

  it('Closed WON: no Reopen (out of scope) — menu has no items, so no trigger renders', async () => {
    const { container } = await mountPanel(eng({ stage: 'Closed Won', closed_reason: 'won' }), emptyChildren())
    expect(recordTrigger(container)).toBeFalsy()
  })

  it('reopen from the ··· menu POSTs the reopen route', async () => {
    const { container, onChanged } = await mountPanel(eng({ stage: 'Closed Lost', closed_reason: 'lost_other' }), emptyChildren())
    await openMenu(container)
    await fire(menuItem('Reopen')!)
    await settle()
    expect(reopenPosts).toHaveLength(1)
    expect(reopenPosts[0]).toContain('/api/engagements/e-1/reopen')
    expect(onChanged).toHaveBeenCalledWith('e-1', { stage: 'Estimate' })
  })
})

// ── Part 2: Close-LOST wizard ─────────────────────────────────
describe('Close-Lost wizard — reason (Other requires note) + follow-up marker', () => {
  const openLost = async (container: Element) => { await openMenu(container); await fire(menuItem('Mark as Closed Lost')!) }

  it('Other requires a note: Next disabled until a note is typed', async () => {
    const { container } = await mountPanel(eng(), emptyChildren())
    await openLost(container)
    await fire(btnByText(container, 'Other')!)
    const next = btnByText(container, 'Next')! as HTMLButtonElement
    expect(next.disabled).toBe(true)
    const note = container.querySelector('textarea')! as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(note, 'went with a cheaper bid')
      note.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect((btnByText(container, 'Next')! as HTMLButtonElement).disabled).toBe(false)
  })

  it('follow-up step writes a REAL touchpoints marker + commits the lost close', async () => {
    const { container, onChanged } = await mountPanel(eng(), emptyChildren())
    await openLost(container)
    // default reason lost_no_response, straight to Next
    // no lookupOptions passed → wizard falls back to the canonical labels;
    // the first is 'No response' (stored verbatim now, not a slug).
    await fire(btnByText(container, 'Next')!)
    await fire(btnByText(container, 'Yes, remind me')!)
    const date = container.querySelector('input[type="date"]')! as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(date, '2026-09-01')
      date.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const reason = container.querySelector('input[placeholder="e.g. check back on budget"]')! as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(reason, 'check back on budget')
      reason.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await fire(btnByText(container, 'Close as lost')!)
    await settle()
    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0].body.stage).toBe(CLOSED_LOST)
    expect(patchCalls[0].body.closed_reason).toBe('No response')
    expect(touchpointPosts).toHaveLength(1)
    expect(touchpointPosts[0].kind).toBe('reach_out')
    expect(touchpointPosts[0].label).toContain('Follow-up')
    expect(touchpointPosts[0].status).toBe('pending')
    expect(touchpointPosts[0].occurred_at).toBeTruthy()
    expect(onChanged).toHaveBeenCalledWith('e-1', { stage: CLOSED_LOST })
  })

  it('skip follow-up: closes lost with NO marker written', async () => {
    const { container } = await mountPanel(eng(), emptyChildren())
    await openLost(container)
    await fire(btnByText(container, 'Next')!)
    await fire(btnByText(container, 'Close as lost')!)
    await settle()
    expect(patchCalls).toHaveLength(1)
    expect(touchpointPosts).toHaveLength(0)
  })

  // Admin picklist drives the wizard: the reason buttons are the
  // admin-configured LABELS (via lookupOptions.closeLostReasons), NOT the
  // hardcoded canonical fallback — and a brand-new admin reason is stored
  // VERBATIM in closed_reason (the PATCH route no longer coerces it).
  it('renders admin picklist labels and stores a net-new reason verbatim', async () => {
    panelPayload = { engagement: eng(), children: emptyChildren(), client: client() }
    const container = mount(
      <EngagementPanel
        engagementId="e-1"
        seed={eng()}
        onClose={() => {}}
        lookupOptions={{ sources: [], projectTypes: [], closeLostReasons: ['Price too high', 'Budget on hold', 'Other'] }}
      />,
    )
    await settle()
    await openLost(container)
    // admin labels present; canonical fallback label absent (picklist wins)
    expect(btnByText(container, 'Price too high')).toBeTruthy()
    expect(btnByText(container, 'Budget on hold')).toBeTruthy()
    expect(btnByText(container, 'No response')).toBeUndefined()
    // pick a net-new reason (not in any hardcoded enum), skip follow-up
    await fire(btnByText(container, 'Budget on hold')!)
    await fire(btnByText(container, 'Next')!)
    await fire(btnByText(container, 'Close as lost')!)
    await settle()
    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0].body.stage).toBe(CLOSED_LOST)
    expect(patchCalls[0].body.closed_reason).toBe('Budget on hold')
  })
})

// ── Part 3: Close-WON wizard ──────────────────────────────────
describe('Close-Won wizard — 4-step stepper, satisfaction, review, re-engage', () => {
  const paidChildren = () => ({ ...emptyChildren(), jobs: [{ id: 'j1', completed_at: daysAgo(1) }], invoices: [{ id: 'i1', status: 'paid', total: 1200, balance_owing: 0 }] })
  // Close Won left the ··· menu — the "Ready to close" button (shown at
  // Final Processing + fully paid, which wonEng/paidChildren satisfy) is now
  // the sole entry into the SAME CloseWonWizard.
  const openWon = async (container: Element) => { await fire(container.querySelector('[data-bee-ready-to-close]') as HTMLButtonElement) }
  const wonEng = () => eng({ id: 'e-1', stage: 'Final Processing', total_invoiced: 1200 })

  it('step 1 shows the invoice total and settled state; No royalty line', async () => {
    const { container } = await mountPanel(wonEng(), paidChildren())
    await openWon(container)
    expect(container.textContent).toContain('$1,200')
    expect(container.textContent).toContain('settled')
    expect((container.textContent || '').toLowerCase()).not.toContain('royalty')
  })

  it('HAPPY path: review offer shows the location link; re-engage marker + review marker written; Won commits reason won', async () => {
    const { container } = await mountPanel(wonEng(), paidChildren(), client({ reviews_link: 'https://g.page/r/bee/review' }))
    await openWon(container)
    await fire(btnByText(container, 'Next')!)                 // → satisfaction
    await fire(btnByText(container, 'Happy')!)
    await fire(btnByText(container, 'Next')!)                 // → close out
    expect(container.textContent).toContain('https://g.page/r/bee/review')
    await fire(btnByText(container, 'Copy review link')!)     // marks review requested
    await fire(btnByText(container, 'Next')!)                 // → re-engage
    expect(container.querySelector('input[type="date"]')).toBeTruthy()
    await fire(btnByText(container, 'Close as won')!)
    await settle()
    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0].body.stage).toBe(CLOSED_WON)
    expect(patchCalls[0].body.closed_reason).toBe('won')
    const labels = touchpointPosts.map(t => t.label)
    expect(labels.some(l => l.includes('Google review requested'))).toBe(true)
    expect(labels.some(l => l.includes('Re-engage'))).toBe(true)
    expect(labels.some(l => l.includes('Satisfaction'))).toBe(false)
  })

  it('UNHAPPY path: writes the satisfaction follow-up flag and skips the review offer', async () => {
    const { container } = await mountPanel(wonEng(), paidChildren(), client({ reviews_link: 'https://g.page/r/bee/review' }))
    await openWon(container)
    await fire(btnByText(container, 'Next')!)
    await fire(btnByText(container, 'Unhappy')!)
    await fire(btnByText(container, 'Next')!)                 // → close out (no review offer)
    expect(container.textContent).not.toContain('Copy review link')
    await fire(btnByText(container, 'Next')!)                 // → re-engage
    await fire(btnByText(container, 'Close as won')!)
    await settle()
    const labels = touchpointPosts.map(t => t.label)
    expect(labels.some(l => l.includes('Satisfaction follow-up needed'))).toBe(true)
  })

  it('no review link configured: skips gracefully (no copy control), still closes won', async () => {
    const { container } = await mountPanel(wonEng(), paidChildren(), client({ reviews_link: null }))
    await openWon(container)
    await fire(btnByText(container, 'Next')!)
    await fire(btnByText(container, 'Happy')!)
    await fire(btnByText(container, 'Next')!)
    expect(container.textContent).toContain('No Google review link is configured')
    expect(btnByText(container, 'Copy review link')).toBeUndefined()
    await fire(btnByText(container, 'Next')!)
    await fire(btnByText(container, 'Close as won')!)
    await settle()
    expect(patchCalls[0].body.stage).toBe(CLOSED_WON)
  })
})
