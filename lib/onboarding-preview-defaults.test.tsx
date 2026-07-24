// @vitest-environment happy-dom
//
// Onboarding wizard — preview-open-by-default, preview parity, kept values,
// and master-derived intro cadence. MOUNT test of OnboardingPathsEditor.
//
//   1. Entering a chooser screen auto-expands the first style's emails (no ▼
//      hunt), and selecting a style flips the open preview to it — the "real
//      email text visible" half of confirm-not-choose.
//   2. The 👁 peek rides the SAME 14-variable pipeline as Settings →
//      Communications (lib/preview-vars → RenderedTemplatePreview): real
//      location values fill in ({{rate_per_hour}}, {{owner_booking_link}} via
//      the calendar-link chain), anything unknown gets the labelled sample —
//      never a raw {{token}}, never an empty hole.
//   3. The calendar link pre-seeds from the location (mirroring the rate), so
//      a re-run never demands a re-type, and the Save payload carries it.
//   4. The intro schedule is read from the masters — a 4-step 0/3/10/21
//      master set renders as "4 emails" on that cadence, not a hardcoded 3.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { OnboardingPathsEditor, CurrentLocationContext } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const PATH_B = 'Booking link · rate included'
const PATH_C = 'Reply to schedule · rate on the call'

const LOCATION = {
  id: 'loc-uuid-1',
  name: 'Bee Organized Omaha',
  calendar_link: 'https://calendly.com/bee-omaha',
  rate_per_hour: '$85',
  city: 'Omaha',
  state: 'NE',
}

// Token-bearing master content: the peek must resolve what the location knows
// and fill {{reviews_link}} with the labelled sample (LOCATION has none).
const masterSteps = () => [
  { id: 's1', step_order: 1, delay_days: 0, channel: 'email', subject: 'Welcome to {{location_name}}', body: 'Hi {{first_name}}, our rate starts at {{rate_per_hour}} per hour. Book here: {{owner_booking_link}}. Reviews: {{reviews_link}}', is_active: true },
  { id: 's2', step_order: 2, delay_days: 5, channel: 'email', subject: 'Following up', body: 'Just checking in, {{first_name}}.', is_active: true },
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

const mount = async (onComplete = vi.fn()) => {
  await act(async () => {
    root.render(
      <CurrentLocationContext.Provider value={LOCATION as any}>
        <OnboardingPathsEditor onComplete={onComplete} />
      </CurrentLocationContext.Provider>,
    )
  })
  await act(async () => {})   // masters fetch
  return onComplete
}

describe('preview open by default', () => {
  it('entering the Moving screen auto-expands the first style — master subjects visible with zero clicks', async () => {
    await mount()
    await clickText('Start with 📦 Moving →')

    // One card is already open (its toggle reads ▲ Hide), and the step rows
    // render the substituted subject line.
    expect(textEls('▲ Hide').length).toBe(1)
    expect(container.textContent).toContain('Welcome to Bee Organized Omaha')
    expect(container.textContent).not.toContain('Welcome to {{location_name}}')
  })

  it('selecting a style flips the open preview to that style', async () => {
    await mount()
    await clickText('Start with 📦 Moving →')
    await clickText(PATH_C)

    // path-c's explainer is now the visible panel.
    expect(container.textContent).toContain('No rate, no links. Friendly and low pressure.')
    expect(textEls('▲ Hide').length).toBe(1)
  })
})

describe('peek modal rides the shared 14-variable pipeline', () => {
  it('fills rate + owner_booking_link (calendar chain) from the location, samples the rest — no raw tokens, no holes', async () => {
    await mount()
    await clickText('Start with 📦 Moving →')
    await clickText('👁 Preview')   // step 1 of the auto-opened card

    const t = container.textContent || ''
    // Real location values (buildPreviewVars: lead sample is 'John').
    expect(t).toContain('Hi John, our rate starts at $85 per hour.')
    expect(t).toContain('Book here: https://calendly.com/bee-omaha.')
    // No reviews link on the location → the labelled sample fills, the token
    // never renders raw and never collapses to an empty hole.
    expect(t).toContain('Reviews: https://g.page/bee-organized/review')
    expect(t).not.toContain('{{reviews_link}}')
    expect(t).toContain('variables filled the way a real send fills them')
  })
})

describe('typed/stored values are kept, never silently discarded', () => {
  it('the calendar link pre-seeds from the location and rides the Save payload', async () => {
    const onComplete = await mount()
    await clickText('Start with 📦 Moving →')
    await clickText(PATH_C)
    await clickText('Next: 🏠 Organizing projects →')
    await clickText(PATH_B)
    await clickText('Review my choices →')

    // Both asks arrive pre-filled from the location row — no re-type demanded.
    const calInput = container.querySelector('input[placeholder="https://calendly.com/your-name"]') as HTMLInputElement
    const rateInput = container.querySelector('input[placeholder="$95"]') as HTMLInputElement
    expect(calInput?.value).toBe('https://calendly.com/bee-omaha')
    expect(rateInput?.value).toBe('$85')

    await clickText('✓ Save & Complete')
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
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
