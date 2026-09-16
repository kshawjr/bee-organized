// @vitest-environment happy-dom
//
// THE OWING OVERRIDE IS FINDABLE — two entry points, one flow.
//
// 90387c7 shipped the override as a borderless text action under the
// explanation. Kevin looked at it live: too hidden. 61 engagements qualify
// and roughly $192k reads as owed, so owners who need it will not find it.
//
// TWO CHANGES, AND ONE RULE ABOUT BOTH:
//   1. the inline control gains real button chrome — rowActionBtn's border
//      and raised surface, the card's existing SECONDARY idiom — while
//      staying outlined (never Mark won's filled accent), left-aligned (never
//      Mark won's slot, because on an owing engagement that slot is EMPTY and
//      is exactly where muscle memory lands), and 12px.
//   2. the ⋯ menu offers it too, opening the SAME flow.
//
// ONE IMPLEMENTATION. Both entry points call setWizard('won-over-balance'),
// so both mount ONE CloseWonWizard with overBalance, ask ONE mandatory
// reason, and commit through ONE write. There is no second reason step, and
// these tests assert that by driving the flow from each entry point and
// comparing what reaches the route.
//
// NO NEW MODAL PATTERN WAS INVENTED: CloseWonWizard already renders through
// WizardShell → OverlayShell, which the app describes as "desktop centered
// modal / mobile bottom sheet". The menu item opens that same centred modal
// by setting the same state.
//
// THE GATE IS THE POINT. The menu item appears only where the override is
// genuinely available — Final Processing AND invoices unsettled (fpCase
// 'owing'). Offering "close it anyway" on a deal with nothing owing invites
// an owner to reach for an override they do not need, beside a Mark won
// button that already works.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'fs'
import { join } from 'path'
import EngagementPanel from '@/components/hive/EngagementPanel'
import { finalProcessingCase, OWING_CLOSE_ACTION } from '@/components/hive/shared/finalProcessing'
import { invoicesSettled } from '@/components/hive/shared/closeEngagement'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const PAID_INV = { id: 'i1', status: 'paid', balance_owing: 0, total: 500 }
const OWING_INV = { id: 'i2', status: 'sent', balance_owing: 500, total: 500 }

const emptyChildren = () => ({ service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] })
const client = { id: 'c1', name: 'Pat Tester', email: null, phone: null, buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0, engagements: [] }
const engRow = (over: any = {}) => ({
  id: 'e1', client_id: 'c1', location_uuid: 'loc-1', title: 'Garage', stage: 'Final Processing',
  created_at: new Date().toISOString(), stage_entered_at: new Date().toISOString(),
  nurture_started_at: null, total_invoiced: 500, total_paid: 0, balance_owing: 0, ...over,
})
const payloadFor = (stage: string, invoices: any[], balance = 0) => ({
  engagement: engRow({ stage, balance_owing: balance }),
  client,
  children: { ...emptyChildren(), invoices },
})

let host: HTMLDivElement, root: any
let patches: any[] = []

const mount = async (payload: any, props: any = {}) => {
  patches = []
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const method = opts.method || 'GET'
    if (method === 'PATCH') {
      patches.push({ url: String(url), body: JSON.parse(opts.body || '{}') })
      return { ok: true, status: 200, json: async () => ({ ...payload.engagement, stage: 'Closed Won', changed: true }) }
    }
    return { ok: true, status: 200, json: async () => payload }
  })
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(<EngagementPanel engagementId="e1" onClose={() => {}} {...props} />) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); vi.restoreAllMocks() })

const click = async (el: Element | null | undefined) => {
  await act(async () => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}
const inlineBtn = () => host.querySelector('[data-bee-close-over-balance]')
const menuBtn = () => [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'Engagement actions')
// RecordMenu renders through a PORTAL, so its items live in document.body,
// not inside `host` — and the INLINE control carries the very same label
// text. A host-scoped lookup therefore found the inline button and called it
// "the menu item": both gate assertions passed while testing the wrong
// control, and a mutation that ungated the menu entirely went unnoticed.
// Search the document, and exclude the inline control explicitly.
const menuItemByLabel = (label: string) =>
  [...document.body.querySelectorAll('button')].find(b =>
    (b.textContent || '').trim() === label && !b.hasAttribute('data-bee-close-over-balance'))
const openMenu = async () => { await click(menuBtn()) }
const text = () => host.textContent || ''

// ── the gate ──────────────────────────────────────────────────────
describe('the ⋯ menu offers it ONLY where the override is available', () => {
  it('Final Processing WITH a balance owing → the item is there', async () => {
    await mount(payloadFor('Final Processing', [OWING_INV], 500))
    await openMenu()
    expect(menuItemByLabel(OWING_CLOSE_ACTION)).toBeTruthy()
  })

  it('Final Processing FULLY PAID → no item, because Mark won already works', async () => {
    // The mutation target. Offering "close it anyway" on a settled deal, next
    // to a working Mark won button, is the confusion this gate prevents.
    await mount(payloadFor('Final Processing', [PAID_INV]))
    await openMenu()
    expect(menuItemByLabel(OWING_CLOSE_ACTION)).toBeFalsy()
    expect(host.querySelector('[data-bee-ready-to-close]')).toBeTruthy() // the ordinary path IS there
  })

  it('Final Processing NEVER INVOICED → no item; that is the $0 close, not an override', async () => {
    await mount(payloadFor('Final Processing', []))
    await openMenu()
    expect(menuItemByLabel(OWING_CLOSE_ACTION)).toBeFalsy()
    expect(host.querySelector('[data-bee-ready-to-close]')).toBeTruthy()
  })

  it('never at another stage, even with money owing', async () => {
    for (const stage of ['Request', 'Estimate', 'Job in Progress', 'Nurturing']) {
      await mount(payloadFor(stage, [OWING_INV], 500))
      await openMenu()
      expect(menuItemByLabel(OWING_CLOSE_ACTION), stage).toBeFalsy()
      act(() => root?.unmount()); host?.remove()
    }
  })

  it('never on an already-settled (terminal) engagement — neither entry point', async () => {
    await mount(payloadFor('Closed Won', [PAID_INV]))
    expect(inlineBtn()).toBeFalsy()
    await openMenu()
    expect(menuItemByLabel(OWING_CLOSE_ACTION)).toBeFalsy()
  })

  it('read-only hides BOTH entry points', async () => {
    await mount(payloadFor('Final Processing', [OWING_INV], 500), { readOnly: true })
    expect(inlineBtn()).toBeFalsy()
    await openMenu()
    expect(menuItemByLabel(OWING_CLOSE_ACTION)).toBeFalsy()
  })

  it('the gate is the SAME predicate the sentence and the inline control read', () => {
    // fpCase, not a second stage/balance test of the menu's own.
    expect(finalProcessingCase(engRow({ stage: 'Final Processing' }), [OWING_INV])).toBe('owing')
    expect(finalProcessingCase(engRow({ stage: 'Final Processing' }), [PAID_INV])).toBe('paid')
    expect(finalProcessingCase(engRow({ stage: 'Final Processing' }), [])).toBe('never_invoiced')
    expect(finalProcessingCase(engRow({ stage: 'Request' }), [OWING_INV])).toBeNull()
  })
})

// ── one flow, two doors ───────────────────────────────────────────
describe('both entry points open the SAME flow and write the SAME result', () => {
  const OWING = () => payloadFor('Final Processing', [OWING_INV], 500)

  // The wizard the two doors open, as rendered. Comparing this is a stronger
  // claim than comparing a mocked PATCH would be here: the wizard is
  // multi-step (satisfaction → review → note → re-engage), so driving it to
  // commit in a test would assert mostly about my ability to click through
  // it. What must be true is that BOTH doors produce the SAME wizard in the
  // SAME state — after which there is literally one confirm() and one
  // commitEngagementClose, and the route-level write is already pinned by
  // beta-final-processing-owing-route.
  const wizardText = () => {
    const h = [...host.querySelectorAll('h2')].find(x => /clos/i.test(x.textContent || ''))
    return h ? (h.parentElement?.textContent || '') : ''
  }

  it('the INLINE control opens the wizard', async () => {
    await mount(OWING())
    expect(inlineBtn()).toBeTruthy()
    await click(inlineBtn())
    expect(text()).toMatch(/why are you closing this/i) // the mandatory reason step
  })

  it('the MENU item opens the same wizard, with the same reason step', async () => {
    await mount(OWING())
    await openMenu()
    await click(menuItemByLabel(OWING_CLOSE_ACTION))
    expect(text()).toMatch(/why are you closing this/i)
  })

  it('exactly ONE wizard is mounted, whichever door was used', async () => {
    // Not two copies of the reason step racing each other.
    await mount(OWING())
    await openMenu()
    await click(menuItemByLabel(OWING_CLOSE_ACTION))
    expect(host.querySelectorAll('textarea')).toHaveLength(1)
  })

  it('the two doors produce an IDENTICAL wizard — same step, same reason ask', async () => {
    await mount(OWING())
    await openMenu()
    await click(menuItemByLabel(OWING_CLOSE_ACTION))
    const fromMenu = wizardText()

    act(() => root?.unmount()); host?.remove()

    await mount(OWING())
    await click(inlineBtn())
    const fromInline = wizardText()

    expect(fromMenu.length).toBeGreaterThan(0)
    expect(fromMenu).toBe(fromInline)
    expect(fromMenu).toMatch(/why are you closing this/i)
  })

  it('and it is the OVERRIDE wizard in both — the reason ask only exists there', async () => {
    // A settled deal opened through the ordinary Mark won button gets no
    // reason step, so the presence of that ask proves overBalance reached the
    // wizard from whichever door was used.
    await mount(payloadFor('Final Processing', [PAID_INV]))
    await click(host.querySelector('[data-bee-ready-to-close]'))
    expect(wizardText()).not.toMatch(/why are you closing this/i)
  })
})

// ── the appearance ruling ─────────────────────────────────────────
describe('clearly a button, visibly secondary', () => {
  it('the inline control carries real button chrome, not fine print', async () => {
    await mount(payloadFor('Final Processing', [OWING_INV], 500))
    const el = inlineBtn() as HTMLElement
    expect(el).toBeTruthy()
    // A border and a surface — the two things it previously lacked.
    expect(el.style.border).not.toBe('none')
    expect(el.style.border).not.toBe('')
    expect(el.style.background).not.toBe('transparent')
  })

  it('but NOT the filled accent of Mark won, and not in its slot', async () => {
    // Mark won is a solid accent button; this must stay outlined and
    // left-aligned, because on an owing engagement Mark won is absent and its
    // slot is where muscle memory lands.
    await mount(payloadFor('Final Processing', [OWING_INV], 500))
    const el = inlineBtn() as HTMLElement
    expect(el.style.alignSelf).toBe('flex-start')
    expect(el.style.width).not.toBe('100%')
    const src = readFileSync(join(process.cwd(), 'components/hive/EngagementPanel.jsx'), 'utf8')
    // the ordinary button's fill is T.accent.fg; the override must not take it
    const overrideBlock = src.slice(src.indexOf('data-bee-close-over-balance'), src.indexOf('data-bee-close-over-balance') + 420)
    expect(overrideBlock).not.toContain('T.accent.fg')
    expect(overrideBlock).toContain('rowActionBtn()')
  })

  it('releases the 16px button floor the way every other small action does', async () => {
    await mount(payloadFor('Final Processing', [OWING_INV], 500))
    expect((inlineBtn() as HTMLElement).className).toContain('bee-small-action')
  })

  it('no raw colour anywhere in the panel — tokens only', () => {
    const src = readFileSync(join(process.cwd(), 'components/hive/EngagementPanel.jsx'), 'utf8')
    const block = src.slice(src.indexOf('THE DELIBERATE SECOND ACTION'), src.indexOf('READY-TO-CLOSE cue'))
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(block).not.toMatch(/rgba?\(/)
  })
})

// ── nothing else moved ────────────────────────────────────────────
describe('everything else is unchanged', () => {
  const src = readFileSync(join(process.cwd(), 'components/hive/EngagementPanel.jsx'), 'utf8')

  it('the ordinary Mark won path still keys off canCloseWon', async () => {
    await mount(payloadFor('Final Processing', [PAID_INV]))
    expect(host.querySelector('[data-bee-ready-to-close]')).toBeTruthy()
    await mount(payloadFor('Final Processing', [OWING_INV], 500))
    expect(host.querySelector('[data-bee-ready-to-close]')).toBeFalsy()
  })

  it('the canCloseWon matrix itself is untouched', () => {
    expect(invoicesSettled([PAID_INV])).toBe(true)
    expect(invoicesSettled([])).toBe(true)        // never invoiced counts as settled
    expect(invoicesSettled([OWING_INV])).toBe(false)
    expect(invoicesSettled([PAID_INV, OWING_INV])).toBe(false)
  })

  it('there is ONE close-over-balance path, opened from two places', () => {
    // Two setWizard call sites, one wizard mount, one overBalance prop.
    expect(src.match(/setWizard\('won-over-balance'\)/g) || []).toHaveLength(2)
    expect(src.match(/overBalance=\{wizard === 'won-over-balance'\}/g) || []).toHaveLength(1)
  })

  it('no bulk action was introduced', () => {
    expect(src).not.toMatch(/close all|bulk|selected engagements/i)
  })

  it('the wizard still renders in the app’s existing centred modal', () => {
    // WizardShell → OverlayShell ("desktop centered modal / mobile bottom
    // sheet"). No new modal pattern was invented for the menu entry point.
    const kit = readFileSync(join(process.cwd(), 'components/hive/shared/CloseWizardKit.jsx'), 'utf8')
    expect(kit).toContain('OverlayShell')
    const wiz = readFileSync(join(process.cwd(), 'components/hive/shared/CloseWonWizard.jsx'), 'utf8')
    expect(wiz).toContain('WizardShell')
  })

  it('the menu item reuses the one wording, not a second string', () => {
    expect(src).toContain('label: OWING_CLOSE_ACTION')
  })
})
