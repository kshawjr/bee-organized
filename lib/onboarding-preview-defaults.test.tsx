// @vitest-environment happy-dom
//
// issue 194 — onboarding new-lead-emails wizard: PREVIEW + RECAP + cadence.
// MOUNT tests of OnboardingPathsEditor.
//
//   1. After the two questions, the preview shows the real master emails: the
//      first rendered in full through the shared 14-variable pipeline, the rest
//      collapsed to timing + subject.
//   2. A recap line reads the two answers back in plain words, with a "Change"
//      link that jumps to question 1.
//   3. Preview parity: the open email fills real location values and samples
//      the unknowns — never a raw {{token}}.
//   4. The intro cadence is read from the masters that actually send, never a
//      hardcoded count/schedule.
//   5. No path letter, no "drip", no "Build your own" anywhere in the flow.
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

const LOCATION = {
  id: 'loc-uuid-1',
  name: 'Bee Organized Omaha',
  calendar_link: 'https://calendly.com/bee-omaha',
  rate_per_hour: '$85',
  city: 'Omaha',
  state: 'NE',
}

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

// intro → book (reply) → rate (on call) → preview: the -c pair, nothing to type.
const toPreview = async (booking = REPLY, rate = RATE_ON_CALL) => {
  await clickText('Get started →')
  await clickText(booking)
  await clickText('Continue →')
  await clickText(rate)
  await clickText('See my emails →')
}

describe('the preview shows the real master emails', () => {
  it('email 1 renders in full, the rest collapse to timing + subject', async () => {
    await mount()
    await toPreview()

    const t = container.textContent || ''
    expect(t).toContain("Here's what a new Organizing lead receives")
    expect(t).toContain('Three emails, sent automatically. You can change any of this later.')
    // Email 1 open: substituted subject AND body without a click.
    expect(t).toContain('Welcome to Bee Organized Omaha')
    expect(t).toContain('Hi John, our rate starts at $85 per hour.')
    expect(t).not.toContain('Welcome to {{location_name}}')
    // Emails 2 and 3 collapsed: timing + one-line summary only.
    expect(t).toContain('Email 2 · 5 days later')
    expect(t).toContain('Following up')
    expect(t).toContain('Email 3 · 30 days later')
    expect(t).not.toContain('Just checking in, John.')
  })

  it('never shows a path letter, "drip", or "Build your own"', async () => {
    await mount()
    await toPreview()
    const t = container.textContent || ''
    expect(t).not.toMatch(/Path [A-D]/i)
    expect(t.toLowerCase()).not.toContain('drip')
    expect(t).not.toContain('Build your own')
  })
})

describe('the recap reads the two answers back, with a Change link to question 1', () => {
  it('reply + rate on the call → the "most owners start here" recap', async () => {
    await mount()
    await toPreview(REPLY, RATE_ON_CALL)
    const t = container.textContent || ''
    expect(t).toContain('New leads reply to you to schedule, and pricing waits for the call.')
    expect(t).toContain('Most owners start here.')
  })

  it('the Change link returns to question 1 with the answers intact', async () => {
    await mount()
    await toPreview(ONLINE, RATE_ON_CALL)
    // On the preview; Change jumps back to question 1.
    await clickText('Change')
    expect(container.textContent).toContain('How should new leads book with you?')
    // The booking-link field is still there, prefilled from the location.
    const cal = container.querySelector('input[placeholder="https://calendly.com/your-name"]') as HTMLInputElement
    expect(cal?.value).toBe('https://calendly.com/bee-omaha')
  })
})

describe('preview parity — the open email rides the shared 14-variable pipeline', () => {
  it('fills rate + booking link from the location, samples the rest, no raw tokens', async () => {
    await mount()
    await toPreview()
    const t = container.textContent || ''
    expect(t).toContain('Hi John, our rate starts at $85 per hour.')
    expect(t).toContain('Book here: https://calendly.com/bee-omaha.')
    // No reviews link on the location → the labelled sample fills the hole.
    expect(t).toContain('Reviews: https://g.page/bee-organized/review')
    expect(t).not.toContain('{{reviews_link}}')
  })
})

describe('the intro cadence derives from the masters', () => {
  // issue 314 — RETARGETED, not removed. The live half of this test is that the
  // cadence is DERIVED from the master steps rather than hardcoded, and that is
  // untouched. Only the trailing "+ the 24h Welcome" clause went away with the
  // email itself, so that assertion is inverted: onboarding must no longer
  // promise a send that can never arrive. Leaving it as a positive would have
  // been a test asserting a lie to a brand-new owner.
  it('a 3-step 0/5/30 master set describes three emails on that schedule, and no Welcome', async () => {
    await mount()
    const t = container.textContent || ''
    expect(t).toContain('the same 3 emails')
    expect(t).toContain('Right away')
    expect(t).toContain('5 days later')
    expect(t).toContain('30 days later')
    expect(t).not.toMatch(/Welcome Email/)
    expect(t).not.toMatch(/24 hours after/)
  })

  it('a 4-step 0/3/10/21 master set renders four emails on that schedule — nothing hardcoded', async () => {
    const steps4 = [0, 3, 10, 21].map((d, i) => ({
      id: `s${i + 1}`, step_order: i + 1, delay_days: d, channel: 'email',
      subject: `S${i + 1}`, body: `B${i + 1}`, is_active: true,
    }))
    vi.stubGlobal('fetch', mastersFetch(MASTERS.map(m => ({ ...m, steps: steps4 }))))
    await mount()
    const t = container.textContent || ''
    expect(t).toContain('the same 4 emails')
    expect(t).toContain('21 days later')
    expect(t).not.toContain('30 days later')
  })

  it('masters that stop sharing one schedule get the honest generic line', async () => {
    const mixed = MASTERS.map((m, i) => (i === 0 ? { ...m, steps: masterSteps().slice(0, 1) } : m))
    vi.stubGlobal('fetch', mastersFetch(mixed))
    await mount()
    const t = container.textContent || ''
    expect(t).toContain('Each option is a short series of emails')
    expect(t).not.toContain('Every option is the same')
  })
})

describe('the preview step count reads from the master', () => {
  it('a 4-step organizing master shows "Four emails" on the preview', async () => {
    const steps4 = [0, 3, 10, 21].map((d, i) => ({
      id: `s${i + 1}`, step_order: i + 1, delay_days: d, channel: 'email',
      subject: `S${i + 1}`, body: `B${i + 1}`, is_active: true,
    }))
    const masters = MASTERS.map(m => (m.path_key.startsWith('organizing-') ? { ...m, steps: steps4 } : m))
    vi.stubGlobal('fetch', mastersFetch(masters))
    await mount()
    await toPreview()
    const t = container.textContent || ''
    expect(t).toContain('Four emails, sent automatically.')
    expect(t).toContain('Email 4 · 21 days later')
  })
})
