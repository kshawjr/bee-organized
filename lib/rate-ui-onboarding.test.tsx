// @vitest-environment happy-dom
//
// Onboarding rate ask — MOUNT test of OnboardingPathsEditor.
//
// The rate-included styles quote {{rate_per_hour}} in their follow-up email (the 'rates'
// tag on PATH_STYLES); the booking-link styles send a link (the 'calendar' tag). The
// wizard has always demanded the calendar link for those — this suite pins
// the symmetric demand: a rate-included style demands the hourly rate, and
// a rate-on-the-call style never asks. The Save payload carries ratePerHour so
// savePaths can persist it (empty when no rate is quoted, which the API ignores).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { OnboardingPathsEditor } from '@/components/BeeHub'

// The four styles are named by what they DO now — no more "Path A/B/C/D".
// (The DB path_key values are untouched; these are labels only.)
const PATH_A = 'Reply to schedule · rate included'
const PATH_B = 'Booking link · rate included'
const PATH_C = 'Reply to schedule · rate on the call'
const PATH_D = 'Booking link · rate on the call'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const MASTERS = ['a', 'b', 'c', 'd'].flatMap(l => [
  { path_key: `moving-${l}`, is_active: true },
  { path_key: `organizing-${l}`, is_active: true },
])

let container: HTMLElement
let root: ReturnType<typeof createRoot>

const fetchMock = vi.fn(async (url: any) => ({
  ok: true,
  json: async () =>
    String(url).includes('/api/drip-paths/masters') ? { masters: MASTERS } : {},
}))

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockClear()
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
  Array.from(container.querySelectorAll('p, button, span')).filter(
    el => el.textContent?.trim() === t,
  )

const clickText = async (t: string) => {
  const el = textEls(t)[0]
  expect(el, `element with text "${t}"`).toBeTruthy()
  await act(async () => { (el as HTMLElement).click() })
}

const setNativeValue = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

// Walk intro → move → general → confirm, selecting the given path labels.
async function driveToConfirm(onComplete: (p: any) => void, moveLabel: string, generalLabel: string) {
  await act(async () => { root.render(<OnboardingPathsEditor onComplete={onComplete} />) })
  await act(async () => {})   // let the masters fetch resolve
  await clickText('Start with 📦 Moving →')
  await clickText(moveLabel)
  await clickText('Next: 🏠 Organizing projects →')
  await clickText(generalLabel)
  await clickText('Review my choices →')
}

describe('onboarding wizard — rate ask on rate-quoting paths', () => {
  it('rate-included (move) + rate-on-the-call (general) → asks for the rate, blocks Save until entered, payload carries it', async () => {
    const onComplete = vi.fn()
    await driveToConfirm(onComplete, PATH_A, PATH_C)

    // The rate block renders; the calendar block does not (A/C have no 'calendar' tag).
    expect(textEls('Hourly rate required').length).toBe(1)
    expect(textEls('Calendar link required').length).toBe(0)

    // Save is gated on the rate.
    const gated = textEls('Add your hourly rate to continue')[0] as HTMLButtonElement
    expect(gated).toBeTruthy()
    expect(gated.disabled).toBe(true)

    const input = container.querySelector('input[placeholder="$95"]') as HTMLInputElement
    expect(input).toBeTruthy()
    await act(async () => { setNativeValue(input, '$95') })

    await clickText('✓ Save & Complete')
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ moveDefault: 'path-a', generalDefault: 'path-c', ratePerHour: '$95' }),
    )
  })

  it('booking-link + rate-included → demands BOTH the calendar link and the rate', async () => {
    const onComplete = vi.fn()
    await driveToConfirm(onComplete, PATH_B, PATH_B)

    expect(textEls('Calendar link required').length).toBe(1)
    expect(textEls('Hourly rate required').length).toBe(1)

    const calInput = container.querySelector('input[placeholder="https://calendly.com/your-name"]') as HTMLInputElement
    const rateInput = container.querySelector('input[placeholder="$95"]') as HTMLInputElement
    await act(async () => { setNativeValue(calInput, 'https://calendly.com/bee') })

    // Calendar alone isn't enough — the rate gate holds.
    expect((textEls('Add your hourly rate to continue')[0] as HTMLButtonElement)?.disabled).toBe(true)

    await act(async () => { setNativeValue(rateInput, '$85/hr (3-hour minimum)') })
    await clickText('✓ Save & Complete')
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ calendarLink: 'https://calendly.com/bee', ratePerHour: '$85/hr (3-hour minimum)' }),
    )
  })

  it('both rate-on-the-call styles → NO rate ask, NO rate gate; payload rate is empty (API ignores it)', async () => {
    const onComplete = vi.fn()
    await driveToConfirm(onComplete, PATH_C, PATH_D)

    expect(textEls('Hourly rate required').length).toBe(0)
    // The booking-link style still wants its calendar link — the existing gate is untouched.
    expect(textEls('Calendar link required').length).toBe(1)
    const calInput = container.querySelector('input[placeholder="https://calendly.com/your-name"]') as HTMLInputElement
    await act(async () => { setNativeValue(calInput, 'https://calendly.com/bee') })

    await clickText('✓ Save & Complete')
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ ratePerHour: '' }))
  })
})
