// @vitest-environment happy-dom
//
// Issue 240 step 9c — the two questions.
//
// This replaces persistDefault, which lives only in the sequence tiles that
// step 11 retires. Without it an owner loses the ability to choose what their
// clients receive at all.
//
// THE RULE, read from production rather than assumed: all eight master
// variants are structurally identical (3 steps, day 0/5/30, same subjects).
// The only thing that varies is which tags the bodies quote:
//   a = rate, no link    b = rate + link    c = neither    d = link, no rate
//
// 9c-FIX: that mapping is NOT defined here or in 9c. pathStyleFromAnswers /
// answersFromPathStyle already owned it (issue 194, exported so onboarding and
// Settings could not drift apart). 9c shipped a duplicate; it is deleted, and
// this surface delegates. The canonical pins live in path-wizard-mapping.
//
// TWO FINDINGS THE COPY DEPENDS ON, both confirmed from lib/drip-lifecycle.ts:
//   * enrolment PINS the path row, so a switch is future-only
//   * a fork is orphaned by a switch, never deleted, and returns if you
//     switch back — 9 of 20 active locations run a forked default
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  EmailsList, TwoQuestionsModal,
  variantPairFor, variantPrerequisiteMissing, variantSentence,
  pathStyleFromAnswers, answersFromPathStyle, styleFromPathKey,
  BOOKING_REPLY, BOOKING_ONLINE, RATE_IN_EMAIL, RATE_ON_CALL,
} from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const RATE = '{{rate_per_hour}}'
const LINK = '{{book_assessment_link}}'
const step = (order: number, subject: string, body: string) => ({
  id: `s${order}`, order, type: 'email', delay_days: order === 1 ? 0 : order === 2 ? 5 : 30,
  subject, body, origin: 'master',
})
const STEPS = [step(1, 'One', 'One\n\nx.'), step(2, 'Two', 'Two\n\nx.'), step(3, 'Three', 'Three\n\nx.')]

let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

// ───────────── the rule ─────────────
describe('the 2x2 comes from the SHARED resolver, not a local copy', () => {
  // 9c-fix: this suite no longer owns a mapping of its own either. The
  // canonical pins live in path-wizard-mapping; these assert that the two
  // questions delegate rather than re-derive.
  it('every answer pair produces both path_keys', () => {
    const cases = [
      [BOOKING_REPLY,  RATE_IN_EMAIL, 'organizing-a', 'moving-a'],
      [BOOKING_ONLINE, RATE_IN_EMAIL, 'organizing-b', 'moving-b'],
      [BOOKING_REPLY,  RATE_ON_CALL,  'organizing-c', 'moving-c'],
      [BOOKING_ONLINE, RATE_ON_CALL,  'organizing-d', 'moving-d'],
    ] as const
    for (const [b, r, gen, mov] of cases) {
      expect(variantPairFor(b, r), `${b}/${r}`).toEqual({ generalDefault: gen, moveDefault: mov })
    }
  })

  it('delegates to pathStyleFromAnswers rather than deciding for itself', () => {
    for (const b of [BOOKING_REPLY, BOOKING_ONLINE]) {
      for (const r of [RATE_IN_EMAIL, RATE_ON_CALL]) {
        expect(variantPairFor(b, r).generalDefault.slice(-1))
          .toBe(pathStyleFromAnswers(b, r).replace('path-', ''))
      }
    }
  })

  it('organizing and moving never diverge', () => {
    for (const b of [BOOKING_REPLY, BOOKING_ONLINE]) {
      for (const r of [RATE_IN_EMAIL, RATE_ON_CALL]) {
        const p = variantPairFor(b, r)
        expect(p.generalDefault.slice(-1)).toBe(p.moveDefault.slice(-1))
      }
    }
  })

  it('a stored path_key reads back through the shared reverse map', () => {
    for (const l of ['a', 'b', 'c', 'd']) {
      const back = answersFromPathStyle(styleFromPathKey(`organizing-${l}`))
      expect(variantPairFor(back.booking, back.rate).generalDefault).toBe(`organizing-${l}`)
    }
  })
})

describe('the prerequisite rule', () => {
  const set = { ratePerHour: '95', locationCalendarLink: 'https://cal/x' }

  it('a rate-quoting answer needs a rate', () => {
    expect(variantPrerequisiteMissing(BOOKING_REPLY, RATE_IN_EMAIL, { ...set, ratePerHour: '' }))
      .toEqual(['rate'])
  })

  it('a link-quoting answer needs a link', () => {
    expect(variantPrerequisiteMissing(BOOKING_ONLINE, RATE_ON_CALL, { ...set, locationCalendarLink: '' }))
      .toEqual(['link'])
  })

  it('b needs both, and reports both', () => {
    expect(variantPrerequisiteMissing(BOOKING_ONLINE, RATE_IN_EMAIL, { ratePerHour: '', locationCalendarLink: '' }))
      .toEqual(['rate', 'link'])
  })

  it('c needs nothing — that is the point of c', () => {
    expect(variantPrerequisiteMissing(BOOKING_REPLY, RATE_ON_CALL, { ratePerHour: '', locationCalendarLink: '' }))
      .toEqual([])
  })

  it('whitespace is not a value', () => {
    expect(variantPrerequisiteMissing(BOOKING_REPLY, RATE_IN_EMAIL, { ratePerHour: '   ' }))
      .toEqual(['rate'])
  })
})

describe('the sentence reads back what is set', () => {
  it('says both halves, either way round', () => {
    expect(variantSentence(BOOKING_ONLINE, RATE_IN_EMAIL)).toContain('told your hourly rate')
    expect(variantSentence(BOOKING_ONLINE, RATE_IN_EMAIL)).toContain('book a time themselves')
    expect(variantSentence(BOOKING_REPLY, RATE_ON_CALL)).toContain('talked through on the call')
    expect(variantSentence(BOOKING_REPLY, RATE_ON_CALL)).toContain('reply to you')
  })
})

// ───────────── the modal ─────────────
describe('the modal collects what an answer needs before it will save', () => {
  const mount = async (over: any = {}) => {
    const props = {
      answers: { booking: BOOKING_REPLY, rate: RATE_ON_CALL },
      cfg: { ratePerHour: '', locationCalendarLink: '', generalDefault: 'organizing-c', moveDefault: 'moving-c' },
      ownsPathKeys: [], liveLeadCount: 0, busy: false, err: '',
      onCancel: vi.fn(), onConfirm: vi.fn(), ...over,
    }
    await act(async () => { root.render(<TwoQuestionsModal {...props} />) })
    return props
  }
  const byText = (t: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent === t) as HTMLButtonElement
  const save = () => byText('Save')
  const inputs = () => Array.from(container.querySelectorAll('input')) as HTMLInputElement[]
  const type = async (el: HTMLInputElement, v: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
  }

  it('answering yes to the rate reveals the field and blocks save until filled', async () => {
    await mount()
    await act(async () => { byText('Yes, put it in the email').click() })
    expect(inputs().length).toBe(1)
    expect(save().disabled).toBe(true)
    expect(container.textContent).toContain('We need this before those emails can send')
    await type(inputs()[0], '95')
    expect(save().disabled).toBe(false)
  })

  it('answering yes to the link blocks save until filled', async () => {
    await mount()
    await act(async () => { byText('Yes, they book themselves').click() })
    expect(save().disabled).toBe(true)
    await type(inputs()[0], 'https://cal.example/me')
    expect(save().disabled).toBe(false)
  })

  it('a rate-quoting variant cannot be chosen without a rate — loc_carmel is this bug, live', async () => {
    await mount()
    await act(async () => { byText('Yes, put it in the email').click() })
    await act(async () => { save().click() })
    expect(save().disabled).toBe(true)   // never fired
  })

  it('answering no needs nothing and saves straight away', async () => {
    const props = await mount({ cfg: { ratePerHour: '', locationCalendarLink: '', generalDefault: 'organizing-a', moveDefault: 'moving-a' },
      answers: { booking: BOOKING_REPLY, rate: RATE_IN_EMAIL } })
    await act(async () => { byText('No, I cover it on the call').click() })
    expect(save().disabled).toBe(false)
    await act(async () => { save().click() })
    expect(props.onConfirm).toHaveBeenCalled()
    expect(props.onConfirm.mock.calls[0][0]).toBe(BOOKING_REPLY)
    expect(props.onConfirm.mock.calls[0][1]).toBe(RATE_ON_CALL)
  })

  it('says it replaces all three emails in BOTH sequences', async () => {
    await mount()
    await act(async () => { byText('Yes, they book themselves').click() })
    expect(container.textContent).toContain('replaces all three emails, in both sequences')
  })

  it('states the live lead consequence — they finish what they started', async () => {
    await mount({ liveLeadCount: 12 })
    await act(async () => { byText('Yes, they book themselves').click() })
    expect(container.textContent).toContain('12 people')
    expect(container.textContent).toContain('carry on with the emails they started on')
  })

  it('with nobody mid-sequence it says so instead of quoting a number', async () => {
    await mount({ liveLeadCount: 0 })
    await act(async () => { byText('Yes, they book themselves').click() })
    expect(container.textContent).toContain('Nobody is partway through')
  })

  it('warns a location with edits that its wording is parked, not deleted', async () => {
    await mount({ ownsPathKeys: ['organizing-c', 'moving-c'], liveLeadCount: 0 })
    await act(async () => { byText('Yes, they book themselves').click() })
    expect(container.textContent).toContain('aren’t deleted')
    expect(container.textContent).toContain('come back if you switch back')
  })

  it('says nothing about forks when there are none', async () => {
    await mount({ ownsPathKeys: [] })
    await act(async () => { byText('Yes, they book themselves').click() })
    expect(container.textContent).not.toContain('aren’t deleted')
  })
})

// ───────────── the sentence on the list ─────────────
describe('the Emails list carries the sentence and its Change link', () => {
  const mount = async (over: any = {}) => {
    const props = {
      pathSteps: { 'organizing-b': STEPS }, masterSteps: { 'organizing-b': STEPS }, templates: [],
      generalDefault: 'organizing-b', moveDefault: 'moving-b', sendConfig: {},
      // issue 240 step 7b — the prop is a RESOLVER now, so the sentence can
      // describe whichever sequence the toggle is showing.
      variantAnswersFor: (key: string) => answersFromPathStyle(styleFromPathKey(key)),
      actions: { edit: vi.fn(), reset: vi.fn(), add: vi.fn(), editTiming: vi.fn(), changeVariant: vi.fn() },
      ...over,
    }
    await act(async () => { root.render(<EmailsList {...props} />) })
    return props
  }

  it('reads back the current variant as one sentence', async () => {
    await mount()
    expect(container.textContent).toContain('told your hourly rate')
    expect(container.textContent).toContain('book a time themselves')
  })

  it('offers exactly one Change link, and it calls out', async () => {
    const props = await mount()
    const link = Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'Change how this works')
    expect(link.length).toBe(1)
    await act(async () => { link[0].click() })
    expect(props.actions.changeVariant).toHaveBeenCalled()
  })

  it('a read-only mount shows the sentence but no Change link', async () => {
    await mount({ actions: null })
    expect(container.textContent).toContain('told your hourly rate')
    expect(Array.from(container.querySelectorAll('button')).some(b => b.textContent === 'Change how this works')).toBe(false)
  })
})

// ───────────── the write ─────────────
describe('the write sets both defaults and reuses the existing field paths', () => {
  const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
  const handler = beehub.slice(
    beehub.indexOf('async function confirmVariant('),
    beehub.indexOf("  // ─── issue 240 step 10 — edit a drip step's timing ───"))

  it('writes BOTH defaults, never one alone', () => {
    expect(handler).toContain("persistDefault('generalDefault', pair.generalDefault)")
    expect(handler).toContain("persistDefault('moveDefault', pair.moveDefault)")
  })

  it('reuses My Location’s existing write paths rather than inventing new ones', () => {
    expect(handler).toContain('persistRatePerHour(values.rate)')
    expect(handler).toContain("persistLocationField('bookingLink', 'calendar_link'")
  })

  it('refuses the write if a prerequisite is still missing after collection', () => {
    expect(handler).toContain('variantPrerequisiteMissing')
    expect(handler).toContain('if (still.length) throw')
  })

  it('does not touch step wording or timing', () => {
    expect(handler).not.toContain('commitSteps')
    expect(handler).not.toContain('delay_days')
  })
})
