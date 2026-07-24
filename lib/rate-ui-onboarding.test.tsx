// @vitest-environment happy-dom
//
// Onboarding rate ask — MOUNT test of OnboardingPathsEditor.
//
// Paths A/B quote {{rate_per_hour}} in their follow-up email (the 'rates'
// tag on PATH_STYLES); B/D send a booking link (the 'calendar' tag). The
// wizard has always demanded the calendar link for B/D — this suite pins
// the new symmetric demand: picking A or B demands the hourly rate, and
// picking C/D never asks. The Save payload carries ratePerHour so
// savePaths can persist it (empty for C/D, which the API ignores).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { OnboardingPathsEditor } from '@/components/BeeHub'

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
  await clickText("Let's pick my paths →")
  await clickText(moveLabel)
  await clickText('Next: Organizing Projects →')
  await clickText(generalLabel)
  await clickText('Review my choices →')
}

describe('onboarding wizard — rate ask on rate-quoting paths', () => {
  it('Path A (move) + Path C (general) → asks for the rate, blocks Save until entered, payload carries it', async () => {
    const onComplete = vi.fn()
    await driveToConfirm(onComplete, 'Path A', 'Path C')

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

  it('Path B → demands BOTH the calendar link and the rate', async () => {
    const onComplete = vi.fn()
    await driveToConfirm(onComplete, 'Path B', 'Path B')

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

  it('Path C + Path D → NO rate ask, NO rate gate; payload rate is empty (API ignores it)', async () => {
    const onComplete = vi.fn()
    await driveToConfirm(onComplete, 'Path C', 'Path D')

    expect(textEls('Hourly rate required').length).toBe(0)
    // D still wants its calendar link — the existing gate is untouched.
    expect(textEls('Calendar link required').length).toBe(1)
    const calInput = container.querySelector('input[placeholder="https://calendly.com/your-name"]') as HTMLInputElement
    await act(async () => { setNativeValue(calInput, 'https://calendly.com/bee') })

    await clickText('✓ Save & Complete')
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ ratePerHour: '' }))
  })
})
