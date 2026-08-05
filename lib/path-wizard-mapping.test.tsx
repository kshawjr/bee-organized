// @vitest-environment happy-dom
//
// issue 194 — the path letters are two questions. This suite pins the ONE
// mapping both surfaces share:
//
//   1. pathStyleFromAnswers / answersFromPathStyle — the pure 2x2 resolver,
//      exported so onboarding and Settings can't drift apart.
//   2. Settings → Communications drives its per-project-type default off that
//      same resolver: answering the two questions PATCHes the correct path_key.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import {
  SettingsScreen,
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

describe('Settings → Communications drives the default off the same mapping', () => {
  it('answering both questions for Moving PATCHes the resolved path_key (book online + rate in email → moving-b)', async () => {
    await mountPaths()
    await clickText('Moving projects')   // open the moving sequence editor
    await clickText('They book online')  // question 1
    await clickText('Yes, in the email') // question 2 → resolves + persists

    const patch = defaultPatches().at(-1)
    expect(patch, 'a default PATCH').toBeTruthy()
    expect(patch!.body).toEqual({ default_move: 'moving-b' })
  })

  it('Organizing writes the general default (reply + rate on the call → organizing-c)', async () => {
    await mountPaths()
    await clickText('Organizing projects')
    await clickText('They reply to me')
    await clickText('No, on the call')

    const patch = defaultPatches().at(-1)
    expect(patch!.body).toEqual({ default: 'organizing-c' })
  })

  it('the questions pre-seed from the stored default, so changing one answer moves to the adjacent path (moving-b → moving-d)', async () => {
    defaultMove = 'moving-b'   // book online + rate in email
    await mountPaths()
    await clickText('Moving projects')
    // Flip only the rate answer: online stays, rate → on the call ⇒ moving-d.
    await clickText('No, on the call')

    const patch = defaultPatches().at(-1)
    expect(patch!.body).toEqual({ default_move: 'moving-d' })
  })
})
