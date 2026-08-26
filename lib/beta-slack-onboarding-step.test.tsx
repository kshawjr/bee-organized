// @vitest-environment happy-dom
//
// issue 199 — the onboarding Slack step. Two halves:
//
//   1. WIRING (source sweep): the step lives in OWNER_STEPS, after 'paths' and
//      before 'invite', and is ABSENT from NON_OWNER_STEPS — so it renders for
//      owners and never for invited team members. StepContent dispatches the
//      wizard for step.id==='slack'.
//   2. BEHAVIOR (mount SlackOnboardingStep): intro → team question → the
//      three-task checklist (Continue gated until all three are ticked AND the
//      public/private question is answered) → connect (amber instructions
//      branch on that answer; the button hits /api/slack/connect with the
//      right location_id) → connected (shows the ACTUAL stored channel name,
//      and PROVES the pipe with a test message through the same
//      /api/locations/[id]/slack-test route the SlackCard uses, instead of
//      asserting success). The "Skip for now" link advances via onComplete
//      without ever connecting.
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

// Tick all three tasks on the checklist (visibility deliberately NOT chosen).
const tickAllThree = async () => {
  await clickText('1. Open your Slack workspace')
  await clickText('2. Invite your team — and add this address')
  await clickText('3. Create a channel called “leads”')
}

describe('the checklist gates Continue on three ticks AND a visibility answer', () => {
  it('holds through the ticks, then holds again until public/private is chosen', async () => {
    await mount()
    await toChecklist(true)

    // Gated: the label reads the "tick all three" state and is disabled.
    expect(btn('Tick all three to continue')).toBeTruthy()
    expect(btn('Tick all three to continue').disabled).toBe(true)

    // Tick tasks one at a time by their titles; still gated after the first two.
    await clickText('1. Open your Slack workspace')
    await clickText('2. Invite your team — and add this address')
    expect(btn('Tick all three to continue').disabled).toBe(true)

    // Third tick: the gate now asks for the visibility answer, still disabled.
    await clickText('3. Create a channel called “leads”')
    expect(btn('Choose public or private')).toBeTruthy()
    expect(btn('Choose public or private').disabled).toBe(true)

    // Answering the question unlocks Continue.
    await clickText('Public — it shows a # icon')
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

  it('task 3 no longer requires public, and no copy claims private channels are hidden', async () => {
    await mount()
    await toChecklist(true)
    // The old title demanded a PUBLIC channel; the new one does not.
    expect(textEls('3. Create a channel called “leads”')[0]).toBeTruthy()
    expect(textEls('3. Create a public channel called “leads”').length).toBe(0)
    // The old helper claimed "your leads" would post to the channel (Bee Hub
    // posts, not the leads) — gone with the rewrite.
    expect(container.textContent).not.toContain('so your leads can post there')
  })
})

// Walk to the connect screen with a chosen visibility.
const toConnect = async (vis: 'public' | 'private') => {
  await toChecklist(true)
  await tickAllThree()
  await clickText(vis === 'public' ? 'Public — it shows a # icon' : 'Private — it shows a padlock')
  await clickText('Continue →')
}

describe('the connect screen instructions branch on the visibility answer', () => {
  it('public: icon-check guidance, and no /invite command', async () => {
    await mount()
    await toConnect('public')
    const text = container.textContent || ''
    expect(text).toContain('# means public')
    expect(text).toContain('padlock')
    expect(text).not.toContain('/invite @Bee Hub Notifications')
  })

  it('private: numbered pick-then-invite steps with the command as a copy row', async () => {
    await mount()
    await toConnect('private')
    const text = container.textContent || ''
    expect(text).toContain('invitation-only')
    expect(text).toContain('applies to apps')
    expect(textEls('/invite @Bee Hub Notifications')[0]).toBeTruthy()
    // Slack's own guide to apps, in a new tab.
    const appsLink = Array.from(container.querySelectorAll('a')).find(a =>
      (a as HTMLAnchorElement).href.includes('360001537467'),
    ) as HTMLAnchorElement
    expect(appsLink).toBeTruthy()
    expect(appsLink.target).toBe('_blank')
  })

  // One path per test — re-rendering the same component in one test would
  // carry the wizard's screen state across and never restart at the intro.
  it('the public path keeps the unchanged permissions box', async () => {
    await mount()
    await toConnect('public')
    expect(container.textContent).toContain('read your other channels or messages')
  })

  it('the private path keeps the unchanged permissions box', async () => {
    await mount()
    await toConnect('private')
    expect(container.textContent).toContain('read your other channels or messages')
  })
})

describe('the checklist links to real Slack help pages in a new tab', () => {
  it('create-a-channel and what-is-a-channel are both present', async () => {
    await mount()
    await toChecklist(true)
    const hrefs = Array.from(container.querySelectorAll('a')).map(a => (a as HTMLAnchorElement).href)
    expect(hrefs.some(h => h.includes('201402297'))).toBe(true)
    expect(hrefs.some(h => h.includes('360017938993'))).toBe(true)
    Array.from(container.querySelectorAll('a'))
      .filter(a => (a as HTMLAnchorElement).href.includes('slack.com/help'))
      .forEach(a => expect((a as HTMLAnchorElement).target).toBe('_blank'))
  })
})

describe('the connect button hits /api/slack/connect with the right location_id', () => {
  it('redirects to the connect route carrying the location UUID', async () => {
    await mount(vi.fn(), { id: LOC_UUID })
    await toConnect('public')
    await clickText('Add to Slack')         // full-page redirect
    expect(hrefValue).toBe('/api/slack/connect?location_id=' + encodeURIComponent(LOC_UUID))
  })
})

describe('the connected screen shows the real stored channel and never asserts success', () => {
  it('seeds from slack_connected and shows the actual channel name, not "#leads"', async () => {
    const onComplete = await mount(vi.fn(), {
      id: LOC_UUID,
      slack_connected: true,
      slack_channel_name: 'weekly-leads',   // NOT the suggested "leads"
    })
    expect(textEls('Connected to #weekly-leads')[0]).toBeTruthy()
    // Shows the stored channel, hashed, rather than assuming "#leads".
    const done = container.textContent || ''
    expect(done).toContain('#weekly-leads')
    expect(done).not.toContain('#leads')
    // The old blanket promise is gone — the screen asks for a test instead.
    expect(done).not.toContain('Slack is connected!')
    expect(done).not.toContain('the moment they come in')
    expect(btn('Send test message')).toBeTruthy()
    // Continue completes the step.
    await clickText('Continue →')
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('falls back to a plain phrase when the stored channel name is blank', async () => {
    await mount(vi.fn(), { id: LOC_UUID, slack_connected: true, slack_channel_name: '' })
    expect(textEls('Connected to your channel')[0]).toBeTruthy()
  })
})

describe('the connected screen proves the pipe with the SlackCard test route', () => {
  const mountConnected = () =>
    mount(vi.fn(), { id: LOC_UUID, slack_connected: true, slack_channel_name: 'leads-two' })

  it('the button POSTs the same /slack-test route the card uses, and success says go look', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, message: 'Test message sent to #leads-two — go check Slack.' }),
    })))
    await mountConnected()
    await clickText('Send test message')

    const calls = (globalThis.fetch as any).mock.calls
    expect(calls.length).toBe(1)
    expect(calls[0][0]).toBe('/api/locations/' + encodeURIComponent(LOC_UUID) + '/slack-test')
    expect(calls[0][1]).toEqual({ method: 'POST' })

    const text = container.textContent || ''
    expect(text).toContain('Test sent!')
    expect(text).toContain('Open Slack')
    expect(text).toContain('#leads-two')
  })

  it('a failed test shows the /invite fix, the support address, and a retry — no raw codes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: 'The test didn’t arrive: Slack refused the message (some_slack_code). Try Reconnect; if it keeps failing, contact support.' }),
    })))
    await mountConnected()
    await clickText('Send test message')

    const text = container.textContent || ''
    expect(text).toContain('couldn’t post to #leads-two')
    expect(textEls('/invite @Bee Hub Notifications')[0]).toBeTruthy()
    expect(text).toContain('admin@beeorganized.com')
    expect(text).not.toContain('some_slack_code')
    // The same button is the retry, and Continue is still reachable — the step
    // simply stays incomplete if the owner leaves without pressing it.
    expect(btn('Send test message')).toBeTruthy()
    expect(btn('Continue →')).toBeTruthy()
  })
})

describe('the false private-channels-are-hidden claim is gone from the source', () => {
  it('no code claims a private channel won’t appear in Slack’s picker', () => {
    const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
    expect(src).not.toContain("won't show up in that list")
    expect(src).not.toContain('which is why we made it public')
  })
})
