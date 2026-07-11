// @vitest-environment happy-dom
//
// Engagement stage control (2026-07-09, tightened 2026-07-10):
//   THE PRINCIPLE: the Won/Lost confirmation popup binds to HUMAN UI
//   INTENT, never to the Won stage value. Automated writers (import
//   backfill, webhook derivation, panel-open drift recovery) write
//   stage directly and silently; only the human close paths (··· menu
//   Close + board drag-to-close) raise the confirm.
//
//   MANUAL PIPELINE MOVES ARE GONE (decision 2026-07-10, Kevin): all
//   business flows through Jobber — a local engagement's stage
//   assertion is always fiction, so the panel Advance button and the
//   board's local-card pipeline drag were both removed. The ONLY human
//   stage write left is the terminal close.
//
//   A) isJobberLinked — "linked" = ANY child record (SR/quote/job/
//      invoice/assessment); the inverse of canSendToJobber.
//   B) Panel: NO Advance button for ANY engagement — linked OR local;
//      the ··· Close flow is the SHARED confirm.
//   C) Board: pipeline columns are not drop targets — dropping any
//      card on a column writes nothing and moves nothing. Drag-to-close
//      (both card types) is PENDING — drop opens the shared popup,
//      confirm commits the terminal PATCH, cancel snaps the card back
//      with zero writes.
//   D) One popup, one write path: panel menu-close and board drag-close
//      both render shared/CloseEngagementConfirm (source-pinned).
//   (API side: beta-stage-terminal-only.test.ts pins the route
//   rejection of non-terminal stage values.)
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
// Track mounted roots so afterEach can UNMOUNT them (runs effect cleanups →
// clears any pending timers, e.g. the close-out celebration's self-dismiss).
// Without this, a leaked setTimeout from a panel close test fires mid-render
// in a later board test ("Should not already be working" / stray removeChild).
const roots: any[] = []
afterEach(() => {
  roots.splice(0).forEach(r => { try { act(() => r.unmount()) } catch {} })
  vi.unstubAllGlobals()
})

function mount(el: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(el) })
  roots.push(root)
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

// The masthead ··· menu (RecordMenu) portals its items to <body>; the
// trigger lives in the panel container.
const recordTrigger = (c: Element) => c.querySelector('[data-bee-record-menu-trigger]') as HTMLButtonElement | null
const openRecordMenu = async (c: Element) => { await fire(recordTrigger(c)!) }
const menuItem = (t: string) =>
  [...document.querySelectorAll('[data-bee-record-menu] button')].find(b => (b.textContent || '').includes(t)) as HTMLButtonElement | undefined

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

// ── B) panel: no manual mover + shared action-bar close ───────
describe('EngagementPanel — no Advance for any engagement; the action-bar Close… is the shared confirm', () => {
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

  it('LOCAL: no Advance button either — the manual mover was removed 7/10 (stages move via Jobber)', async () => {
    const { container } = await mountPanel(LOCAL, emptyChildren())
    expect(container.textContent).toContain('Pat Tester') // panel loaded
    expect(btnByText(container, 'Advance to')).toBeUndefined()
    expect(btnByText(container, 'Advance')).toBeUndefined()
    expect(patchCalls.length).toBe(0)
  })

  it('close actions live in the ··· menu (no action-bar Close button); opening Lost shows the reason wizard, cancel writes nothing', async () => {
    const { container } = await mountPanel(LINKED, { ...emptyChildren(), quotes: [{ id: 'q1', status: 'sent', total: 800 }] })
    // The standalone action-bar Close… button is gone (Part 1).
    expect(btnByText(container, 'Close…')).toBeUndefined()
    expect(recordTrigger(container)).toBeTruthy()
    await openRecordMenu(container)
    // LINKED is at Estimate — Won is now gated to Final Processing + paid,
    // so only Lost surfaces here (full matrix: beta-record-menu-visibility).
    expect(menuItem('Mark as Closed Won')).toBeFalsy()
    expect(menuItem('Mark as Closed Lost')).toBeTruthy()
    await fire(menuItem('Mark as Closed Lost')!)
    expect(container.textContent).toContain('Close as lost')  // wizard open
    expect(container.textContent).toContain('No response')     // reason option
    await fire(btnByText(container, 'Cancel')!)
    expect(patchCalls.length).toBe(0)
  })

  it('confirming Lost PATCHes the terminal stage + reason through the one write path', async () => {
    const { container, onChanged } = await mountPanel(LOCAL, emptyChildren())
    await openRecordMenu(container)
    await fire(menuItem('Mark as Closed Lost')!)
    await fire(btnByText(container, 'Next')!)          // reason → follow-up step
    await fire(btnByText(container, 'Close as lost')!)  // commit
    expect(patchCalls.length).toBe(1)
    expect(patchCalls[0].body.stage).toBe(CLOSED_LOST)
    expect(patchCalls[0].body.closed_reason).toBe('lost_no_response')
    expect(onChanged).toHaveBeenCalledWith(LOCAL.id, { stage: CLOSED_LOST })
  })

  it('Won gate (panel menu): owing invoices HIDE Mark as Closed Won entirely — Final Processing but not settled', async () => {
    // The Won gate now lives at the MENU: at the final stage with an open
    // balance, the item is absent (not a disabled wizard step). The wizard's
    // own owing gate still guards the board drag-close path (see §C below).
    const owing = { ...emptyChildren(), jobs: [{ id: 'j1', completed_at: daysAgo(1) }], invoices: [{ id: 'i1', status: 'sent', total: 900, balance_owing: 900 }] }
    const { container } = await mountPanel(eng({ id: 'e-owing', stage: 'Final Processing', total_invoiced: 900 }), owing)
    await openRecordMenu(container)
    expect(menuItem('Mark as Closed Won')).toBeFalsy()
    // Lost is still available on an open engagement.
    expect(menuItem('Mark as Closed Lost')).toBeTruthy()
    expect(patchCalls.length).toBe(0)
  })

  it('Won gate (panel menu): Final Processing + fully PAID shows Mark as Closed Won', async () => {
    const paid = { ...emptyChildren(), jobs: [{ id: 'j1', completed_at: daysAgo(1) }], invoices: [{ id: 'i1', status: 'paid', total: 900, balance_owing: 0 }] }
    const { container } = await mountPanel(eng({ id: 'e-paid', stage: 'Final Processing', total_invoiced: 900 }), paid)
    await openRecordMenu(container)
    expect(menuItem('Mark as Closed Won')).toBeTruthy()
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

// ── C) board: pipeline columns inert; drag-to-close pending flow ─
describe('EngagementBoard — pipeline columns are not drop targets; drag-to-close is pending + shared popup', () => {
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

  it('LINKED pipeline drop is inert — no PATCH, no move (columns are not drop targets, 7/10)', async () => {
    const { container, setToast } = mountBoard()
    await dropOnCol(container, 'Lin Linked', 'Job in Progress')
    expect(patchCalls.length).toBe(0)
    expect(setToast).not.toHaveBeenCalled()
    // Card stays in its column.
    expect(container.querySelector('[data-board-col="Estimate"]')!.textContent).toContain('Lin Linked')
    expect(container.querySelector('[data-board-col="Job in Progress"]')!.textContent).not.toContain('Lin Linked')
  })

  it('LOCAL pipeline drop is inert too — the local-card pipeline drag was removed 7/10', async () => {
    const { container } = mountBoard()
    await dropOnCol(container, 'Manny Manual', 'Estimate')
    expect(patchCalls.length).toBe(0)
    expect(container.querySelector('[data-board-col="Request"]')!.textContent).toContain('Manny Manual')
    expect(container.querySelector('[data-board-col="Estimate"]')!.textContent).not.toContain('Manny Manual')
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
describe('shared close flow — single write path across confirm + wizards', () => {
  it('the panel mounts the ··· menu + wizards, the board mounts the drag-confirm; NONE fork the write body', () => {
    const panel = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')
    const board = readFileSync('components/hive/EngagementBoard.jsx', 'utf8')
    // Panel close-out lives in the ··· menu → the Won/Lost wizards.
    expect(panel).toContain("from './shared/RecordMenu'")
    expect(panel).toContain("from './shared/CloseLostWizard'")
    expect(panel).toContain("from './shared/CloseWonWizard'")
    // Board keeps the drag-to-close confirm.
    expect(board).toContain("from './shared/CloseEngagementConfirm'")
    // The terminal close body (closed_reason) is built ONLY in the shared
    // write helper — the host card files never fork it.
    expect(panel).not.toContain('closed_reason')
    expect(board).not.toContain('closed_reason')
    // THE single write path: commitEngagementClose in closeEngagement.js.
    const helper = readFileSync('components/hive/shared/closeEngagement.js', 'utf8')
    expect(helper).toContain('closed_reason')
    expect(helper).toMatch(/method: 'PATCH'/)
    // Every human close UI routes through the one helper.
    for (const f of [
      'components/hive/shared/CloseEngagementConfirm.jsx',
      'components/hive/shared/CloseLostWizard.jsx',
      'components/hive/shared/CloseWonWizard.jsx',
    ]) {
      expect(readFileSync(f, 'utf8')).toContain('commitEngagementClose')
    }
  })

  it('the automated stage writers never import a human close UI or the client write helper', () => {
    for (const f of ['lib/engagements.ts', 'lib/jobber-webhook-handlers.ts', 'app/api/import/jobber-clients/route.ts', 'app/api/engagements/[id]/route.ts']) {
      const src = readFileSync(f, 'utf8')
      expect(src).not.toContain('CloseEngagementConfirm')
      expect(src).not.toContain('CloseLostWizard')
      expect(src).not.toContain('CloseWonWizard')
      expect(src).not.toContain('commitEngagementClose')
    }
  })
})
