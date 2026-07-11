// @vitest-environment happy-dom
//
// EngagementPanel — the VISIBLE "Ready to close — Mark won" button
// (close-won-button-gating build). The affirmative front door that sits
// alongside the ··· menu's "Mark as Closed Won": same gate, same wizard.
//
// THE GATE (canCloseWon, refined 7/11): stage === 'Final Processing' AND
// invoicesFullyPaid(invoices) — ≥1 invoice AND every invoice paid. This is
// the SAME predicate the import's stage derivation keys on to move a done
// job to Closed Won (lib/engagements.ts → engagementStatus.invoicesFullyPaid),
// so the button and import can never drift. The empty-invoice case is the
// FIX: zero invoices = never invoiced = not wrapping up = NO button (the
// old invoicesSettled([])===true behavior was wrong for this).
//
//   Final Processing + ≥1 invoice + all paid → button SHOWS (opens wizard)
//   Final Processing + zero invoices          → NO button (the fix)
//   Final Processing + an unpaid invoice      → NO button
//   any non-Final-Processing stage            → NO button
//   readOnly (any state)                      → NO button
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import EngagementPanel from '@/components/hive/EngagementPanel'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const eng = (over: any = {}) => ({
  id: 'e-1', client_id: 'c1', client_name: 'Pat Tester', location_uuid: 'loc-uuid-1',
  title: 'Garage organization', stage: 'Final Processing', founded_by: 'quote',
  created_at: daysAgo(3), stage_entered_at: daysAgo(3), nurture_started_at: null,
  total_invoiced: 900, total_paid: 900, balance_owing: 0, repeat_count: 1,
  ...over,
})
const emptyChildren = () => ({ service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] })
const paidInvoices = () => [{ id: 'i1', status: 'paid', total: 900, balance_owing: 0 }]
const owingInvoices = () => [{ id: 'i1', status: 'sent', total: 900, balance_owing: 900 }]
// Two invoices, one still owing — the "every invoice" clause must fail even
// though one is paid.
const mixedInvoices = () => [
  { id: 'i1', status: 'paid', total: 500, balance_owing: 0 },
  { id: 'i2', status: 'sent', total: 400, balance_owing: 400 },
]
const client = (over: any = {}) => ({
  id: 'c1', name: 'Pat Tester', email: null, phone: null, source: null,
  referred_by_kind: null, referred_by_id: null, referred_by_name: null, buzz: [],
  lifetime_paid: 0, prior_engagements: 0, other_open: 0,
  jobber_connected: false, reviews_link: null, location_name: 'Palm Beach',
  ...over,
})

const fetchMock = vi.fn(async (url: any, init?: any) => {
  const method = init?.method
  if (method === 'PATCH') return { ok: true, json: async () => ({ id: 'e-1', stage: JSON.parse(init.body).stage }) } as any
  return { ok: true, json: async () => panelPayload } as any
})
let panelPayload: any = null

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

const readyButton = () =>
  document.querySelector('[data-bee-ready-to-close]') as HTMLButtonElement | null
// The EXISTING CloseWonWizard's shell title — proof it (not a rebuilt one)
// opened. 'Close as won' is only on the wizard's final step; the title is
// present from the first render.
const wizardOpen = () =>
  [...document.querySelectorAll('*')].some(el => (el.textContent || '').trim() === 'Close out — won')

const mountPanel = async (engagement: any, children: any, extra: any = {}) => {
  panelPayload = { engagement, children, client: client() }
  const container = mount(
    <EngagementPanel engagementId={engagement.id} seed={engagement}
      onClose={() => {}} setToast={vi.fn()} {...extra} />
  )
  await settle()
  return { container }
}

describe('Ready-to-close button — gate matrix (Final Processing + ≥1 invoice all paid)', () => {
  it('SHOWS at Final Processing when every invoice is paid, and clicking opens the EXISTING CloseWonWizard', async () => {
    await mountPanel(eng(), { ...emptyChildren(), invoices: paidInvoices() })
    const btn = readyButton()
    expect(btn).toBeTruthy()
    expect((btn!.textContent || '').toLowerCase()).toContain('ready to close')
    // Opens the existing wizard — not a rebuilt one.
    await fire(btn!)
    await settle()
    expect(wizardOpen(), 'CloseWonWizard opened on click').toBe(true)
  })

  it('does NOT show at Final Processing with ZERO invoices (the fix — un-invoiced is not wrapping up)', async () => {
    await mountPanel(eng(), { ...emptyChildren(), invoices: [] })
    expect(readyButton()).toBeFalsy()
  })

  it('does NOT show at Final Processing when an invoice is still owing', async () => {
    await mountPanel(eng({ balance_owing: 900 }), { ...emptyChildren(), invoices: owingInvoices() })
    expect(readyButton()).toBeFalsy()
  })

  it('does NOT show when only SOME invoices are paid (every-invoice clause)', async () => {
    await mountPanel(eng({ balance_owing: 400 }), { ...emptyChildren(), invoices: mixedInvoices() })
    expect(readyButton()).toBeFalsy()
  })

  it('does NOT show at any non-Final-Processing stage, even fully paid', async () => {
    for (const stage of ['Request', 'Estimate', 'Job in Progress', 'Closed Won', 'Closed Lost']) {
      await mountPanel(eng({ stage }), { ...emptyChildren(), invoices: paidInvoices() })
      expect(readyButton(), `no ready button at ${stage}`).toBeFalsy()
      document.body.innerHTML = ''
    }
  })

  it('does NOT show for readOnly users even when the deal is ready (respects betaReadOnly)', async () => {
    await mountPanel(eng(), { ...emptyChildren(), invoices: paidInvoices() }, { readOnly: true })
    expect(readyButton()).toBeFalsy()
  })
})
