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
  variantPairFor, variantPrerequisiteMissing,
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

// The sentence, the modal, the list's Change link and confirmVariant were
// RETIRED 2026-10-30: the Emails screen's two switches ask the same two
// questions and write the same variant. Their behaviour — reading the real
// variant, writing it, the split, and the guard as the switch's own — is
// pinned in lib/beta-variant-switches.test.tsx. The shared mapping and the
// prerequisite rule above are unchanged and still pinned here.
