// @vitest-environment happy-dom
//
// Engagement stage control — linked vs local (2026-07-09):
//   THE PRINCIPLE: the Won/Lost confirmation popup binds to HUMAN UI
//   INTENT, never to the Won stage value. Automated writers (import
//   backfill, webhook derivation, panel-open drift recovery) write
//   stage directly and silently; only the human close paths (··· menu
//   Close + board drag-to-close) raise the confirm.
//
//   A) isJobberLinked — "linked" = ANY child record (SR/quote/job/
//      invoice/assessment); the inverse of canSendToJobber.
//   B) Panel: Advance renders for LOCAL engagements only (linked stage
//      is Jobber-driven); the ··· Close flow is the SHARED confirm.
//   C) Board: pipeline drags no-op for linked cards (toast, no PATCH);
//      local pipeline drags commit directly. Drag-to-close (both card
//      types) is PENDING — drop opens the shared popup, confirm
//      commits the terminal PATCH, cancel snaps the card back with
//      zero writes.
//   D) One popup, one write path: panel menu-close and board drag-close
//      both render shared/CloseEngagementConfirm (source-pinned).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'fs'
import EngagementBoard from '@/components/hive/EngagementBoard'
import EngagementPanel from '@/components/hive/EngagementPanel'
import { isJobberLinked } from '@/components/hive/shared/engagementStatus'
import { CLOSED_WON, CLOSED_LOST } from '@/components/hive/shared/stageConfig'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

// ── fixtures ──────────────────────────────────────────────────
const eng = (over: any = {}) => ({
  id: `e-${Math.random().toString(36).slice(2, 8)}`,
  client_id: 'c1',
  client_name: 'Pat Tester',
  location_uuid: 'loc-uuid-1',
  title: 'Garage organization',
  stage: 'Request',
  founded_by: 'manual',
  created_at: daysAgo(3),
  stage_entered_at: daysAgo(3),
  nurture_started_at: null,
  total_invoiced: 0, total_paid: 0, balance_owing: 0,
  repeat_count: 1,
  service_requests: [], quotes: [], jobs: [], invoices: [], assessments: [],
  ...over,
})

const LINKED = eng({
  id: 'e-linked', client_name: 'Lin Linked', stage: 'Estimate', founded_by: 'quote',
  quotes: [{ id: 'q1', status: 'sent', total: 800, sent_at: daysAgo(2) }],
})
const LOCAL = eng({ id: 'e-local', client_name: 'Manny Manual', stage: 'Request' })

const emptyChildren = () => ({ service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] })
const clientPayload = { id: 'c1', name: 'Pat Tester', email: null, phone: null, source: null, referred_by_kind: null, referred_by_id: null, referred_by_name: null, buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0 }

// ── fetch mock: GET returns the queued panel payload; every PATCH is
//    recorded and echoes { stage } back like the real route. ─────
let panelPayload: any = null
let patchCalls: { url: string; body: any }[] = []
const fetchMock = vi.fn(async (url: any, init?: any) => {
  if (init?.method === 'PATCH') {
    const body = JSON.parse(init.body)
    patchCalls.push({ url: String(url), body })
    return { ok: true, json: async () => ({ id: 'x', stage: body.stage, changed: true }) } as any
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
  panelPayload = null
  patchCalls = []
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
async function drag(node: Element, type: string) {
  await act(async () => { node.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })) })
}
const settle = () => act(async () => {}) // flush the panel's GET

const buttons = (c: Element) => [...c.querySelectorAll('button')] as HTMLButtonElement[]
const btnByText = (c: Element, t: string) => buttons(c).find(b => (b.textContent || '').includes(t))
const cardOf = (c: Element, name: string) =>
  ([...c.querySelectorAll('[draggable="true"]')] as HTMLElement[]).find(d => (d.textContent || '').includes(name))

// ── A) the linked/local predicate ─────────────────────────────
describe('isJobberLinked — any child record makes an engagement linked', () => {
  it('true for each child family, false only for zero children', () => {
    expect(isJobberLinked(LOCAL)).toBe(false)
    expect(isJobberLinked(LINKED)).toBe(true)
    expect(isJobberLinked(eng({ service_requests: [{ id: 'sr1' }] }))).toBe(true)
    expect(isJobberLinked(eng({ jobs: [{ id: 'j1' }] }))).toBe(true)
    expect(isJobberLinked(eng({ invoices: [{ id: 'i1' }] }))).toBe(true)
    expect(isJobberLinked(eng({ assessments: [{ id: 'a1' }] }))).toBe(true)
    // Works on the panel's children object too (same keys).
    expect(isJobberLinked(emptyChildren())).toBe(false)
    expect(isJobberLinked({ ...emptyChildren(), quotes: [{ id: 'q' }] })).toBe(true)
  })

  it('the board rows ship service_requests so request-founded engagements read as linked', () => {
    const src = readFileSync('app/_hub-page.tsx', 'utf8')
    expect(src).toContain('serviceReqsByEng')
    expect(src).toMatch(/service_requests: \(serviceReqsByEng\[e\.id\]/)
  })
})

// ── B) panel: Advance gating + shared menu close ──────────────
describe('EngagementPanel — Advance is local-only; ··· Close is the shared confirm', () => {
  const mountPanel = async (engagement: any, children: any) => {
    panelPayload = { engagement, children, client: clientPayload }
    const onChanged = vi.fn()
    const container = mount(
      <EngagementPanel engagementId={engagement.id} seed={engagement} onClose={() => {}} onChanged={onChanged} />
    )
    await settle()
    return { container, onChanged }
  }

  it('LINKED: no Advance button — Jobber drives the pipeline stage', async () => {
    const { container } = await mountPanel(LINKED, { ...emptyChildren(), quotes: [{ id: 'q1', status: 'sent', total: 800 }] })
    expect(container.textContent).toContain('Pat Tester') // panel loaded (client name is the headline)
    expect(btnByText(container, 'Advance to')).toBeUndefined()
  })

  it('LOCAL: Advance renders and PATCHes the next stage (its only stage mover)', async () => {
    const { container } = await mountPanel(LOCAL, emptyChildren())
    const adv = btnByText(container, 'Advance to Estimate')!
    expect(adv).toBeTruthy()
    await fire(adv)
    expect(patchCalls.length).toBe(1)
    expect(patchCalls[0].url).toContain(`/api/engagements/${LOCAL.id}`)
    expect(patchCalls[0].body).toEqual({ stage: 'Estimate' })
  })

  it('··· menu Close opens the shared confirm for LINKED too; cancel writes nothing', async () => {
    const { container } = await mountPanel(LINKED, { ...emptyChildren(), quotes: [{ id: 'q1', status: 'sent', total: 800 }] })
    await fire(container.querySelector('[aria-label="More"]')!)
    await fire(btnByText(container, 'Close engagement…')!)
    expect(container.textContent).toContain('Close as')
    expect(container.querySelector('select')).toBeTruthy() // Lost reason picker (Lost is the default)
    await fire(btnByText(container, 'Cancel')!)
    expect(container.textContent).not.toContain('Close as lost')
    expect(patchCalls.length).toBe(0)
  })

  it('confirming Lost PATCHes the terminal stage + reason through the one write path', async () => {
    const { container, onChanged } = await mountPanel(LOCAL, emptyChildren())
    await fire(container.querySelector('[aria-label="More"]')!)
    await fire(btnByText(container, 'Close engagement…')!)
    await fire(btnByText(container, 'Close as lost')!)
    expect(patchCalls.length).toBe(1)
    expect(patchCalls[0].body.stage).toBe(CLOSED_LOST)
    expect(patchCalls[0].body.closed_reason).toBe('lost_no_response')
    expect(onChanged).toHaveBeenCalledWith(LOCAL.id, { stage: CLOSED_LOST })
  })

  it('Won gate: owing invoices disable the Won segment and its confirm', async () => {
    const owing = { ...emptyChildren(), jobs: [{ id: 'j1', completed_at: daysAgo(1) }], invoices: [{ id: 'i1', status: 'sent', total: 900, balance_owing: 900 }] }
    const { container } = await mountPanel(eng({ id: 'e-owing', stage: 'Final Processing' }), owing)
    await fire(container.querySelector('[aria-label="More"]')!)
    await fire(btnByText(container, 'Close engagement…')!)
    const wonSeg = buttons(container).find(b => (b.textContent || '') === 'Won')!
    expect(wonSeg.disabled).toBe(true)
  })

  it('drift-corrected stage from the GET propagates to the board via onChanged', async () => {
    // Board row (the seed) still says Estimate; the GET route already
    // drift-recovered to Job in Progress — the panel pushes the
    // correction back so the board row doesn't stay stale.
    const corrected = { ...LINKED, stage: 'Job in Progress' }
    panelPayload = {
      engagement: corrected,
      children: { ...emptyChildren(), quotes: LINKED.quotes, jobs: [{ id: 'j1', status: 'active' }] },
      client: clientPayload,
    }
    const onChanged = vi.fn()
    mount(<EngagementPanel engagementId={corrected.id} seed={LINKED} onClose={() => {}} onChanged={onChanged} />)
    await settle()
    expect(onChanged).toHaveBeenCalledWith(corrected.id, { stage: 'Job in Progress' })
  })
})

// ── C) board: pipeline drags + drag-to-close pending flow ─────
describe('EngagementBoard — linked pipeline drag no-ops; drag-to-close is pending + shared popup', () => {
  const mountBoard = (rows: any[] = [LINKED, LOCAL]) => {
    const setToast = vi.fn()
    const container = mount(
      <EngagementBoard engagements={rows as any} closedCount={0} setToast={setToast} />
    )
    return { container, setToast }
  }
  const dropOnCol = async (container: Element, name: string, colKey: string) => {
    await drag(cardOf(container, name)!, 'dragstart')
    await drag(container.querySelector(`[data-board-col="${colKey}"]`)!, 'drop')
  }

  it('LINKED pipeline drag → no PATCH, Jobber-drives toast', async () => {
    const { container, setToast } = mountBoard()
    await dropOnCol(container, 'Lin Linked', 'Job in Progress')
    expect(patchCalls.length).toBe(0)
    expect(setToast).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining('Jobber drives') }))
    // Card stays in its column.
    expect(container.querySelector('[data-board-col="Estimate"]')!.textContent).toContain('Lin Linked')
  })

  it('LOCAL pipeline drag commits directly — no popup for pipeline moves', async () => {
    const { container } = mountBoard()
    await dropOnCol(container, 'Manny Manual', 'Estimate')
    expect(patchCalls.length).toBe(1)
    expect(patchCalls[0].url).toContain(`/api/engagements/${LOCAL.id}`)
    expect(patchCalls[0].body).toEqual({ stage: 'Estimate' })
    expect(container.textContent).not.toContain('Close as') // never the popup
  })

  it('while dragging, the won/lost close zones replace the closed rail', async () => {
    const { container } = mountBoard()
    expect(container.querySelector('[aria-label="Close as won"]')).toBeNull()
    await drag(cardOf(container, 'Lin Linked')!, 'dragstart')
    expect(container.querySelector('[aria-label="Close as won"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Close as lost"]')).toBeTruthy()
    // Drag end without a drop → zones fold back to the rail.
    await drag(cardOf(container, 'Lin Linked')!, 'dragend')
    expect(container.querySelector('[aria-label="Close as won"]')).toBeNull()
    expect(container.querySelector('[aria-label="Expand closed engagements"]')).toBeTruthy()
  })

  it('drop on Closed WON: popup opens PENDING (no PATCH), card visually in the closing column', async () => {
    const { container } = mountBoard()
    await drag(cardOf(container, 'Lin Linked')!, 'dragstart')
    await drag(container.querySelector('[aria-label="Close as won"]')!, 'drop')
    expect(patchCalls.length).toBe(0)                            // NOT committed on drop
    expect(container.textContent).toContain('Closing — won')
    expect(container.textContent).toContain('Close as')          // the shared confirm
    expect(btnByText(container, 'Close as won')).toBeTruthy()    // Won preselected
    // The card left its pipeline column and sits in the pending column.
    expect(container.querySelector('[data-board-col="Estimate"]')!.textContent).not.toContain('Lin Linked')
  })

  it('CANCEL snaps the card back to its prior column with zero writes (linked and local)', async () => {
    const { container } = mountBoard()
    for (const [name, col] of [['Lin Linked', 'Estimate'], ['Manny Manual', 'Request']] as const) {
      await drag(cardOf(container, name)!, 'dragstart')
      await drag(container.querySelector('[aria-label="Close as lost"]')!, 'drop')
      expect(container.querySelector(`[data-board-col="${col}"]`)!.textContent).not.toContain(name)
      await fire(btnByText(container, 'Cancel')!)
      expect(container.querySelector(`[data-board-col="${col}"]`)!.textContent).toContain(name)
    }
    expect(patchCalls.length).toBe(0)
  })

  it('drop on Closed LOST + confirm: reason picker shows, terminal PATCH commits on confirm only', async () => {
    const { container } = mountBoard()
    await drag(cardOf(container, 'Manny Manual')!, 'dragstart')
    await drag(container.querySelector('[aria-label="Close as lost"]')!, 'drop')
    expect(container.textContent).toContain('Closing — lost')
    const select = container.querySelector('select')! as HTMLSelectElement
    expect(select).toBeTruthy()                                  // the Lost reason picker
    expect(patchCalls.length).toBe(0)
    await fire(btnByText(container, 'Close as lost')!)
    expect(patchCalls.length).toBe(1)
    expect(patchCalls[0].url).toContain(`/api/engagements/${LOCAL.id}`)
    expect(patchCalls[0].body.stage).toBe(CLOSED_LOST)
    expect(patchCalls[0].body.closed_reason).toBe('lost_no_response')
    // Pending column resolved; card did not return to the pipeline.
    expect(container.textContent).not.toContain('Closing — lost')
    expect(container.querySelector('[data-board-col="Request"]')!.textContent).not.toContain('Manny Manual')
  })

  it('Won gate holds on drag-close: owing invoices disable Won in the popup', async () => {
    const owingRow = eng({
      id: 'e-owing', client_name: 'Owen Owing', stage: 'Final Processing',
      jobs: [{ id: 'j1', completed_at: daysAgo(1) }],
      invoices: [{ id: 'i1', status: 'sent', total: 900, balance_owing: 900 }],
    })
    const { container } = mountBoard([owingRow])
    await drag(cardOf(container, 'Owen Owing')!, 'dragstart')
    await drag(container.querySelector('[aria-label="Close as won"]')!, 'drop')
    const wonSeg = buttons(container).find(b => (b.textContent || '') === 'Won')!
    expect(wonSeg.disabled).toBe(true)
    const confirm = btnByText(container, 'Close as won')! as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(patchCalls.length).toBe(0)
  })

  it('confirming a WON close commits stage + reason won through the same PATCH', async () => {
    const paidRow = eng({
      id: 'e-paid', client_name: 'Paula Paid', stage: 'Final Processing',
      jobs: [{ id: 'j1', completed_at: daysAgo(1) }],
      invoices: [{ id: 'i1', status: 'paid', total: 900, balance_owing: 0 }],
    })
    const { container } = mountBoard([paidRow])
    await drag(cardOf(container, 'Paula Paid')!, 'dragstart')
    await drag(container.querySelector('[aria-label="Close as won"]')!, 'drop')
    await fire(btnByText(container, 'Close as won')!)
    expect(patchCalls.length).toBe(1)
    expect(patchCalls[0].body.stage).toBe(CLOSED_WON)
    expect(patchCalls[0].body.closed_reason).toBe('won')
  })
})

// ── D) one popup, one write path — source-pinned ──────────────
describe('shared close flow — single component, single write path', () => {
  it('panel and board both render shared/CloseEngagementConfirm; neither carries a private close PATCH', () => {
    const panel = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')
    const board = readFileSync('components/hive/EngagementBoard.jsx', 'utf8')
    expect(panel).toContain("from './shared/CloseEngagementConfirm'")
    expect(board).toContain("from './shared/CloseEngagementConfirm'")
    // The terminal close body (closed_reason) is built ONLY inside the
    // shared component — no fork can drift the write path.
    expect(panel).not.toContain('closed_reason')
    expect(board).not.toContain('closed_reason')
    const shared = readFileSync('components/hive/shared/CloseEngagementConfirm.jsx', 'utf8')
    expect(shared).toContain('closed_reason')
    expect(shared).toMatch(/method: 'PATCH'/)
  })

  it('the automated stage writers never import the human popup', () => {
    for (const f of ['lib/engagements.ts', 'lib/jobber-webhook-handlers.ts', 'app/api/import/jobber-clients/route.ts', 'app/api/engagements/[id]/route.ts']) {
      expect(readFileSync(f, 'utf8')).not.toContain('CloseEngagementConfirm')
    }
  })
})
