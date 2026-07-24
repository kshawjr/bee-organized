// @vitest-environment happy-dom
//
// Onboarding new-lead-emails — CONFIRM, DON'T CHOOSE. MOUNT tests of
// OnboardingPathsEditor.
//
//   1. Both project types land PRE-SELECTED on the -c style ("reply to
//      schedule · rate on the call") with email 1 already open — the owner
//      reads real master copy, they don't pick from four abstract cards.
//   2. "Looks good — continue" advances Moving → Organizing, and the final
//      "Looks good" persists the -c defaults untouched via onComplete.
//   3. "Change how this works" reveals the four lead-phrased styles with
//      their setup cost; selecting one that needs a rate/link asks for it
//      inline and gates the continue button.
//   4. The step count in the heading reads from the master (a 4-step
//      moving-d shows "Four emails"), never a hardcoded three.
//   5. "Build your own" is GONE from onboarding — it configured zero emails
//      while claiming a placeholder sequence ran.
//   6. Preview parity: the open email renders through the shared 14-variable
//      pipeline (lib/preview-vars → RenderedTemplatePreview) — real location
//      values fill in, unknowns get the labelled sample, never a raw token.
//   7. Kept values: the calendar/rate asks pre-seed from the location row and
//      ride the Save payload.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { OnboardingPathsEditor, CurrentLocationContext } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Lead-phrased confirm-screen rows (onboarding-only wording; Settings keeps
// the c9b46c0 style names).
const LEAD_C = 'They reply to schedule · price on the call'
const LEAD_D = 'They book on your calendar · price on the call'
const LEAD_A = 'They reply to schedule · your rate in the email'
const LEAD_B = 'They book on your calendar · your rate in the email'

const LOCATION = {
  id: 'loc-uuid-1',
  name: 'Bee Organized Omaha',
  calendar_link: 'https://calendly.com/bee-omaha',
  rate_per_hour: '$85',
  city: 'Omaha',
  state: 'NE',
}

// Token-bearing master content: the open email must resolve what the location
// knows and fill {{reviews_link}} with the labelled sample (LOCATION has none).
const masterSteps = () => [
  { id: 's1', step_order: 1, delay_days: 0, channel: 'email', subject: 'Welcome to {{location_name}}', body: 'Hi {{first_name}}, our rate starts at {{rate_per_hour}} per hour. Book here: {{owner_booking_link}}. Reviews: {{reviews_link}}', is_active: true },
  { id: 's2', step_order: 2, delay_days: 5, channel: 'email', subject: 'Following up', body: 'Just checking in, {{first_name}}.', is_active: true },
  { id: 's3', step_order: 3, delay_days: 30, channel: 'email', subject: 'One last check-in', body: 'Last note from us, {{first_name}}.', is_active: true },
]

const MASTERS = ['a', 'b', 'c', 'd'].flatMap(l => [
  { id: `m-${l}`, path_key: `moving-${l}`, is_active: true, steps: masterSteps() },
  { id: `o-${l}`, path_key: `organizing-${l}`, is_active: true, steps: masterSteps() },
])

let container: HTMLElement
let root: ReturnType<typeof createRoot>

const mastersFetch = (masters: any[]) =>
  vi.fn(async (url: any) => ({
    ok: true,
    json: async () => (String(url).includes('/api/drip-paths/masters') ? { masters } : {}),
  }))

beforeEach(() => {
  vi.stubGlobal('fetch', mastersFetch(MASTERS))
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

const mount = async (onComplete = vi.fn(), location: any = LOCATION) => {
  await act(async () => {
    root.render(
      <CurrentLocationContext.Provider value={location as any}>
        <OnboardingPathsEditor onComplete={onComplete} />
      </CurrentLocationContext.Provider>,
    )
  })
  await act(async () => {})   // masters fetch
  return onComplete
}

describe('lands pre-selected on -c with email 1 open', () => {
  it('the Moving screen is a confirm screen: -c copy visible, email 1 body rendered inline, zero clicks', async () => {
    await mount()
    await clickText('Start with 📦 Moving →')

    const t = container.textContent || ''
    // Confirm framing, not a chooser.
    expect(t).toContain("Here's what a new Moving lead receives")
    expect(t).toContain('Step 1 of 2 · Organizing is next')
    expect(t).toContain('Three emails, sent automatically. You can change any of this later.')
    // The -c explainer (pre-selected default).
    expect(t).toContain('pricing comes up on the call — not in the email. Most owners start here.')
    // Email 1 is open: substituted subject AND body visible without a click.
    expect(t).toContain('Welcome to Bee Organized Omaha')
    expect(t).toContain('Hi John, our rate starts at $85 per hour.')
    expect(t).not.toContain('Welcome to {{location_name}}')
    // Emails 2 and 3 collapsed: timing + one-line summary only.
    expect(t).toContain('Email 2 · 5 days later')
    expect(t).toContain('Following up')
    expect(t).toContain('Email 3 · 30 days later')
    expect(t).not.toContain('Just checking in, John.')
    // The four-card decision is hidden behind the quiet secondary.
    expect(textEls('Change how this works').length).toBe(1)
    expect(t).not.toContain(LEAD_D)
  })

  it('the default -c styles need nothing: no rate ask, no calendar ask, continue enabled', async () => {
    await mount(vi.fn(), { ...LOCATION, calendar_link: '', rate_per_hour: '' })
    await clickText('Start with 📦 Moving →')

    expect(textEls('Calendar link required').length).toBe(0)
    expect(textEls('Hourly rate required').length).toBe(0)
    const btn = textEls('Looks good — continue')[0] as HTMLButtonElement
    expect(btn).toBeTruthy()
    expect(btn.disabled).toBe(false)
  })
})

describe('"Looks good" persists the default and advances', () => {
  it('Moving → Organizing → finish: onComplete carries path-c for both types, untouched', async () => {
    const onComplete = await mount()
    await clickText('Start with 📦 Moving →')
    await clickText('Looks good — continue')

    // Now on the Organizing confirm screen.
    const t = container.textContent || ''
    expect(t).toContain('Step 2 of 2 · Last one')
    expect(t).toContain("Here's what a new Organizing lead receives")

    await clickText('✓ Looks good — finish setup')
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ moveDefault: 'path-c', generalDefault: 'path-c' }),
    )
  })

  it('a re-run keeps the STORED location default instead of reverting to -c', async () => {
    const onComplete = await mount(vi.fn(), { ...LOCATION, default_move_drip_path: 'moving-b', default_drip_path: 'organizing-c' })
    await clickText('Start with 📦 Moving →')

    // Moving pre-selects the stored -b: its explainer + asks show.
    expect(container.textContent).toContain('your hourly rate is right there in the email')
    expect(textEls('Calendar link required').length).toBe(1)
    expect(textEls('Hourly rate required').length).toBe(1)

    await clickText('Looks good — continue')
    await clickText('✓ Looks good — finish setup')
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ moveDefault: 'path-b', generalDefault: 'path-c' }),
    )
  })
})

describe('"Change how this works" reveals the lead-phrased chooser', () => {
  it('shows all four styles with their setup cost, -c marked free', async () => {
    await mount()
    await clickText('Start with 📦 Moving →')
    await clickText('Change how this works')

    for (const lead of [LEAD_C, LEAD_D, LEAD_A, LEAD_B]) {
      expect(textEls(lead).length, lead).toBe(1)
    }
    expect(textEls('Nothing to set up').length).toBe(1)
    expect(textEls('Needs your booking link').length).toBe(1)
    expect(textEls('Needs your hourly rate').length).toBe(1)
    expect(textEls('Needs both').length).toBe(1)
  })

  it('selecting a style that needs a rate/link asks for it inline and gates continue until provided', async () => {
    await mount(vi.fn(), { ...LOCATION, calendar_link: '', rate_per_hour: '' })
    await clickText('Start with 📦 Moving →')
    await clickText('Change how this works')
    await clickText(LEAD_B)   // book on calendar + rate in email = needs both

    expect(textEls('Calendar link required').length).toBe(1)
    expect(textEls('Hourly rate required').length).toBe(1)
    const gated = textEls('Add your calendar link to continue')[0] as HTMLButtonElement
    expect(gated).toBeTruthy()
    expect(gated.disabled).toBe(true)

    const calInput = container.querySelector('input[placeholder="https://calendly.com/your-name"]') as HTMLInputElement
    const rateInput = container.querySelector('input[placeholder="$95"]') as HTMLInputElement
    await act(async () => { setNativeValue(calInput, 'https://calendly.com/bee') })
    await act(async () => { setNativeValue(rateInput, '$95') })
    expect((textEls('Looks good — continue')[0] as HTMLButtonElement).disabled).toBe(false)
  })

  it('selecting a style flips the open email to that style and updates the explainer', async () => {
    // Distinct step-1 bodies per style so the flip is observable.
    const masters = MASTERS.map(m => ({
      ...m,
      steps: masterSteps().map((s, i) => (i === 0 ? { ...s, body: `BODY-${m.path_key}` } : s)),
    }))
    vi.stubGlobal('fetch', mastersFetch(masters))
    await mount()
    await clickText('Start with 📦 Moving →')
    expect(container.textContent).toContain('BODY-moving-c')

    await clickText('Change how this works')
    await clickText(LEAD_D)
    const t = container.textContent || ''
    expect(t).toContain('BODY-moving-d')
    expect(t).not.toContain('BODY-moving-c')
    expect(t).toContain('your leads book time on your calendar (or phone you)')
  })
})

describe('step count reads from the master', () => {
  it('a 4-step moving-d shows "Four emails" while the 3-step default shows three', async () => {
    const steps4 = [0, 3, 10, 21].map((d, i) => ({
      id: `s${i + 1}`, step_order: i + 1, delay_days: d, channel: 'email',
      subject: `S${i + 1}`, body: `B${i + 1}`, is_active: true,
    }))
    const masters = MASTERS.map(m => (m.path_key === 'moving-d' ? { ...m, steps: steps4 } : m))
    vi.stubGlobal('fetch', mastersFetch(masters))
    await mount()
    await clickText('Start with 📦 Moving →')

    expect(container.textContent).toContain('Three emails, sent automatically.')
    await clickText('Change how this works')
    await clickText(LEAD_D)
    const t = container.textContent || ''
    expect(t).toContain('Four emails, sent automatically.')
    expect(t).not.toContain('Three emails, sent automatically.')
    expect(t).toContain('Email 4 · 21 days later')
  })
})

describe('"Build your own" is gone from onboarding', () => {
  it('neither the card nor the placeholder-sequence claim renders anywhere in the flow', async () => {
    await mount()
    await clickText('Start with 📦 Moving →')
    await clickText('Change how this works')
    let t = container.textContent || ''
    expect(t).not.toContain('Build your own')
    expect(t).not.toContain('placeholder welcome sequence')

    await clickText('Looks good — continue')
    await clickText('Change how this works')
    t = container.textContent || ''
    expect(t).not.toContain('Build your own')
    expect(t).not.toContain('placeholder')
  })
})

describe('preview parity — the open email rides the shared 14-variable pipeline', () => {
  it('fills rate + owner_booking_link (calendar chain) from the location, samples the rest — no raw tokens, no holes', async () => {
    await mount()
    await clickText('Start with 📦 Moving →')

    const t = container.textContent || ''
    // Real location values (buildPreviewVars: lead sample is 'John').
    expect(t).toContain('Hi John, our rate starts at $85 per hour.')
    expect(t).toContain('Book here: https://calendly.com/bee-omaha.')
    // No reviews link on the location → the labelled sample fills, the token
    // never renders raw and never collapses to an empty hole.
    expect(t).toContain('Reviews: https://g.page/bee-organized/review')
    expect(t).not.toContain('{{reviews_link}}')
  })
})

describe('typed/stored values are kept, never silently discarded', () => {
  it('the calendar link and rate pre-seed from the location and ride the Save payload', async () => {
    const onComplete = await mount()
    await clickText('Start with 📦 Moving →')
    await clickText('Change how this works')
    await clickText(LEAD_B)

    // Both asks arrive pre-filled from the location row — no re-type demanded.
    const calInput = container.querySelector('input[placeholder="https://calendly.com/your-name"]') as HTMLInputElement
    const rateInput = container.querySelector('input[placeholder="$95"]') as HTMLInputElement
    expect(calInput?.value).toBe('https://calendly.com/bee-omaha')
    expect(rateInput?.value).toBe('$85')

    await clickText('Looks good — continue')
    await clickText('✓ Looks good — finish setup')
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        moveDefault: 'path-b',
        generalDefault: 'path-c',
        calendarLink: 'https://calendly.com/bee-omaha',
        ratePerHour: '$85',
      }),
    )
  })
})

describe('intro cadence derives from the masters', () => {
  it('a 4-step 0/3/10/21 master set renders as 4 emails on that schedule — nothing hardcoded', async () => {
    const steps4 = [0, 3, 10, 21].map((d, i) => ({
      id: `s${i + 1}`, step_order: i + 1, delay_days: d, channel: 'email',
      subject: `S${i + 1}`, body: `B${i + 1}`, is_active: true,
    }))
    vi.stubGlobal('fetch', mastersFetch(MASTERS.map(m => ({ ...m, steps: steps4 }))))
    await mount()

    const t = container.textContent || ''
    expect(t).toContain('the same 4 emails')
    expect(t).toContain('Right away')
    expect(t).toContain('3 days later')
    expect(t).toContain('10 days later')
    expect(t).toContain('21 days later')
    expect(t).not.toContain('30 days later')
  })

  it('masters that stop sharing one schedule get the honest generic line, not a wrong specific claim', async () => {
    const mixed = MASTERS.map((m, i) =>
      i === 0 ? { ...m, steps: masterSteps().slice(0, 1) } : m,
    )
    vi.stubGlobal('fetch', mastersFetch(mixed))
    await mount()

    const t = container.textContent || ''
    expect(t).toContain('Each option is a short series of emails')
    expect(t).not.toContain('Every option is the same')
  })
})
