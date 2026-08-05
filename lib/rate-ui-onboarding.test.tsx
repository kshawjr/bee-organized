// @vitest-environment happy-dom
//
// issue 194 — onboarding "new lead emails" is a two-question wizard, not a
// path-letter picker. MOUNT tests of OnboardingPathsEditor.
//
// The owner answers two plain-language questions — how a new lead books (reply
// vs book online) and whether the rate goes in the email — and the pair
// resolves to a master path (pathStyleFromAnswers). "Book online" reveals the
// booking-link field inline and gates Continue until it has a value; "rate in
// the email" does the same for the hourly rate. The -c pair (reply + rate on
// the call) needs nothing. Both project types take the same answers unless the
// owner ticks "Handle moving jobs differently", which runs the two questions a
// second time for moving only. The Save payload keeps the shape savePaths has
// always consumed: { moveDefault, generalDefault, calendarLink, ratePerHour }.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { OnboardingPathsEditor, CurrentLocationContext } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const REPLY  = 'They reply to you'
const ONLINE = 'They book online themselves'
const RATE_IN_EMAIL = 'Yes, put my rate in the email'
const RATE_ON_CALL  = 'No, cover it on the call'

const masterSteps = () => [
  { id: 's1', step_order: 1, delay_days: 0, channel: 'email', subject: 'Welcome', body: 'Hi {{first_name}}.', is_active: true },
  { id: 's2', step_order: 2, delay_days: 5, channel: 'email', subject: 'Following up', body: 'Checking in.', is_active: true },
  { id: 's3', step_order: 3, delay_days: 30, channel: 'email', subject: 'Last one', body: 'Final note.', is_active: true },
]
const MASTERS = ['a', 'b', 'c', 'd'].flatMap(l => [
  { id: `m-${l}`, path_key: `moving-${l}`, is_active: true, steps: masterSteps() },
  { id: `o-${l}`, path_key: `organizing-${l}`, is_active: true, steps: masterSteps() },
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

const calInput  = () => container.querySelector('input[placeholder="https://calendly.com/your-name"]') as HTMLInputElement
const rateInput = () => container.querySelector('input[placeholder="$95"]') as HTMLInputElement

const mount = async (onComplete = vi.fn(), location: any = null) => {
  await act(async () => {
    root.render(
      <CurrentLocationContext.Provider value={location as any}>
        <OnboardingPathsEditor onComplete={onComplete} />
      </CurrentLocationContext.Provider>,
    )
  })
  await act(async () => {})   // masters fetch
  await clickText('Get started →')   // intro → question 1
  return onComplete
}

// Walk the two shared questions with a booking + rate answer, filling the
// prerequisite fields when the answer demands them.
async function answerShared(bookingLabel: string, rateLabel: string, opts: { link?: string; rate?: string } = {}) {
  await clickText(bookingLabel)
  if (bookingLabel === ONLINE && opts.link !== undefined) await act(async () => { setNativeValue(calInput(), opts.link!) })
  await clickText('Continue →')
  await clickText(rateLabel)
  if (rateLabel === RATE_IN_EMAIL && opts.rate !== undefined) await act(async () => { setNativeValue(rateInput(), opts.rate!) })
  await clickText('See my emails →')
}

describe('each answer pair resolves to the correct path letter', () => {
  const CASES: Array<[string, string, string]> = [
    [REPLY,  RATE_ON_CALL,  'path-c'],
    [ONLINE, RATE_ON_CALL,  'path-d'],
    [REPLY,  RATE_IN_EMAIL, 'path-a'],
    [ONLINE, RATE_IN_EMAIL, 'path-b'],
  ]
  for (const [booking, rate, expected] of CASES) {
    it(`${booking} + ${rate} → ${expected} for both project types`, async () => {
      const onComplete = await mount()
      await answerShared(booking, rate, { link: 'https://calendly.com/bee', rate: '$95' })
      await clickText('✓ Finish setup')
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({ moveDefault: expected, generalDefault: expected }),
      )
    })
  }
})

describe('prerequisite gating', () => {
  it('choosing "book online" without a link blocks Continue', async () => {
    await mount()
    await clickText(ONLINE)
    // The booking-link field appears; Continue is gated on it.
    expect(calInput()).toBeTruthy()
    const gate = textEls('Add your booking link to continue')[0] as HTMLButtonElement
    expect(gate).toBeTruthy()
    expect(gate.disabled).toBe(true)
    // A full URL unlocks it.
    await act(async () => { setNativeValue(calInput(), 'https://calendly.com/bee') })
    expect((textEls('Continue →')[0] as HTMLButtonElement).disabled).toBe(false)
  })

  it('choosing "rate in the email" without a rate blocks Continue', async () => {
    await mount()
    await clickText(REPLY)
    await clickText('Continue →')
    await clickText(RATE_IN_EMAIL)
    expect(rateInput()).toBeTruthy()
    const gate = textEls('Add your hourly rate to continue')[0] as HTMLButtonElement
    expect(gate).toBeTruthy()
    expect(gate.disabled).toBe(true)
    await act(async () => { setNativeValue(rateInput(), '$95') })
    expect((textEls('See my emails →')[0] as HTMLButtonElement).disabled).toBe(false)
  })

  it('the -c pair (reply + rate on the call) asks for nothing', async () => {
    await mount()
    await clickText(REPLY)
    expect(calInput()).toBeFalsy()
    expect((textEls('Continue →')[0] as HTMLButtonElement).disabled).toBe(false)
    await clickText('Continue →')
    await clickText(RATE_ON_CALL)
    expect(rateInput()).toBeFalsy()
    expect((textEls('See my emails →')[0] as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('existing location values prefill and are never re-demanded', () => {
  it('an existing calendar_link prefills the booking-link field (Continue not blocked)', async () => {
    await mount(vi.fn(), { id: 'loc-1', calendar_link: 'https://calendly.com/saved' })
    await clickText(ONLINE)
    expect(calInput()?.value).toBe('https://calendly.com/saved')
    // Prefilled valid value → Continue is already enabled, no re-type.
    expect((textEls('Continue →')[0] as HTMLButtonElement).disabled).toBe(false)
  })

  it('an existing rate_per_hour prefills the rate field and rides the payload', async () => {
    const onComplete = await mount(vi.fn(), { id: 'loc-1', rate_per_hour: '$85' })
    await clickText(REPLY)
    await clickText('Continue →')
    await clickText(RATE_IN_EMAIL)
    expect(rateInput()?.value).toBe('$85')
    await clickText('See my emails →')
    await clickText('✓ Finish setup')
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ generalDefault: 'path-a', ratePerHour: '$85' }),
    )
  })

  it('a rate-on-the-call pair sends an empty rate (the API ignores it, never wiping a saved value)', async () => {
    const onComplete = await mount()
    await answerShared(REPLY, RATE_ON_CALL)
    await clickText('✓ Finish setup')
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ ratePerHour: '' }))
  })
})

describe('the split checkbox runs a second pass for moving only', () => {
  it('answers moving differently while organizing keeps the shared answer', async () => {
    const onComplete = await mount()
    // Shared pass: reply + rate on the call → path-c.
    await answerShared(REPLY, RATE_ON_CALL)
    // Tick the split, advance into the moving-only pass.
    await clickText('Handle moving jobs differently')
    await clickText('Next: set up moving jobs →')
    // Moving pass: book online + rate in email → path-b (needs both fields).
    await clickText(ONLINE)
    await act(async () => { setNativeValue(calInput(), 'https://calendly.com/bee') })
    await clickText('Continue →')
    await clickText(RATE_IN_EMAIL)
    await act(async () => { setNativeValue(rateInput(), '$120') })
    await clickText('See my moving emails →')
    await clickText('✓ Finish setup')
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        generalDefault: 'path-c',
        moveDefault: 'path-b',
        calendarLink: 'https://calendly.com/bee',
        ratePerHour: '$120',
      }),
    )
  })

  it('without the split, moving inherits the shared answer exactly', async () => {
    const onComplete = await mount()
    await answerShared(ONLINE, RATE_ON_CALL, { link: 'https://calendly.com/bee' })
    await clickText('✓ Finish setup')
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ moveDefault: 'path-d', generalDefault: 'path-d' }),
    )
  })
})
