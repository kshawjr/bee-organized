// @vitest-environment happy-dom
//
// Issue 240 step 4 — Communication + Templates became Emails / Your team /
// Texts & scripts. This is the SHELL step: the same surfaces, re-addressed.
//
// Mount tests rather than source pins, for the reason the sibling suite gives:
// a source pin passes as long as the string exists somewhere in a 35k-line
// file, which is exactly how the lite_user leak survived. What matters here is
// that each tab actually renders its content, so each test mounts and reads
// the DOM.
//
// Pinned:
//   1) all three tabs exist for an owner and render their own heading
//   2) each moved surface is still REACHABLE — the sending identity, the
//      notification recipients, Slack, the sequences, and all three template
//      types are on exactly one tab each, and none were dropped in the move
//   3) old deep links (?section=paths, ?section=templates) still resolve
//      instead of hitting the "you don't have access" guard
//   4) the retired keys from step 1 still fall through to that guard — they
//      were deleted, not moved, and must not silently land somewhere
//   5) CONTROLS do not stretch: the tab pills are a fixed width, not flex:1
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { SettingsScreen, CurrentUserContext } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const currentUser = {
  id: '9a8b7c6d-1111-4222-8333-444455556666',
  email: 'user@bee.test',
  name: 'Riley Park',
  role: 'franchise',
  locationId: 'loc-uuid-1',
  first_name: 'Riley',
  last_name: 'Park',
  phone: '(206) 555-0100',
  booking_link: null,
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

// Each mount gets a FRESH root. SettingsScreen seeds activeSection with
// useState(resolveSettingsSection(initialSection)) and — unlike the admin
// screen, which syncs via useEffect — never re-reads the prop. Re-rendering
// the same root with a new initialSection therefore keeps showing the first
// section, and assertions would silently pass against stale DOM.
const mount = async (initialSection: string) => {
  await act(async () => root.unmount())
  container.remove()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={currentUser}>
        <SettingsScreen initialSection={initialSection} franchiseRole="owner" />
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => {})   // flush mount-time fetches
  return bodyText()
}

// Text of the section BODY only. Every tab label also appears in the header
// strip and the mobile <select>, so asserting on container.textContent would
// pass for "Texts & scripts" while showing the Emails body.
const bodyText = () => {
  const clone = container.cloneNode(true) as HTMLElement
  clone.querySelectorAll('.bee-tab-pills, .bee-tab-select, h1').forEach(n => n.remove())
  return clone.textContent ?? ''
}

const sectionKeys = (): string[] => {
  const select = container.querySelector('select[aria-label="Settings section"]')
  return Array.from(select!.querySelectorAll('option')).map(o => (o as HTMLOptionElement).value)
}

const NO_ACCESS = "You don't have access to this section"

describe('the three tabs exist and render', () => {
  it('an owner is offered emails, yourteam and texts', async () => {
    await mount('profile')
    const keys = sectionKeys()
    expect(keys).toContain('emails')
    expect(keys).toContain('yourteam')
    expect(keys).toContain('texts')
    // The two they replaced are gone from the strip (they survive only as
    // deep-link aliases, asserted below).
    expect(keys).not.toContain('paths')
    expect(keys).not.toContain('templates')
  })

  it('each tab renders its own body, not a blank frame', async () => {
    // The subtitle, not the <h1> — bodyText() strips headings precisely
    // because every tab name also appears in the nav strip.
    expect(await mount('emails')).toContain('What a client receives automatically')
    expect(await mount('yourteam')).toContain('Who your emails come from')
    expect(await mount('texts')).toContain('Text messaging needs the add-on')
  })

  it('no tab lands on the no-access guard', async () => {
    for (const key of ['emails', 'yourteam', 'texts']) {
      expect(await mount(key), `section='${key}'`).not.toContain(NO_ACCESS)
    }
  })
})

describe('nothing that worked before is unreachable', () => {
  it('Your team still carries sending identity, recipients and Slack', async () => {
    const text = await mount('yourteam')
    expect(text).toContain('Sending identity')
    expect(text).toContain('Send From Name')
    expect(text).toContain('Reply-To Email')
    expect(text).toContain('Who hears about new leads')
    expect(text).toContain('Slack notifications')
  })

  it('Emails still carries both project-type sequences', async () => {
    const text = await mount('emails')
    expect(text).toContain('New lead emails')
    expect(text).toContain('Moving projects')
    expect(text).toContain('Organizing projects')
  })

  it('Emails owns the email templates and Texts & scripts owns the other two', async () => {
    const emails = await mount('emails')
    expect(emails).toContain('Email Templates')
    // The other two types must NOT also appear here — that would mean the
    // renderer was handed every section instead of its slice.
    expect(emails).not.toContain('Text Templates')
    expect(emails).not.toContain('Call Scripts')

    const texts = await mount('texts')
    expect(texts).toContain('Text Templates')
    expect(texts).toContain('Call Scripts')
    expect(texts).not.toContain('Email Templates')
  })
})

describe('deep links to the old sections still resolve', () => {
  it('?section=paths lands on Emails, not the no-access guard', async () => {
    const text = await mount('paths')
    expect(text).not.toContain(NO_ACCESS)
    expect(text).toContain('New lead emails')
  })

  it('?section=templates lands on Emails too', async () => {
    const text = await mount('templates')
    expect(text).not.toContain(NO_ACCESS)
    expect(text).toContain('Email Templates')
  })

  it('?section=billing still lands on Team & Billing (the older alias survives)', async () => {
    expect(await mount('billing')).not.toContain(NO_ACCESS)
  })

  it('the step-1 retirements still hit the guard — deleted is not moved', async () => {
    // automation and notifs were removed outright, so they get the honest
    // "this section is gone" treatment rather than a silent redirect.
    expect(await mount('automation')).toContain(NO_ACCESS)
    expect(await mount('notifs')).toContain(NO_ACCESS)
  })
})

describe('controls do not stretch', () => {
  const beehub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

  it('the tab pills are a fixed width, not flex:1 across a full-width row', async () => {
    await mount('emails')
    const pills = container.querySelectorAll('.bee-tab-pills button')
    expect(pills.length).toBeGreaterThan(0)
    for (const p of Array.from(pills)) {
      const style = (p as HTMLElement).style
      expect(style.width, 'each pill carries an explicit width').toBeTruthy()
      expect(style.flexGrow, 'no pill grows with the container').not.toBe('1')
    }
  })

  it('the pill row itself no longer forces width:100%', () => {
    // Pinned at source: the row is laid out by the style object, and jsdom
    // reports the computed row width as 0 in a detached container.
    expect(beehub).not.toContain("className=\"bee-tab-pills\" style={{ display:'flex', alignItems:'stretch', gap:'2px', width:'100%' }}")
  })

  it('CONTROL_W exists and every cap it defines is a fixed px value', () => {
    const block = beehub.slice(beehub.indexOf('const CONTROL_W = {'))
    const body = block.slice(0, block.indexOf('}'))
    const caps = Array.from(body.matchAll(/(\w+):\s*'([^']+)'/g)).map(m => [m[1], m[2]])
    expect(caps.length).toBeGreaterThanOrEqual(4)
    for (const [name, value] of caps) {
      expect(value, `CONTROL_W.${name}`).toMatch(/^\d+px$/)
    }
  })
})
