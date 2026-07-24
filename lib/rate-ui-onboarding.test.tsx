// @vitest-environment happy-dom
//
// Onboarding rate/link asks — MOUNT test of OnboardingPathsEditor
// (confirm-not-choose flow).
//
// The rate-included styles quote {{rate_per_hour}} in their follow-up email
// (the 'rates' tag on PATH_STYLES); the booking-link styles send a link (the
// 'calendar' tag). Picking one in the revealed chooser is choosing to send a
// sentence that needs that value, so the SAME screen asks for it inline and
// gates its continue button. The -c defaults never ask. The Save payload
// carries ratePerHour so savePaths can persist it (empty when no rate is
// quoted, which the API ignores).
//
// No location context is mounted here, so nothing pre-seeds — the gates must
// hold until the owner types.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { OnboardingPathsEditor } from '@/components/BeeHub'

// Lead-phrased confirm-screen rows (onboarding-only wording — Settings keeps
// the c9b46c0 owner-phrased style names).
const LEAD_A = 'They reply to schedule · your rate in the email'
const LEAD_B = 'They book on your calendar · your rate in the email'
const LEAD_D = 'They book on your calendar · price on the call'

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

// Walk intro → Moving confirm. Optionally reveal the chooser and pick a
// lead-phrased style (null = keep the pre-selected -c default).
async function driveToMoving(onComplete: (p: any) => void, moveLead: string | null) {
  await act(async () => { root.render(<OnboardingPathsEditor onComplete={onComplete} />) })
  await act(async () => {})   // let the masters fetch resolve
  await clickText('Start with 📦 Moving →')
  if (moveLead) {
    await clickText('Change how this works')
    await clickText(moveLead)
  }
}

async function pickOrganizing(generalLead: string | null) {
  if (generalLead) {
    await clickText('Change how this works')
    await clickText(generalLead)
  }
}

describe('onboarding confirm screens — rate/link asks per selection', () => {
  it('rate-included (move) → asks for the rate ON the Moving screen, blocks continue until entered, payload carries it', async () => {
    const onComplete = vi.fn()
    await driveToMoving(onComplete, LEAD_A)

    // The rate block renders; the calendar block does not (A has no 'calendar' tag).
    expect(textEls('Hourly rate required').length).toBe(1)
    expect(textEls('Calendar link required').length).toBe(0)

    // Continue is gated on the rate.
    const gated = textEls('Add your hourly rate to continue')[0] as HTMLButtonElement
    expect(gated).toBeTruthy()
    expect(gated.disabled).toBe(true)

    const input = container.querySelector('input[placeholder="$95"]') as HTMLInputElement
    expect(input).toBeTruthy()
    await act(async () => { setNativeValue(input, '$95') })

    await clickText('Looks good — continue')
    await pickOrganizing(null)   // Organizing keeps its -c default
    await clickText('✓ Looks good — finish setup')
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ moveDefault: 'path-a', generalDefault: 'path-c', ratePerHour: '$95' }),
    )
  })

  it('booking-link + rate-included → demands BOTH the calendar link and the rate', async () => {
    const onComplete = vi.fn()
    await driveToMoving(onComplete, LEAD_B)

    expect(textEls('Calendar link required').length).toBe(1)
    expect(textEls('Hourly rate required').length).toBe(1)

    const calInput = container.querySelector('input[placeholder="https://calendly.com/your-name"]') as HTMLInputElement
    const rateInput = container.querySelector('input[placeholder="$95"]') as HTMLInputElement
    await act(async () => { setNativeValue(calInput, 'https://calendly.com/bee') })

    // Calendar alone isn't enough — the rate gate holds.
    expect((textEls('Add your hourly rate to continue')[0] as HTMLButtonElement)?.disabled).toBe(true)

    await act(async () => { setNativeValue(rateInput, '$85/hr (3-hour minimum)') })
    await clickText('Looks good — continue')
    await pickOrganizing(LEAD_B)
    await clickText('✓ Looks good — finish setup')
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ calendarLink: 'https://calendly.com/bee', ratePerHour: '$85/hr (3-hour minimum)' }),
    )
  })

  it('rate-on-the-call styles → NO rate ask anywhere; the booking-link style still wants its link; payload rate is empty (API ignores it)', async () => {
    const onComplete = vi.fn()
    await driveToMoving(onComplete, null)   // Moving keeps the -c default: nothing to set up
    expect(textEls('Hourly rate required').length).toBe(0)
    expect(textEls('Calendar link required').length).toBe(0)
    await clickText('Looks good — continue')

    await pickOrganizing(LEAD_D)
    expect(textEls('Hourly rate required').length).toBe(0)
    expect(textEls('Calendar link required').length).toBe(1)
    const calInput = container.querySelector('input[placeholder="https://calendly.com/your-name"]') as HTMLInputElement
    await act(async () => { setNativeValue(calInput, 'https://calendly.com/bee') })

    await clickText('✓ Looks good — finish setup')
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ ratePerHour: '' }))
  })

  it('the final screen gates on the UNION of both selections — Moving-only needs still block the finish', async () => {
    const onComplete = vi.fn()
    await driveToMoving(onComplete, LEAD_D)   // Moving needs the calendar link
    const calInput = container.querySelector('input[placeholder="https://calendly.com/your-name"]') as HTMLInputElement
    await act(async () => { setNativeValue(calInput, 'https://calendly.com/bee') })
    await clickText('Looks good — continue')

    // Organizing keeps -c, but the union still shows the (satisfied) calendar ask.
    expect(textEls('Calendar link required').length).toBe(1)
    const finish = textEls('✓ Looks good — finish setup')[0] as HTMLButtonElement
    expect(finish.disabled).toBe(false)

    await clickText('✓ Looks good — finish setup')
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ moveDefault: 'path-d', calendarLink: 'https://calendly.com/bee' }),
    )
  })
})
