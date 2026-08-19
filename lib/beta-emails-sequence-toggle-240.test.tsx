// @vitest-environment happy-dom
//
// Issue 240 step 7b — the moving sequence gets a surface.
//
// The Emails list rendered generalDefault only. moveDefault existed for one
// thing: a note telling owners to see the moving emails on the old
// Communication tab — the tab step 11 deletes. 12 leads are live on moving
// sequences, and 4 active locations (carmel, northjersey, portland, test) hold
// a fork on their MOVING path while running the master on organizing. Their
// edited wording was exactly what would have gone dark.
//
// NOT COMBINED MODE. Two sequences, one on screen at a time, each fully
// editable. The toggle is a VIEW and writes nothing; 9c's two questions remain
// the only way to change a variant.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  EmailsList, buildEmailList, answersFromPathStyle, styleFromPathKey,
} from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const RATE = '{{rate_per_hour}}'
// fromMaster is what masterStepsToUi stamps on a preview of the corp master;
// loadLocationPaths omits it on real location rows. It is the signal the list
// uses for "Bee Organized wording" vs "Your wording", so a fixture that leaves
// it off silently represents every row as edited.
const step = (order: number, subject: string, body = 'x\n\nsecond.', extra: any = {}) => ({
  id: `s${order}`, order, type: 'email', delay_days: order === 1 ? 0 : order === 2 ? 5 : 30,
  subject, body, origin: 'master', fromMaster: true, ...extra,
})
const ORG = [step(1, 'ORG ONE'), step(2, 'ORG TWO'), step(3, 'ORG THREE')]
const MOV = [step(1, 'MOV ONE'), step(2, 'MOV TWO'), step(3, 'MOV THREE')]
const tpl = (o: any) => ({
  dbId: o.dbId, legacyId: o.legacyId, name: '', type: 'email',
  subject: o.subject, body: o.body, isActive: true, isMaster: true,
  isOwnCustom: false, clonedFromId: null, updatedAt: '2026-01-01',
})
const TEMPLATES = [
  tpl({ dbId: 'w', legacyId: 'welcome', subject: 'Welcome!', body: 'W\n\nx.' }),
  tpl({ dbId: 'c3', legacyId: 'opp_closed_job_3mo', subject: '3mo', body: '3\n\nx.' }),
  tpl({ dbId: 'c12', legacyId: 'opp_closed_job_12mo', subject: '12mo', body: '12\n\nx.' }),
]

let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const mount = async (over: any = {}) => {
  const props = {
    pathSteps: { 'organizing-b': ORG, 'moving-b': MOV },
    masterSteps: { 'organizing-b': ORG, 'moving-b': MOV },
    templates: TEMPLATES, generalDefault: 'organizing-b', moveDefault: 'moving-b',
    sendConfig: { ratePerHour: '95', ownerBookingLink: 'x', locationCalendarLink: 'y' },
    variantAnswersFor: (k: string) => answersFromPathStyle(styleFromPathKey(k)),
    actions: { edit: vi.fn(), reset: vi.fn(), add: vi.fn(), editTiming: vi.fn(), changeVariant: vi.fn() },
    ...over,
  }
  await act(async () => { root.render(<EmailsList {...props} />) })
  return props
}
const btn = (t: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === t) as HTMLButtonElement
const reads = () => Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'Read')
const pencils = () => Array.from(container.querySelectorAll('button')).filter(b => (b.textContent ?? '').includes('✎'))
const text = () => container.textContent ?? ''

describe('the toggle switches which sequence is on screen', () => {
  it('starts on organizing and shows its wording', async () => {
    await mount()
    expect(text()).toContain('ORG ONE')
    expect(text()).not.toContain('MOV ONE')
  })

  it('switching to moving shows the moving wording instead', async () => {
    await mount()
    await act(async () => { btn('Moving').click() })
    expect(text()).toContain('MOV ONE')
    expect(text()).not.toContain('ORG ONE')
  })

  // issue 314 — was six rows either way; the welcome row is retired.
  it('five rows either way — one sequence at a time, never merged', async () => {
    await mount()
    expect(reads().length).toBe(5)
    await act(async () => { btn('Moving').click() })
    expect(reads().length).toBe(5)
    // The closed-job pair is shared, so it appears in both — the drip rows are
    // what swap.
    expect(text()).toContain('3mo')
  })

  it('the toggle WRITES NOTHING', async () => {
    const props = await mount()
    await act(async () => { btn('Moving').click() })
    await act(async () => { btn('Organizing').click() })
    for (const fn of ['edit', 'reset', 'add', 'editTiming', 'changeVariant']) {
      expect(props.actions[fn], fn).not.toHaveBeenCalled()
    }
  })

  it('is hidden when a location has no moving default at all', async () => {
    await mount({ moveDefault: null })
    expect(btn('Moving')).toBeUndefined()
    expect(reads().length).toBe(5)
  })

  it('closes an open row when switching, so the modal cannot show the other sequence', async () => {
    await mount()
    await act(async () => { reads()[0].click() })
    expect(container.querySelector('[role="dialog"]')).toBeTruthy()
    await act(async () => { btn('Moving').click() })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('every downstream feature works on the moving sequence', () => {
  const toMoving = async () => { await act(async () => { btn('Moving').click() }) }

  it('Edit hands back the MOVING path key (8b)', async () => {
    const props = await mount()
    await toMoving()
    await act(async () => { Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'Edit')[0].click() })
    const row = props.actions.edit.mock.calls[0][0]
    expect(row.pathKey).toBe('moving-b')
  })

  it('Add targets the MOVING path (9b)', async () => {
    const props = await mount()
    await toMoving()
    await act(async () => { btn('+ Add another email').click() })
    expect(props.actions.add).toHaveBeenCalledWith('moving-b')
  })

  it('Timing is editable on the moving drip rows (10)', async () => {
    const props = await mount()
    await toMoving()
    expect(pencils().length).toBe(3)
    await act(async () => { pencils()[0].click() })
    expect(props.actions.editTiming.mock.calls[0][0].pathKey).toBe('moving-b')
  })

  it('paused badges evaluate the MOVING wording (9a)', async () => {
    // Only the moving sequence quotes the rate; only it should be paused.
    await mount({
      pathSteps: { 'organizing-b': ORG, 'moving-b': [step(1, 'MOV ONE', `Our rate is ${RATE}.`), step(2, 'MOV TWO'), step(3, 'MOV THREE')] },
      sendConfig: { ratePerHour: '', ownerBookingLink: 'x', locationCalendarLink: 'y' },
    })
    expect(text()).not.toContain('Not sending')
    await toMoving()
    expect(text()).toContain('Not sending — it mentions your hourly rate')
  })

  it('reset offers on the moving sequence when its shape matches (8b)', async () => {
    await mount({
      pathSteps: { 'organizing-b': ORG, 'moving-b': MOV.map(s => ({ ...s, fromMaster: false, dbId: `db${s.order}` })) },
      masterSteps: { 'organizing-b': ORG, 'moving-b': MOV },
    })
    await toMoving()
    await act(async () => { reads()[0].click() })
    expect(container.querySelector('[role="dialog"]')!.textContent).toContain('Put the Bee Organized wording back')
  })

  it('a drifted MOVING shape disables reset there without touching organizing', async () => {
    const drifted = [...MOV.map(s => ({ ...s, fromMaster: false, dbId: `db${s.order}` })),
      { ...step(4, 'ADDED'), fromMaster: false, dbId: 'db4' }]
    await mount({
      pathSteps: { 'organizing-b': ORG.map(s => ({ ...s, fromMaster: false })), 'moving-b': drifted },
      masterSteps: { 'organizing-b': ORG, 'moving-b': MOV },
    })
    // organizing: reset available
    await act(async () => { reads()[0].click() })
    expect(container.querySelector('[role="dialog"]')!.textContent).toContain('Put the Bee Organized wording back')
    await act(async () => { (Array.from(container.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === 'Close') as HTMLElement).click() })
    // moving: disabled, with a reason
    await toMoving()
    await act(async () => { reads()[0].click() })
    const d = container.querySelector('[role="dialog"]')!
    expect(d.textContent).not.toContain('Put the Bee Organized wording back')
    expect(d.textContent).toContain('added to or reordered')
  })
})

describe('the two sequences are independent', () => {
  it('a fork on moving does not make organizing read as forked, or the reverse', async () => {
    // 4 production locations are exactly this shape: master organizing,
    // forked moving.
    await mount({
      pathSteps: { 'organizing-b': ORG, 'moving-b': MOV.map(s => ({ ...s, fromMaster: false, dbId: `db${s.order}` })) },
    })
    expect(text()).toContain('Bee Organized wording')
    expect(text()).not.toContain('Your wording')
    await act(async () => { btn('Moving').click() })
    expect(text()).toContain('Your wording')
  })

  it("loc_kc's mismatched letters render as they actually are, not as a pair", async () => {
    // organizing-a / moving-c: a quotes the rate, c quotes nothing. The
    // sentence must describe the sequence on screen, not assume they match.
    await mount({
      pathSteps: { 'organizing-a': ORG, 'moving-c': MOV },
      masterSteps: { 'organizing-a': ORG, 'moving-c': MOV },
      generalDefault: 'organizing-a', moveDefault: 'moving-c',
    })
    expect(text()).toContain('told your hourly rate')          // a
    await act(async () => { btn('Moving').click() })
    expect(text()).toContain('talked through on the call')     // c
    expect(text()).not.toContain('told your hourly rate')
  })

  it('the builder takes a path key, not "the organizing one"', () => {
    const org = buildEmailList({ pathSteps: { 'organizing-b': ORG, 'moving-b': MOV }, templates: TEMPLATES, pathKey: 'organizing-b' })
    const mov = buildEmailList({ pathSteps: { 'organizing-b': ORG, 'moving-b': MOV }, templates: TEMPLATES, pathKey: 'moving-b' })
    expect(org.newLead.map(r => r.subject)).toContain('ORG ONE')
    expect(mov.newLead.map(r => r.subject)).toContain('MOV ONE')
    // the closed-job pair is shared by both
    expect(org.afterJob.map(r => r.subject)).toEqual(mov.afterJob.map(r => r.subject))
  })
})
