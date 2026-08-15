// @vitest-environment happy-dom
//
// Issue 240 step 6 — Texts & scripts.
//
// Texts are a PREVIEW, not a feature. Greying them disables nothing, and the
// evidence for that is worth keeping next to the test rather than in a commit
// message, because the day someone wires SMS up they will need to know which
// of these assertions is now wrong:
//   • no SMS provider in package.json, no SMS/Twilio env var in the code
//   • lib/drip-send.ts advances past any step whose channel is not 'email'
//   • production drip_path_steps: 77 rows, all channel='email'
//   • production templates of type 'sms': 3 rows, all is_active=false
//     (quarantined Gen 1 t5/t6/t7)
//   • no sms_enabled column exists, so the flag gating the old locked
//     accordion could never become true
//
// Pinned:
//   1) the texts block renders NOTHING interactive
//   2) the badge states a fact about today, not a roadmap promise
//   3) call scripts are still editable, and say they are not sent
//   4) controls are capped
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen, CurrentUserContext, TextsComingSoon } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const currentUser = {
  id: '9a8b7c6d-1111-4222-8333-444455556666',
  email: 'user@bee.test', name: 'Riley Park', role: 'franchise',
  locationId: 'loc-uuid-1', first_name: 'Riley', last_name: 'Park',
  phone: '(206) 555-0100', booking_link: null,
}

let container: HTMLElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const mountTab = async () => {
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={currentUser}>
        <SettingsScreen initialSection="texts" franchiseRole="owner" />
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => {})
  return container
}

const mountTexts = async () => {
  await act(async () => { root.render(<TextsComingSoon />) })
  await act(async () => {})
  return container
}

// Everything a user could click, type into, or tab to.
const INTERACTIVE = 'button, input, select, textarea, a[href], [role="button"], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

describe('the texts block is inert', () => {
  it('renders nothing interactive at all', async () => {
    await mountTexts()
    const found = Array.from(container.querySelectorAll(INTERACTIVE))
    expect(found.map(n => n.tagName.toLowerCase())).toEqual([])
  })

  it('has no on switch — nothing checkable and nothing named like a toggle', async () => {
    await mountTexts()
    expect(container.querySelectorAll('input[type="checkbox"], input[type="radio"]').length).toBe(0)
    const text = (container.textContent ?? '').toLowerCase()
    for (const word of ['enable', 'turn on', 'activate', 'buy', 'add-on needed', 'upgrade']) {
      expect(text, `must not offer to "${word}"`).not.toContain(word)
    }
  })

  it('badges the block with what is true today, not a roadmap claim', async () => {
    await mountTexts()
    expect(container.textContent).toContain('Not sending yet')
    // "Coming soon" promises a future this screen cannot verify.
    expect(container.textContent).not.toContain('Coming soon')
  })

  it('still shows the owner what the message will say', async () => {
    await mountTexts()
    // The point of the block: readable copy, not a configurable thing.
    expect(container.textContent).toContain('thanks for reaching out')
    expect(container.textContent).toMatch(/about \d+ characters/)
  })

  it('says plainly that nothing sends yet', async () => {
    await mountTexts()
    expect(container.textContent).toContain('Nothing sends today')
  })
})

describe('the tab as a whole', () => {
  it('shows texts before call scripts', async () => {
    const text = (await mountTab()).textContent ?? ''
    expect(text).toContain('Text messages')
    expect(text).toContain('Call Scripts')
    expect(text.indexOf('Text messages')).toBeLessThan(text.indexOf('Call Scripts'))
  })

  it('no longer renders the locked Text Templates accordion', async () => {
    const text = (await mountTab()).textContent ?? ''
    // It was an empty accordion behind a chip that could never be earned.
    expect(text).not.toContain('Text Templates')
    expect(text).not.toContain('Add-on needed')
  })

  it('says call scripts are not sent to anyone', async () => {
    expect((await mountTab()).textContent).toContain('nothing here is sent to anyone')
  })

  it('call scripts remain editable — the create affordance is present', async () => {
    await mountTab()
    const buttons = Array.from(container.querySelectorAll('button')).map(b => b.textContent ?? '')
    // The section is collapsed by default, so open it first.
    const header = Array.from(container.querySelectorAll('p')).find(p => p.textContent?.includes('Call Scripts'))
    expect(header, 'the Call Scripts section header').toBeTruthy()
    await act(async () => { (header!.closest('div[style]') as HTMLElement).click() })
    const after = Array.from(container.querySelectorAll('button')).map(b => b.textContent ?? '')
    expect(after.some(t => t.includes('Create Template'))).toBe(true)
    expect(after.length).toBeGreaterThan(buttons.length)
  })
})

describe('controls are capped', () => {
  const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

  it('the create button carries the shared action cap', async () => {
    await mountTab()
    const header = Array.from(container.querySelectorAll('p')).find(p => p.textContent?.includes('Call Scripts'))
    await act(async () => { (header!.closest('div[style]') as HTMLElement).click() })
    const create = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Create Template')) as HTMLElement
    expect(create, 'the create button').toBeTruthy()
    expect(create.style.maxWidth).toMatch(/^\d+px$/)
  })

  it('the texts preview caps its own width rather than filling the page', async () => {
    await mountTexts()
    const card = container.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(card, 'the preview card').toBeTruthy()
    expect(card.style.maxWidth).toMatch(/^\d+px$/)
  })

  it('CONTROL_W is still the single source of the caps', () => {
    // Step 6 adds no competing width system.
    expect(beehub).toContain('const CONTROL_W = {')
    expect(beehub.match(/const CONTROL_W = \{/g)?.length).toBe(1)
  })
})

describe('an unreachable sms template cannot be created', () => {
  // Step 6 removes the Text Templates accordion, which was the only place an
  // sms row rendered. The editor's type picker offered SMS unconditionally and
  // POST /api/templates has no add-on gate, so an owner could reach the
  // UNLOCKED Call Scripts section, hit Create Template, choose SMS, and save a
  // row that would now render nowhere at all.
  const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

  it('the type picker filters SMS out unless smsEnabled', () => {
    expect(beehub).toContain(".filter(([v])=> v!=='sms' || settings?.location?.smsEnabled)")
  })

  it('smsEnabled has no writer, so that filter is permanent today', () => {
    // If someone later adds a real add-on flow this should fail and be
    // revisited — that is the point of pinning it. Deliberately NOT asserting
    // the absence of the string 'sms_enabled': the comments explaining why the
    // column does not exist contain it, so that assertion would test the prose
    // rather than the code.
    expect(beehub).not.toContain("updateLocation('smsEnabled'")
    // No hydration branch reads a column into the flag either.
    expect(beehub).not.toMatch(/smsEnabled:\s*\w+\.sms_enabled/)
  })
})
