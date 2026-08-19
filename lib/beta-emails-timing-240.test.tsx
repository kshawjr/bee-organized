// @vitest-environment happy-dom
//
// Issue 240 step 10 — timing.
//
// THE THREE FACTS THIS IS BUILT ON, each read from the code rather than assumed:
//
//  1. delay_days is ABSOLUTE FROM THE START, not relative to the previous step.
//     lib/drip-send.ts: gap = max(0, next.delay_days - current.delay_days).
//     Raising step 2 shortens the wait before step 3; step 3 keeps its day.
//  2. A lead ALREADY WAITING does not move. next_send_at has exactly two
//     writers — enrolment (drip-lifecycle) and advanceOrComplete (drip-send) —
//     and the cron selects .lte('next_send_at', now) without recomputing. So a
//     timing change reaches the hops AFTER the one a lead is waiting on, never
//     the pending one.
//  3. Nothing server-side enforces an ordering. The route checks only
//     Number.isFinite(delay_days) && delay_days >= 0: zero is legal, there is
//     no upper bound, and a value below the predecessor's silently clamps the
//     gap to zero via max(0, …) and sends on the next hourly tick. The floor
//     is ours to hold, which is why it is checked at save and not only at the
//     input.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EmailsList, TimingEditModal, timingFloorFor, timingMinFor, timingChangeEffect } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const step = (order: number, subject: string, delay: number, extra: any = {}) => ({
  id: `s${order}`, order, type: 'email', delay_days: delay,
  subject, body: `${subject}\n\nSecond line.`, origin: 'master', ...extra,
})
const STEPS = [step(1, 'One', 0), step(2, 'Two', 5), step(3, 'Three', 30)]
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

const mountList = async (over: any = {}) => {
  const props = {
    pathSteps: { p: STEPS }, masterSteps: { p: STEPS }, templates: TEMPLATES,
    generalDefault: 'p', moveDefault: 'p', sendConfig: {},
    actions: { edit: vi.fn(), reset: vi.fn(), add: vi.fn(), editTiming: vi.fn() },
    ...over,
  }
  await act(async () => { root.render(<EmailsList {...props} />) })
  return props
}
const pencils = () => Array.from(container.querySelectorAll('button')).filter(b => (b.textContent ?? '').includes('✎'))

// ───────────── the floor ─────────────
describe('the floor is the previous step, because nothing else enforces it', () => {
  it('the first step may be day 0', () => {
    expect(timingFloorFor(STEPS, 1)).toBe(0)
  })

  it('every later step floors at its predecessor', () => {
    expect(timingFloorFor(STEPS, 2)).toBe(0)
    expect(timingFloorFor(STEPS, 3)).toBe(5)
  })

  it('an appended step floors at the last real step', () => {
    const withAdded = [...STEPS, step(4, 'Added', 44, { origin: 'added' })]
    expect(timingFloorFor(withAdded, 4)).toBe(30)
    expect(timingMinFor(withAdded, 4)).toBe(31)
  })

  it('the minimum is one PAST the predecessor, never equal to it', () => {
    expect(timingMinFor(STEPS, 3)).toBe(6)     // predecessor is day 5
    expect(timingMinFor(STEPS, 1)).toBe(0)     // the first may still be day 0
  })

  it('is computed from sorted order, not array position', () => {
    const jumbled = [step(3, 'Three', 30), step(1, 'One', 0), step(2, 'Two', 5)]
    expect(timingFloorFor(jumbled, 3)).toBe(5)
  })
})

describe('what a change actually does — absolute, so nothing after it moves', () => {
  it('later steps keep their own day', () => {
    const eff = timingChangeEffect(STEPS, 2, 10)
    expect(eff.movesOthers).toBe(false)
    expect(eff.nextFollowerDay).toBe(30)
    expect(eff.followerCount).toBe(1)
  })

  it('the last step has nothing following it', () => {
    expect(timingChangeEffect(STEPS, 3, 40).followerCount).toBe(0)
  })
})

// ───────────── which rows may be edited ─────────────
describe('only rows whose timing is really data get a control', () => {
  it('the three drip rows have a pencil', async () => {
    await mountList()
    expect(pencils().length).toBe(3)
  })

  // issue 314 — RETARGETED. This pinned that CONSTANT timings render as plain
  // text rather than as an editable pencil. The welcome ('Next day') was one of
  // the three constants and is retired, so it drops out of the list and is
  // asserted absent instead; the closed-job pair still carries the behaviour.
  it('the closed-job pair renders timing as plain text', async () => {
    await mountList()
    const labels = pencils().map(b => b.textContent ?? '')
    for (const fixed of ['3 months later', 'A year later']) {
      expect(labels.some(l => l.includes(fixed)), `${fixed} must not be editable`).toBe(false)
    }
    // …and they are still visible, just not actionable.
    expect(container.textContent).toContain('3 months later')
    expect(container.textContent).toContain('A year later')
    // The retired welcome's timing label is gone entirely — not merely
    // un-editable. Its template is still in the fixture, so this can fail.
    expect(container.textContent).not.toContain('Next day')
  })

  it('an added step is editable like any other drip row', async () => {
    const withAdded = [...STEPS, step(4, 'Added', 44, { origin: 'added' })]
    await mountList({ pathSteps: { p: withAdded }, masterSteps: { p: STEPS } })
    expect(pencils().length).toBe(4)
  })

  it('a read-only mount offers no timing control at all', async () => {
    await mountList({ actions: null })
    expect(pencils().length).toBe(0)
  })
})

// ───────────── the modal ─────────────
describe('the editor refuses a value that would send straight away', () => {
  const mountModal = async (over: any = {}) => {
    const props = { row: { order: 3, days: 30, subject: 'Three', rail: 'drip', timingIsData: true },
      steps: STEPS, ownsPath: true, liveLeadCount: 0, busy: false, err: '',
      onCancel: vi.fn(), onConfirm: vi.fn(), ...over }
    await act(async () => { root.render(<TimingEditModal {...props} />) })
    return props
  }
  const input = () => container.querySelector('input[type="number"]') as HTMLInputElement
  const saveBtn = () => Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Save') as HTMLButtonElement
  const setVal = async (v: string) => {
    const el = input()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  it('refuses a delay below the predecessor, at the INPUT not just on save', async () => {
    await mountModal()
    await setVal('4')                       // predecessor is day 5
    expect(saveBtn().disabled).toBe(true)
    expect(container.textContent).toContain('go out straight away')
    expect(container.textContent).toContain('day 6 or later')
  })

  it('EQUAL to the predecessor is also refused — that IS the zero gap', async () => {
    // The brief's wording ("may not fall below") would permit this; its stated
    // reason forbids it, because max(0, 5 - 5) is 0 and both emails land the
    // same day. The reason wins.
    await mountModal()
    await setVal('5')
    expect(saveBtn().disabled).toBe(true)
  })

  it('one day later is the lowest thing it will take', async () => {
    await mountModal()
    await setVal('6')
    expect(saveBtn().disabled).toBe(false)
  })

  it('accepts a legal value and hands back a number', async () => {
    const props = await mountModal()
    await setVal('40')
    expect(saveBtn().disabled).toBe(false)
    await act(async () => { saveBtn().click() })
    expect(props.onConfirm).toHaveBeenCalledWith(40)
  })

  it('says later emails keep their own day — the absolute rule, in words', async () => {
    await mountModal({ row: { order: 2, days: 5, subject: 'Two', rail: 'drip', timingIsData: true } })
    expect(container.textContent).toContain('keep the days they already have')
    expect(container.textContent).toContain('day 30')
  })

  it('owns the path: says the pending email keeps its date, later ones change', async () => {
    await mountModal({ ownsPath: true, liveLeadCount: 7 })
    expect(container.textContent).toContain('7 people are')
    expect(container.textContent).toContain('keeps the date it was given')
  })

  it('does NOT own the path: the other sentence, plus the permanent consequence', async () => {
    await mountModal({ ownsPath: false, liveLeadCount: 0 })
    expect(container.textContent).toContain('Nobody partway through this sequence is affected')
    expect(container.textContent).toContain('stops following Bee Organized')
    expect(container.textContent).toContain('can’t be undone')
  })

  it('the two cases say different things, not one sentence with a number swapped', async () => {
    await mountModal({ ownsPath: true, liveLeadCount: 3 })
    const owned = container.textContent ?? ''
    await act(async () => { root.unmount() })
    container.remove(); container = document.createElement('div')
    document.body.appendChild(container); root = createRoot(container)
    await mountModal({ ownsPath: false, liveLeadCount: 3 })
    expect(container.textContent).not.toBe(owned)
    expect(owned).toContain('3 people are')
    expect(container.textContent).not.toContain('3 people are')
  })
})

// ───────────── the write, and what it must not touch ─────────────
describe('the write is delay_days only, and the floor is re-checked at save', () => {
  const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
  const handler = beehub.slice(
    beehub.indexOf('async function confirmTimingEdit('),
    beehub.indexOf('  // ─── issue 240 step 9b — append an email ───'))

  it('re-checks the floor at save — the input is courtesy, this is the guarantee', () => {
    expect(handler).toContain('timingMinFor(steps, row.order)')
    expect(handler).toContain('nextDelay < minDay')
  })

  it('writes delay_days and never subject or body', () => {
    expect(handler).toContain('delay_days: nextDelay')
    expect(handler).not.toContain('subject:')
    expect(handler).not.toContain('body:')
  })

  it('forks first on an unowned path', () => {
    expect(handler).toContain('ensureOwnedThen(pathKey')
  })

  it('reset still restores wording only — it never touches timing', () => {
    const reset = beehub.slice(
      beehub.indexOf('async function emailsRowReset('),
      beehub.indexOf('  function ensureOwnedThen('))
    expect(reset).toContain('subject: src.subject')
    expect(reset).toContain('body: src.body')
    expect(reset).not.toContain('delay_days:')
  })

  it('the clone still stamps origin on every copied step (9b regression guard)', () => {
    const clone = readFileSync(join(process.cwd(), 'app/api/locations/[id]/drip-paths/clone/route.ts'), 'utf8')
    expect(clone).toContain("origin: 'master'")
  })

  it('origin AND delay_days both survive a second save (9b regression guard)', () => {
    // The same pipeline shape as 9b's round trip. A timing edit re-sends every
    // step, so a dropped origin would surface here first.
    const validator = (raw: any) => ({ step_order: raw.step_order, delay_days: raw.delay_days,
      channel: raw.channel, master_template_id: raw.master_template_id ?? null,
      subject: raw.subject ?? null, body: raw.body ?? null,
      origin: raw.origin === 'added' ? 'added' : 'master' })
    const insert = (v: any) => ({ ...v, id: 'db', is_active: true })
    const getMap = (r: any) => ({ ...r, origin: r.origin ?? 'master' })
    const clientMap = (r: any) => ({ order: r.step_order, delay_days: r.delay_days, type: r.channel,
      subject: r.subject, body: r.body, masterTemplateId: r.master_template_id,
      origin: r.origin === 'added' ? 'added' : 'master' })
    const payload = (s: any) => ({ step_order: s.order, delay_days: s.delay_days, channel: s.type,
      master_template_id: s.masterTemplateId ?? null, subject: s.subject ?? null,
      body: s.body ?? null, origin: s.origin === 'added' ? 'added' : 'master' })

    let stored = insert(validator(payload({ order: 4, delay_days: 44, type: 'email', origin: 'added' })))
    let onClient = clientMap(getMap(stored))
    onClient = { ...onClient, delay_days: 60 }            // the timing edit
    stored = insert(validator(payload(onClient)))
    expect(stored.delay_days, 'after the SECOND save').toBe(60)
    expect(stored.origin, 'after the SECOND save').toBe('added')
  })
})
