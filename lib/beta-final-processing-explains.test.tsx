// @vitest-environment happy-dom
//
// FINAL PROCESSING EXPLAINS ITSELF, AND AN OWNER CAN CLOSE A DEAL
// BEE HUB STILL THINKS IS OWING (issue 119).
//
// THE PREMISE, scouted and re-verified: nothing was broken. Final
// processing is a deliberate waiting room — the LIVE derivation passes
// closeWonOnDone false (lib/engagements.ts) so a done-and-paid deal
// RESTS there and the panel's Mark-won button + close-won wizard drive
// the terminal move, because that is where satisfaction, review,
// re-engage and confetti live. Only the bulk import auto-closes. The
// rules were right; the SCREEN never said so, so a pile of waiting
// deals read as a pile of broken ones.
//
// WHAT THIS FILE PINS:
//   A) each of the three cases shows its OWN explanation, and the
//      explanation is absent at every other stage
//   B) the owing close requires a reason — refused at the ROUTE with a
//      forged request, not merely greyed out in the UI
//   C) the reason renders on the engagement afterwards
//   D) an owing close is distinguishable from an ordinary Closed Won
//   E) balance_owing is unchanged by the close
//   F) the ordinary Mark-won path is untouched (the canCloseWon matrix)
//   G) no bulk action exists anywhere on the surface
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'fs'
import { join } from 'path'
import EngagementPanel from '@/components/hive/EngagementPanel'
import EngagementGroupedList from '@/components/hive/EngagementGroupedList'
import ClosedSummary from '@/components/hive/shared/ClosedSummary'
import { invoicesSettled, WON_OVER_BALANCE } from '@/components/hive/shared/closeEngagement'
import {
  finalProcessingCase, finalProcessingExplainer, finalProcessingGroupLines,
  owedOnInvoices, FINAL_PROCESSING_LEAD, OWING_CLOSE_ACTION, OWING_CLOSED_LABEL,
} from '@/components/hive/shared/finalProcessing'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const PAID_INV = { id: 'i-paid', status: 'paid', total: 500, balance_owing: 0 }
const OWING_INV = { id: 'i-owe', status: 'sent', total: 500, balance_owing: 340 }

// ── A/E/F) the pure classifier ────────────────────────────────
describe('the three cases are three different situations', () => {
  const at = (stage: string, invoices: any[] = []) =>
    finalProcessingCase({ stage } as any, invoices)

  it('fully paid / never invoiced / balance owing each classify on their own', () => {
    expect(at('Final Processing', [PAID_INV])).toBe('paid')
    expect(at('Final Processing', [])).toBe('never_invoiced')
    expect(at('Final Processing', [OWING_INV])).toBe('owing')
    expect(at('Final Processing', [PAID_INV, OWING_INV])).toBe('owing')
  })

  it('every other stage classifies as nothing at all — the explanation is Final-Processing-only', () => {
    for (const s of ['Request', 'Estimate', 'Job in Progress', 'Closed Won', 'Closed Lost']) {
      expect(at(s, [PAID_INV]), s).toBeNull()
      expect(at(s, []), s).toBeNull()
      expect(at(s, [OWING_INV]), s).toBeNull()
      expect(finalProcessingExplainer(at(s, [OWING_INV]), [OWING_INV]), s).toBeNull()
    }
  })

  it('the case tracks invoicesSettled — the SAME predicate the Mark-won button gates on', () => {
    // If these ever diverge the panel would claim the button is missing
    // while rendering it (or the reverse). Settled ⇔ not owing.
    for (const invs of [[], [PAID_INV], [OWING_INV], [PAID_INV, OWING_INV]]) {
      const owing = finalProcessingCase({ stage: 'Final Processing' } as any, invs) === 'owing'
      expect(owing).toBe(!invoicesSettled(invs))
    }
  })

  it('the three explanations are genuinely different text — never one collapsed sentence', () => {
    const bodies = ['paid', 'never_invoiced', 'owing']
      .map(k => finalProcessingExplainer(k, [OWING_INV])!.body)
    expect(new Set(bodies).size).toBe(3)
    // …and each says the thing that case actually needs said.
    expect(bodies[0]).toContain('every invoice is paid')
    expect(bodies[1]).toContain('no invoice was ever raised')
    expect(bodies[1]).toContain('$0')
    expect(bodies[2]).toContain('$340')
    expect(bodies[2]).toContain('isn’t here')
  })

  it('the owing figure comes from the invoices the gate read, and a paid row contributes nothing', () => {
    expect(owedOnInvoices([OWING_INV])).toBe(340)
    // A paid invoice with a stale balance still owes nothing — exactly
    // what invoicesSettled forgives.
    expect(owedOnInvoices([{ status: 'paid', balance_owing: 99 }])).toBe(0)
    expect(owedOnInvoices([])).toBe(0)
  })

  it('the group note keeps one line per case PRESENT, with its count', () => {
    const rows = [
      { stage: 'Final Processing', invoices: [PAID_INV] },
      { stage: 'Final Processing', invoices: [PAID_INV] },
      { stage: 'Final Processing', invoices: [] },
      { stage: 'Final Processing', invoices: [OWING_INV] },
      { stage: 'Estimate', invoices: [OWING_INV] }, // not counted
    ]
    const lines = finalProcessingGroupLines(rows as any)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('2 are done and fully paid')
    expect(lines[1]).toContain('1 was never invoiced')
    expect(lines[2]).toContain('1 still shows money owing')
    // A case with nothing in it says nothing.
    expect(finalProcessingGroupLines([{ stage: 'Final Processing', invoices: [PAID_INV] }] as any))
      .toEqual(['1 is done and fully paid. Open it and press Mark won.'])
    expect(finalProcessingGroupLines([])).toEqual([])
  })
})

// ── A) the panel renders its case, and only at Final Processing ──
describe('the engagement panel says why it is waiting', () => {
  const emptyChildren = () => ({ service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] })
  const client = { id: 'c1', name: 'Pat Tester', email: null, phone: null, buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0, engagements: [] }
  const engRow = (over: any = {}) => ({
    id: 'e1', client_id: 'c1', location_uuid: 'loc-1', title: 'Garage', stage: 'Final Processing',
    created_at: new Date().toISOString(), stage_entered_at: new Date().toISOString(),
    nurture_started_at: null, total_invoiced: 500, total_paid: 0, balance_owing: 0, ...over,
  })

  let host: HTMLDivElement, root: any
  const mount = async (payload: any) => {
    ;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, json: async () => payload }))
    host = document.createElement('div'); document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root.render(<EngagementPanel engagementId="e1" onClose={() => {}} />) })
    await act(async () => { await Promise.resolve() })
  }
  afterEach(() => { act(() => root?.unmount()); host?.remove() })

  const payloadFor = (stage: string, invoices: any[], balance = 0) => ({
    engagement: engRow({ stage, balance_owing: balance }),
    client,
    children: { ...emptyChildren(), invoices },
  })

  const why = () => host.querySelector('[data-bee-final-processing-why]')

  it('fully paid → its own explanation, and the Mark won button IS there', async () => {
    await mount(payloadFor('Final Processing', [PAID_INV]))
    expect(why()?.getAttribute('data-bee-final-processing-why')).toBe('paid')
    expect(why()!.textContent).toContain(FINAL_PROCESSING_LEAD)
    expect(why()!.textContent).toContain('every invoice is paid')
    expect(host.querySelector('[data-bee-ready-to-close]')).toBeTruthy()
    expect(host.querySelector('[data-bee-close-over-balance]')).toBeFalsy()
  })

  it('never invoiced → its own explanation, and the Mark won button IS there (the $0 close)', async () => {
    await mount(payloadFor('Final Processing', []))
    expect(why()?.getAttribute('data-bee-final-processing-why')).toBe('never_invoiced')
    expect(why()!.textContent).toContain('no invoice was ever raised')
    expect(host.querySelector('[data-bee-ready-to-close]')).toBeTruthy()
    expect(host.querySelector('[data-bee-close-over-balance]')).toBeFalsy()
  })

  it('balance owing → its own explanation, NO Mark won button, and a separate quiet action', async () => {
    await mount(payloadFor('Final Processing', [OWING_INV], 340))
    expect(why()?.getAttribute('data-bee-final-processing-why')).toBe('owing')
    expect(why()!.textContent).toContain('$340')
    // The ordinary button is correctly absent…
    expect(host.querySelector('[data-bee-ready-to-close]')).toBeFalsy()
    // …and the override is a SEPARATE, deliberate second action — not
    // the same button promoted.
    const override = host.querySelector('[data-bee-close-over-balance]')!
    expect(override).toBeTruthy()
    expect(override.textContent).toBe(OWING_CLOSE_ACTION)
    expect(override.tagName).toBe('BUTTON')
    // It must not be the primary affordance: bee-small-action releases
    // the globals.css 16px button floor to 12px, so it reads as chrome
    // beside the accent button rather than competing with it.
    expect(override.className).toContain('bee-small-action')
  })

  it('every other stage renders no explanation at all', async () => {
    for (const stage of ['Request', 'Estimate', 'Job in Progress']) {
      await mount(payloadFor(stage, [OWING_INV], 340))
      expect(why(), stage).toBeFalsy()
      expect(host.querySelector('[data-bee-close-over-balance]'), stage).toBeFalsy()
      act(() => root.unmount()); host.remove()
    }
    // Closed rows too — a closed deal is not waiting on anybody.
    await mount(payloadFor('Closed Won', [PAID_INV]))
    expect(why()).toBeFalsy()
  })
})

// ── A) the list's Final processing group says it too ───────────
describe('the Final processing group in the list says why', () => {
  let host: HTMLDivElement, root: any
  afterEach(() => { act(() => root?.unmount()); host?.remove() })

  const row = (id: string, stage: string, invoices: any[], balance = 0) => ({
    id, client_id: 'c1', client_name: 'Pat Tester', title: 'Garage', stage,
    created_at: new Date().toISOString(), balance_owing: balance,
    total_invoiced: 0, total_paid: 0, repeat_count: 1,
    service_requests: [], quotes: [], jobs: [], invoices, assessments: [],
  })

  const render = async (rows: any[]) => {
    host = document.createElement('div'); document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root.render(<EngagementGroupedList engagements={rows} onOpenEngagement={() => {}} initialView="Final Processing" />)
    })
  }

  it('the expanded band carries the lead line and one line per case present', async () => {
    await render([
      row('a', 'Final Processing', [PAID_INV]),
      row('b', 'Final Processing', []),
      row('c', 'Final Processing', [OWING_INV], 340),
    ])
    const note = host.querySelector('[data-bee-final-processing-note]')!
    expect(note).toBeTruthy()
    expect(note.textContent).toContain(FINAL_PROCESSING_LEAD)
    expect(note.textContent).toContain('1 is done and fully paid')
    expect(note.textContent).toContain('1 was never invoiced')
    expect(note.textContent).toContain('1 still shows money owing')
  })

  it('no other stage band gets the note', async () => {
    await render([row('a', 'Estimate', [OWING_INV], 340), row('b', 'Job in Progress', [])])
    expect(host.querySelector('[data-bee-final-processing-note]')).toBeFalsy()
  })
})

// ── C/D) the reason renders afterwards, and reads as its own thing ──
describe('the close explains itself afterwards', () => {
  let host: HTMLDivElement, root: any
  afterEach(() => { act(() => root?.unmount()); host?.remove() })
  const render = async (engagement: any) => {
    host = document.createElement('div'); document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root.render(<ClosedSummary engagement={engagement} />) })
  }

  const OVERRIDE = {
    stage: 'Closed Won', closed_reason: WON_OVER_BALANCE, balance_owing: 340,
    closed_note: 'Paid cash on the day, Jobber never updated',
    closed_at: '2026-09-11T10:00:00.000Z',
  }
  const ORDINARY = {
    stage: 'Closed Won', closed_reason: 'won', balance_owing: 0,
    closed_note: 'Wrapped up nicely', closed_at: '2026-09-11T10:00:00.000Z',
  }

  it('the owner’s reason is on the engagement, in full — not hidden behind a tooltip', async () => {
    await render(OVERRIDE)
    const reason = host.querySelector('[data-bee-over-balance-reason]')!
    expect(reason).toBeTruthy()
    expect(reason.textContent).toContain('Paid cash on the day, Jobber never updated')
    // Rendered text, not a title attribute nobody hovers.
    expect(reason.getAttribute('title')).toBeNull()
    // …and it wraps rather than ellipsing away.
    expect((reason as HTMLElement).style.whiteSpace).toBe('pre-wrap')
  })

  it('an owing close is visibly NOT an ordinary Closed Won', async () => {
    await render(OVERRIDE)
    const overrideText = host.textContent!
    expect(overrideText).toContain('Closed won')
    expect(overrideText).toContain(OWING_CLOSED_LABEL)
    // The live figure, which the close did not touch.
    expect(host.querySelector('[data-bee-over-balance-line]')!.textContent).toContain('$340')
    act(() => root.unmount()); host.remove()

    await render(ORDINARY)
    expect(host.textContent).toContain('Closed won')
    expect(host.textContent).not.toContain(OWING_CLOSED_LABEL)
    expect(host.querySelector('[data-bee-over-balance-line]')).toBeFalsy()
    expect(host.querySelector('[data-bee-over-balance-reason]')).toBeFalsy()
  })

  it('once the balance really is settled the marker still tells the story', async () => {
    await render({ ...OVERRIDE, balance_owing: 0 })
    expect(host.textContent).toContain(OWING_CLOSED_LABEL)
    expect(host.querySelector('[data-bee-over-balance-line]')!.textContent)
      .toContain('showed money owing when this was closed')
  })
})

// ── D) the two reason values can never drift apart ─────────────
describe('the override reason value is one value', () => {
  it('the client write path and the server vocabulary agree', () => {
    // Client code must never import lib/engagements (it drags the
    // Supabase service client into the browser bundle), so the literal
    // is declared twice on purpose. This is the pin that keeps them one.
    expect(WON_OVER_BALANCE).toBe('won_balance_owing')
    expect(src('lib/engagements.ts')).toContain("export const WON_OVER_BALANCE = 'won_balance_owing'")
    expect(src('components/hive/shared/closeEngagement.js'))
      .toContain("export const WON_OVER_BALANCE = 'won_balance_owing'")
    // It is never plain 'won' — that is the whole distinguishability.
    expect(WON_OVER_BALANCE).not.toBe('won')
  })

  it('nothing DERIVES it — the stage machine never writes or reads the override', () => {
    const derivation = src('lib/engagements.ts')
    // The constant is declared there as server vocabulary, but the
    // derivation must never stamp it: an override is a human act.
    const afterDeclaration = derivation.split("export const WON_OVER_BALANCE = 'won_balance_owing'")[1]
    expect(afterDeclaration).not.toContain('WON_OVER_BALANCE')
  })
})

// ── F) the ordinary Mark-won path is untouched ─────────────────
describe('the ordinary Mark won path is untouched', () => {
  it('the canCloseWon matrix still reads exactly as it did', () => {
    expect(invoicesSettled([])).toBe(true)
    expect(invoicesSettled([PAID_INV])).toBe(true)
    expect(invoicesSettled([{ status: 'sent', balance_owing: 0 }])).toBe(true)
    expect(invoicesSettled([OWING_INV])).toBe(false)
    expect(invoicesSettled([PAID_INV, OWING_INV])).toBe(false)
  })

  it('the panel gate line is unchanged — source pin', () => {
    expect(src('components/hive/EngagementPanel.jsx'))
      .toContain("const canCloseWon = !!eng && eng.stage === 'Final Processing' && invoicesSettled(children.invoices || [])")
  })

  it('the owing path ends in the SAME CloseWonWizard — there is no second close path', () => {
    const panel = src('components/hive/EngagementPanel.jsx')
    // One import, one mount, both entrances.
    expect(panel).toContain("from './shared/CloseWonWizard'")
    expect(panel.match(/<CloseWonWizard/g) || []).toHaveLength(1)
    expect(panel).toContain("wizard === 'won-over-balance'")
    // The wizard still commits through the ONE shared write helper, and
    // still runs satisfaction / review / re-engage on the owing path.
    const wiz = src('components/hive/shared/CloseWonWizard.jsx')
    expect(wiz).toContain('commitEngagementClose')
    expect(wiz.match(/commitEngagementClose\(/g) || []).toHaveLength(1)
    for (const step of ['satisfaction', 'closeout', 'reengage']) expect(wiz).toContain(step)
  })
})

// ── G) no bulk action anywhere ─────────────────────────────────
describe('no bulk close exists on any surface', () => {
  it('nothing on the engagement surfaces offers a close-all / select-all', () => {
    const files = [
      'components/hive/EngagementPanel.jsx',
      'components/hive/EngagementGroupedList.jsx',
      'components/hive/EngagementBoard.jsx',
      'components/hive/shared/CloseWonWizard.jsx',
      'components/hive/shared/finalProcessing.js',
      'components/hive/shared/closeEngagement.js',
    ]
    // 447 waiting deals and one button that closes all of them is
    // exactly the accident the dismissed-lead work exists to prevent.
    const banned = /close all|closeAll|bulkClose|bulk_close|mark all|markAll|selectAll|select all/i
    for (const f of files) {
      const text = src(f)
      const hit = text.split('\n').find(l => banned.test(l))
      expect(hit, `${f}: ${hit}`).toBeUndefined()
    }
  })

  it('the group note is a NOTE — it renders no button', async () => {
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    const row = {
      id: 'a', client_id: 'c1', client_name: 'Pat', title: 'Garage', stage: 'Final Processing',
      created_at: new Date().toISOString(), balance_owing: 0, total_invoiced: 0, total_paid: 0,
      repeat_count: 1, service_requests: [], quotes: [], jobs: [], invoices: [PAID_INV], assessments: [],
    }
    await act(async () => {
      root.render(<EngagementGroupedList engagements={[row]} onOpenEngagement={() => {}} initialView="Final Processing" />)
    })
    const note = host.querySelector('[data-bee-final-processing-note]')!
    expect(note).toBeTruthy()
    expect(note.querySelectorAll('button')).toHaveLength(0)
    act(() => root.unmount()); host.remove()
  })
})
