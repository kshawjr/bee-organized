// @vitest-environment happy-dom
//
// issue 199 — the onboarding Slack step. Two halves:
//
//   1. WIRING (source sweep): the step lives in OWNER_STEPS, after 'paths' and
//      before 'invite', and is ABSENT from NON_OWNER_STEPS — so it renders for
//      owners and never for invited team members. StepContent dispatches the
//      wizard for step.id==='slack'.
//   2. BEHAVIOR (mount SlackOnboardingStep): intro → team question → the
//      three-task checklist (Continue gated until all three are ticked) →
//      connect (the button hits /api/slack/connect with the right location_id)
//      → done (a connected location shows the ACTUAL stored channel name). The
//      "Skip for now" link advances via onComplete without ever connecting.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SlackOnboardingStep, CurrentLocationContext } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ── 1. WIRING — owner-only placement, proven off the source ──────────────────
describe('the Slack step is owner-only and sits after paths, before invite', () => {
  const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

  const arrayBody = (name: string) => {
    const start = src.indexOf(`const ${name} = [`)
    expect(start, `${name} declaration`).toBeGreaterThan(-1)
    return src.slice(start, src.indexOf(']', start))
  }

  it("OWNER_STEPS orders slack immediately after paths and before invite", () => {
    const owner = arrayBody('OWNER_STEPS')
    const iPaths  = owner.indexOf("id:'paths'")
    const iSlack  = owner.indexOf("id:'slack'")
    const iInvite = owner.indexOf("id:'invite'")
    expect(iPaths).toBeGreaterThan(-1)
    expect(iSlack).toBeGreaterThan(-1)
    expect(iInvite).toBeGreaterThan(-1)
    expect(iPaths).toBeLessThan(iSlack)
    expect(iSlack).toBeLessThan(iInvite)
  })

  it('NON_OWNER_STEPS never includes the slack step', () => {
    expect(arrayBody('NON_OWNER_STEPS').includes("id:'slack'")).toBe(false)
  })

  it('StepContent dispatches SlackOnboardingStep for the slack step', () => {
    expect(src).toMatch(/step\.id==='slack'/)
    expect(src).toMatch(/<SlackOnboardingStep\s+onComplete=/)
  })
})

// ── 2. BEHAVIOR — mount the wizard ───────────────────────────────────────────
const LOC_UUID = '11112222-3333-4444-8555-666677778888'

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let hrefValue: string

beforeEach(() => {
  // Capture the connect redirect without navigating happy-dom.
  hrefValue = ''
  Object.defineProperty(window.location, 'href', {
    configurable: true,
    get: () => hrefValue,
    set: (v: string) => { hrefValue = v },
  })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
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
  Array.from(container.querySelectorAll('p, button, span, a, code')).filter(
    el => el.textContent?.trim() === t,
  )

const clickText = async (t: string) => {
  const el = textEls(t)[0]
  expect(el, `element with text "${t}"`).toBeTruthy()
  await act(async () => { (el as HTMLElement).click() })
}

const btn = (t: string) => textEls(t)[0] as HTMLButtonElement

const mount = async (onComplete = vi.fn(), location: any = { id: LOC_UUID }) => {
  await act(async () => {
    root.render(
      <CurrentLocationContext.Provider value={location as any}>
        <SlackOnboardingStep onComplete={onComplete} />
      </CurrentLocationContext.Provider>,
    )
  })
  return onComplete
}

// Walk intro → team (answer) → checklist.
const toChecklist = async (usesSlack = true) => {
  await clickText('Get started →')
  await clickText(usesSlack ? 'Yes, we use Slack' : "Not yet — we'll set it up")
  await clickText('Continue →')
}

describe('the wizard opens on the intro and can be skipped without connecting', () => {
  it('an unconnected location starts at the intro', async () => {
    await mount()
    expect(textEls('💬 See new leads in Slack')[0]).toBeTruthy()
    expect(btn('Get started →')).toBeTruthy()
    expect(btn('Skip for now')).toBeTruthy()
  })

  it('"Skip for now" advances via onComplete and never connects', async () => {
    const onComplete = await mount()
    await clickText('Skip for now')
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(hrefValue).toBe('')   // no redirect to /api/slack/connect
    expect((globalThis.fetch as any).mock.calls.length).toBe(0)
  })
})

describe('the checklist gates Continue until all three tasks are ticked', () => {
  it('Continue is blocked until workspace, invite, and channel are all ticked', async () => {
    await mount()
    await toChecklist(true)

    // Gated: the label reads the "tick all three" state and is disabled.
    expect(btn('Tick all three to continue')).toBeTruthy()
    expect(btn('Tick all three to continue').disabled).toBe(true)

    // Tick tasks one at a time by their titles; still gated after the first two.
    await clickText('1. Open your Slack workspace')
    await clickText('2. Invite your team — and add this address')
    expect(btn('Tick all three to continue').disabled).toBe(true)

    // The third tick unlocks Continue.
    await clickText('3. Create a public channel called “leads”')
    expect(btn('Continue →')).toBeTruthy()
    expect(btn('Continue →').disabled).toBe(false)
  })

  it('the first task wording adapts to the team answer (create vs open)', async () => {
    await mount()
    await toChecklist(false)   // "not yet" → creating a workspace
    expect(textEls('1. Create your Slack workspace')[0]).toBeTruthy()
  })

  it('surfaces the corporate address and the leads channel as copy fields', async () => {
    await mount()
    await toChecklist(true)
    expect(textEls('admin@beeorganized.com')[0]).toBeTruthy()
    expect(textEls('leads')[0]).toBeTruthy()
  })
})

describe('the connect button hits /api/slack/connect with the right location_id', () => {
  it('redirects to the connect route carrying the location UUID', async () => {
    await mount(vi.fn(), { id: LOC_UUID })
    await toChecklist(true)
    await clickText('1. Open your Slack workspace')
    await clickText('2. Invite your team — and add this address')
    await clickText('3. Create a public channel called “leads”')
    await clickText('Continue →')          // → connect screen
    await clickText('Add to Slack')         // full-page redirect
    expect(hrefValue).toBe('/api/slack/connect?location_id=' + encodeURIComponent(LOC_UUID))
  })
})

describe('a connected location lands on done and shows the real stored channel', () => {
  it('seeds the done screen from slack_connected and shows the actual channel name', async () => {
    const onComplete = await mount(vi.fn(), {
      id: LOC_UUID,
      slack_connected: true,
      slack_channel_name: 'weekly-leads',   // NOT the suggested "leads"
    })
    expect(textEls('Slack is connected!')[0]).toBeTruthy()
    // Shows the stored channel, hashed, rather than assuming "#leads".
    const done = container.textContent || ''
    expect(done).toContain('#weekly-leads')
    expect(done).not.toContain('#leads')
    // Continue completes the step.
    await clickText('Continue →')
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('falls back to a plain phrase when the stored channel name is blank', async () => {
    await mount(vi.fn(), { id: LOC_UUID, slack_connected: true, slack_channel_name: '' })
    expect(textEls('Slack is connected!')[0]).toBeTruthy()
    expect((container.textContent || '')).toContain('your channel')
  })
})
