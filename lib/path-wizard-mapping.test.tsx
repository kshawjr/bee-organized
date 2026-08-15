// @vitest-environment happy-dom
//
// issue 194 — the path letters are two questions. This suite pins the ONE
// mapping both surfaces share:
//
//   1. pathStyleFromAnswers / answersFromPathStyle — the pure 2x2 resolver,
//      exported so onboarding and Settings can't drift apart.
//   2. The Settings surface drives its default off that SAME resolver:
//      answering the two questions PATCHes the correct path_key.
//
// Part 2 used to drive the sequence tiles. Issue 240 step 11 retires those, so
// it now drives their replacement — step 9c's two questions on the Emails tab.
// The guard has to follow the surface, or retirement quietly removes it.
//
// WHY THIS SUITE MATTERS, named so the next person sees it: issue 240 step 9c
// shipped a SECOND implementation of this 2x2 (variantLetterFor /
// variantAnswersFor) while onboarding kept calling these originals. The two
// happened to agree — verified across all four combinations, both directions —
// so nothing broke, but the app was one edit away from onboarding and Settings
// promising clients different things. The duplicate was deleted in 9c-fix and
// this file is what stops a third appearing. Pin the RESOLVER, not just the UI.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SettingsScreen,
  variantPairFor,
  styleFromPathKey,
  pathStyleFromAnswers,
  answersFromPathStyle,
  BOOKING_REPLY,
  BOOKING_ONLINE,
  RATE_IN_EMAIL,
  RATE_ON_CALL,
} from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('pathStyleFromAnswers — the shared 2x2 resolver', () => {
  it('maps each answer pair to the historical path letter', () => {
    expect(pathStyleFromAnswers(BOOKING_REPLY,  RATE_IN_EMAIL)).toBe('path-a')
    expect(pathStyleFromAnswers(BOOKING_ONLINE, RATE_IN_EMAIL)).toBe('path-b')
    expect(pathStyleFromAnswers(BOOKING_REPLY,  RATE_ON_CALL)).toBe('path-c')
    expect(pathStyleFromAnswers(BOOKING_ONLINE, RATE_ON_CALL)).toBe('path-d')
  })

  it('round-trips through answersFromPathStyle', () => {
    for (const id of ['path-a', 'path-b', 'path-c', 'path-d']) {
      const { booking, rate } = answersFromPathStyle(id)
      expect(pathStyleFromAnswers(booking, rate)).toBe(id)
    }
  })

  it('an unknown style yields no answers, and a partial pair falls back to the safe -c', () => {
    expect(answersFromPathStyle('custom')).toEqual({ booking: null, rate: null })
    expect(answersFromPathStyle('')).toEqual({ booking: null, rate: null })
    // Partial (a question still unanswered) never resolves to a booking-link or
    // rate-quoting path — it stays on the "needs nothing" -c until both answered.
    expect(pathStyleFromAnswers(BOOKING_REPLY, null)).toBe('path-c')
    expect(pathStyleFromAnswers(null, RATE_IN_EMAIL)).toBe('path-c')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
const LOC_UUID = '2b3c4d5e-1111-4222-8333-444455556666'

const masterSteps = () => [
  { id: 's1', step_order: 1, delay_days: 0, channel: 'email', subject: 'One', body: 'B1', is_active: true },
  { id: 's2', step_order: 2, delay_days: 5, channel: 'email', subject: 'Two', body: 'B2', is_active: true },
]
const MASTERS = ['a', 'b', 'c', 'd'].flatMap(l => [
  { id: `master-moving-${l}`, path_key: `moving-${l}`, name: `Move ${l}`, is_active: true, steps: masterSteps() },
  { id: `master-organizing-${l}`, path_key: `organizing-${l}`, name: `Org ${l}`, is_active: true, steps: masterSteps() },
])

const selectedLoc = {
  id: LOC_UUID, name: 'Testville', address: '1 Main', phone: '(111) 222-3333',
  bookingLink: '', reviewsLink: '', ratePerHour: '', serviceRadius: '', timezone: 'America/Chicago',
  assessmentType: 'in-person', smsEnabled: false, jobberConnected: false,
  jobberAccountId: null, crmStatus: 'active', sendFromName: 'Bee', sendFromEmail: 'a@b.c', replyToEmail: 'a@b.c',
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: { url: string; method: string; body: any }[]
let defaultDrip: string | null
let defaultMove: string | null

function makeFetch() {
  return vi.fn(async (url: any, init: any = {}) => {
    const u = String(url)
    const method = init?.method || 'GET'
    let body: any = undefined
    try { body = init?.body ? JSON.parse(init.body) : undefined } catch { /* non-JSON */ }
    calls.push({ url: u, method, body })

    if (u.includes('/api/drip-paths/masters')) {
      return { ok: true, status: 200, json: async () => ({ masters: MASTERS }) }
    }
    if (method === 'GET' && u.includes(`/api/locations/${LOC_UUID}/drip-paths`)) {
      return { ok: true, status: 200, json: async () => ({ paths: [], default_drip_path: defaultDrip, default_move_drip_path: defaultMove }) }
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
}

beforeEach(() => {
  calls = []
  defaultDrip = null
  defaultMove = null
  vi.stubGlobal('fetch', makeFetch())
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('confirm', vi.fn(() => true))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const textEls = (t: string) =>
  Array.from(container.querySelectorAll('p, button, span')).filter(el => el.textContent?.trim() === t)

const clickText = async (t: string) => {
  const el = textEls(t)[0]
  expect(el, `element with text "${t}"`).toBeTruthy()
  await act(async () => { (el as HTMLElement).click() })
}

const mountPaths = async () => {
  await act(async () => { root.render(<SettingsScreen selectedLoc={selectedLoc} initialSection="paths" />) })
  await act(async () => {})   // masters + location paths fetches
}

const defaultPatches = () =>
  calls.filter(c => c.method === 'PATCH' && c.url.includes(`/api/locations/${LOC_UUID}/drip-paths`))

describe('the two questions drive the default off the same resolver', () => {
  it('every answer pair resolves to the pair of path_keys, organizing and moving together', () => {
    // variantPairFor is a thin wrapper over pathStyleFromAnswers — it must not
    // grow a mapping of its own.
    const cases = [
      [BOOKING_REPLY,  RATE_IN_EMAIL, 'organizing-a', 'moving-a'],
      [BOOKING_ONLINE, RATE_IN_EMAIL, 'organizing-b', 'moving-b'],
      [BOOKING_REPLY,  RATE_ON_CALL,  'organizing-c', 'moving-c'],
      [BOOKING_ONLINE, RATE_ON_CALL,  'organizing-d', 'moving-d'],
    ] as const
    for (const [booking, rate, gen, mov] of cases) {
      expect(variantPairFor(booking, rate), `${booking}/${rate}`).toEqual({ generalDefault: gen, moveDefault: mov })
      // and it agrees with the resolver it delegates to
      expect(variantPairFor(booking, rate).generalDefault.slice(-1))
        .toBe(pathStyleFromAnswers(booking, rate).replace('path-', ''))
    }
  })

  it('organizing and moving never diverge — one answer pair, both sequences', () => {
    for (const booking of [BOOKING_REPLY, BOOKING_ONLINE]) {
      for (const rate of [RATE_IN_EMAIL, RATE_ON_CALL]) {
        const p = variantPairFor(booking, rate)
        expect(p.generalDefault.slice(-1)).toBe(p.moveDefault.slice(-1))
      }
    }
  })

  it('a stored path_key reads back as the answers that produced it', () => {
    for (const l of ['a', 'b', 'c', 'd']) {
      const back = answersFromPathStyle(styleFromPathKey(`organizing-${l}`))
      expect(variantPairFor(back.booking, back.rate).generalDefault).toBe(`organizing-${l}`)
    }
  })

  it('an unrecognised path_key yields no style, so the questions start unanswered', () => {
    expect(styleFromPathKey('custom')).toBe('')
    expect(styleFromPathKey('')).toBe('')
    expect(answersFromPathStyle(styleFromPathKey('custom'))).toEqual({ booking: null, rate: null })
  })

  it('THE DRIFT GUARD: there is exactly ONE 2x2 in the file', () => {
    // A second resolver is how onboarding and Settings come apart. If this
    // fails, someone has re-forked the mapping — extend the original instead.
    const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
    // Assert on the DEFINITION, not the bare name: the comment explaining why
    // these were deleted names them, and a name check would fail on the prose
    // rather than the code.
    for (const gone of ['variantLetterFor', 'variantAnswersFor']) {
      expect(src, `${gone} was deleted in 9c-fix and must not come back`)
        .not.toMatch(new RegExp(`function\\s+${gone}\\s*\\(`))
    }
    expect(src.match(/export function pathStyleFromAnswers\(/g)?.length ?? 0).toBe(1)
    expect(src.match(/export function answersFromPathStyle\(/g)?.length ?? 0).toBe(1)
  })
})
