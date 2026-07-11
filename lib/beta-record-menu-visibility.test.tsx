// @vitest-environment happy-dom
//
// EngagementPanel ··· menu — REFINEMENT pins (menu-refinement build):
//
//   A) CONDITIONAL VISIBILITY (the matrix):
//      · Mark as Closed Won  → ONLY at Final Processing (the last working
//        stage) AND when invoicesFullyPaid — ≥1 invoice AND every invoice
//        paid, the SAME predicate the import's stage derivation uses to
//        move a done job to Closed Won (engagementStatus.js). ZERO invoices
//        does NOT qualify (never invoiced = not wrapping up). Absent — not
//        disabled — otherwise.
//      · Mark as Closed Lost → any OPEN engagement; NEVER on a closed one
//        (so it can't leak onto a Closed Won).
//      · Reopen → Closed Lost ONLY (never Won — settled money out of scope).
//
//   B) INSTANT REFLECTION w/ ROLLBACK (the reopen bug): a reopen updates
//      the panel immediately (no manual refresh) and hands the freshly-open
//      row UP via onReopened; a SIMULATED server failure rolls the UI back
//      to Closed Lost and surfaces a truthful error toast (never a move that
//      didn't persist), and onReopened does NOT fire.
//
//   (Animation — confetti / sad-face / chip-move — can't be unit-tested;
//    left for Kevin's visual check. See components/hive/shared/motion.jsx.)
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
  created_at: daysAgo(3), stage_entered_at: daysAgo(3), nurture_started_at: null,
  total_invoiced: 0, total_paid: 0, balance_owing: 0, repeat_count: 1,
  ...over,
})
const emptyChildren = () => ({ service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] })
const paidInvoices = () => [{ id: 'i1', status: 'paid', total: 900, balance_owing: 0 }]
const owingInvoices = () => [{ id: 'i1', status: 'sent', total: 900, balance_owing: 900 }]
const client = (over: any = {}) => ({
  id: 'c1', name: 'Pat Tester', email: null, phone: null, source: null,
  referred_by_kind: null, referred_by_id: null, referred_by_name: null, buzz: [],
  lifetime_paid: 0, prior_engagements: 0, other_open: 0,
  jobber_connected: false, reviews_link: null, location_name: 'Palm Beach',
  ...over,
})

// ── fetch mock: GET returns the queued payload; reopen POST is scriptable
//    (ok success by default; a queued failure exercises the rollback). ──
let panelPayload: any = null
let reopenResult: { ok: boolean; body: any } = { ok: true, body: { reopened: true, stage: 'Estimate', prev_stage: 'Closed Lost' } }
let reopenPosts: string[] = []
const fetchMock = vi.fn(async (url: any, init?: any) => {
  const u = String(url)
  const method = init?.method
  if (method === 'POST' && /\/api\/engagements\/[^/]+\/reopen$/.test(u)) {
    reopenPosts.push(u)
    return { ok: reopenResult.ok, status: reopenResult.ok ? 200 : 409, json: async () => reopenResult.body } as any
  }
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
  reopenResult = { ok: true, body: { reopened: true, stage: 'Estimate', prev_stage: 'Closed Lost' } }
  reopenPosts = []
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

const mountPanel = async (engagement: any, children: any, spies: any = {}) => {
  panelPayload = { engagement, children, client: client() }
  const onChanged = spies.onChanged || vi.fn()
  const onReopened = spies.onReopened || vi.fn()
  const setToast = spies.setToast || vi.fn()
  const container = mount(
    <EngagementPanel engagementId={engagement.id} seed={engagement}
      onClose={() => {}} onChanged={onChanged} onReopened={onReopened} setToast={setToast} />
  )
  await settle()
  return { container, onChanged, onReopened, setToast }
}

// ── A) the visibility matrix ──────────────────────────────────
describe('··· menu — conditional visibility (Won gated to final+paid; Lost open-only; Reopen closed-lost-only)', () => {
  it('Mark as Closed Won is ABSENT at every non-final stage, even when paid', async () => {
    for (const stage of ['Request', 'Estimate', 'Job in Progress']) {
      const { container } = await mountPanel(eng({ stage }), { ...emptyChildren(), invoices: paidInvoices() })
      await openMenu(container)
      expect(menuItem('Mark as Closed Won'), `Won hidden at ${stage}`).toBeFalsy()
      expect(menuItem('Mark as Closed Lost'), `Lost shown at ${stage}`).toBeTruthy()
      document.body.innerHTML = ''
    }
  })

  it('Mark as Closed Won is ABSENT at Final Processing while an invoice is still owing', async () => {
    const { container } = await mountPanel(eng({ stage: 'Final Processing', total_invoiced: 900 }), { ...emptyChildren(), invoices: owingInvoices() })
    await openMenu(container)
    expect(menuItem('Mark as Closed Won')).toBeFalsy()
    expect(menuItem('Mark as Closed Lost')).toBeTruthy()
  })

  it('Mark as Closed Won is ABSENT at Final Processing with ZERO invoices (the empty-list fix — un-invoiced is not wrapping up)', async () => {
    const { container } = await mountPanel(eng({ stage: 'Final Processing' }), { ...emptyChildren(), invoices: [] })
    await openMenu(container)
    expect(menuItem('Mark as Closed Won')).toBeFalsy()
    expect(menuItem('Mark as Closed Lost')).toBeTruthy()
  })

  it('Mark as Closed Won APPEARS at Final Processing when every invoice is settled', async () => {
    const { container } = await mountPanel(eng({ stage: 'Final Processing', total_invoiced: 900 }), { ...emptyChildren(), invoices: paidInvoices() })
    await openMenu(container)
    expect(menuItem('Mark as Closed Won')).toBeTruthy()
    expect(menuItem('Mark as Closed Lost')).toBeTruthy()
  })

  it('Closed WON: NO Lost, NO Reopen — the menu is empty so no ··· trigger renders (Lost cannot leak onto Won)', async () => {
    const { container } = await mountPanel(eng({ stage: 'Closed Won', closed_reason: 'won' }), emptyChildren())
    expect(recordTrigger(container)).toBeFalsy()
    expect(menuItem('Mark as Closed Lost')).toBeFalsy()
    expect(menuItem('Reopen')).toBeFalsy()
  })

  it('Closed LOST: Reopen only — no Won, no Lost', async () => {
    const { container } = await mountPanel(eng({ stage: 'Closed Lost', closed_reason: 'lost_no_response' }), emptyChildren())
    await openMenu(container)
    expect(menuItem('Reopen')).toBeTruthy()
    expect(menuItem('Mark as Closed Won')).toBeFalsy()
    expect(menuItem('Mark as Closed Lost')).toBeFalsy()
  })

  it('Reopen never shows on an OPEN engagement', async () => {
    const { container } = await mountPanel(eng({ stage: 'Estimate' }), emptyChildren())
    await openMenu(container)
    expect(menuItem('Reopen')).toBeFalsy()
  })
})

// ── B) instant reflection + rollback ──────────────────────────
describe('reopen — instant reflection with optimistic rollback (no manual refresh)', () => {
  const CLOSED_LOST = eng({ stage: 'Closed Lost', closed_reason: 'lost_no_response' })

  it('SUCCESS: the move reflects immediately — panel re-renders to the derived open stage and hands the row UP (onReopened + onChanged), no extra GET', async () => {
    const { container, onChanged, onReopened, setToast } = await mountPanel(CLOSED_LOST, emptyChildren())
    await openMenu(container)
    await fire(menuItem('Reopen')!)
    await settle()

    expect(reopenPosts).toHaveLength(1)
    // Reflected on the SAME render pass — no page refresh / refetch.
    expect(onChanged).toHaveBeenCalledWith('e-1', { stage: 'Estimate' })
    const passedUp = onReopened.mock.calls[0][0]
    expect(passedUp.id).toBe('e-1')
    expect(passedUp.stage).toBe('Estimate')          // server-derived OPEN stage
    // The board keys off `stage` (isTerminal), so the now-open stage is the
    // load-bearing field; stale terminal columns are inert until refetch.
    expect(setToast).toHaveBeenCalledWith({ kind: 'success', msg: 'Reopened · Estimate' })

    // The panel itself moved: the menu now offers open-engagement actions
    // (Lost), and Reopen is gone — without any manual reload.
    await openMenu(container)
    expect(menuItem('Reopen')).toBeFalsy()
    expect(menuItem('Mark as Closed Lost')).toBeTruthy()
  })

  it('FAILURE: rolls back to Closed Lost with a truthful toast; the row is NOT handed up (never show a move that did not persist)', async () => {
    reopenResult = { ok: false, body: { error: 'reopen_requires_closed_lost' } }
    const { container, onChanged, onReopened, setToast } = await mountPanel(CLOSED_LOST, emptyChildren())
    await openMenu(container)
    await fire(menuItem('Reopen')!)
    await settle()

    expect(reopenPosts).toHaveLength(1)
    // No optimistic move survives a failed write.
    expect(onReopened).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    // Truthful failure surfaced.
    const toastArg = setToast.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.kind === 'error')
    expect(toastArg).toBeTruthy()
    expect(toastArg.msg).toContain('Reopen failed')
    // Rolled back: still Closed Lost, so the menu still offers Reopen only.
    await openMenu(container)
    expect(menuItem('Reopen')).toBeTruthy()
    expect(menuItem('Mark as Closed Lost')).toBeFalsy()
  })
})
