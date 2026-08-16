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

// Text of the section BODY only. Every section label also appears in the two
// navs, so asserting on container.textContent would pass for "Texts and
// scripts" while showing the Emails body. (Both navs are stripped: happy-dom
// does not load globals.css, so the media queries that hide one of them at any
// given width are not in play here and BOTH are in the DOM.)
const bodyText = () => {
  const clone = container.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[data-settings-nav], h1').forEach(n => n.remove())
  return clone.textContent ?? ''
}

const sectionKeys = (): string[] => {
  const rail = container.querySelector('[data-settings-nav="rail"]')
  return Array.from(rail!.querySelectorAll('[data-section]')).map(b => b.getAttribute('data-section')!)
}

const NO_ACCESS = "You don't have access to this section"

describe('the sections exist and render', () => {
  it('an owner is offered emails and texts; yourteam is no longer a section', async () => {
    await mount('profile')
    const keys = sectionKeys()
    expect(keys).toContain('emails')
    expect(keys).toContain('texts')
    // The two they replaced are gone from the nav (they survive only as
    // deep-link aliases, asserted below).
    expect(keys).not.toContain('paths')
    expect(keys).not.toContain('templates')
    // issue 246 step 1 — Your team split three ways and stopped existing. It
    // joins paths/templates as an alias, pinned below.
    expect(keys).not.toContain('yourteam')
  })

  it('each section renders its own body, not a blank frame', async () => {
    // The subtitle, not the <h1> — bodyText() strips headings precisely
    // because every section name also appears in the nav.
    // Lower-cased mid-sentence since issue 246 step 1: the subtitle now leads
    // with "Who your emails come from", because the sending identity moved in.
    expect(await mount('emails')).toContain('what a client receives automatically')
    expect(await mount('texts')).toContain('Texts are on their way')
    // The three addresses Your team's contents moved to (issue 246 step 1).
    expect(await mount('newleads')).toContain('Who handles each kind of job')
    expect(await mount('slack')).toContain('New leads also post to your Slack channel')
    expect(await mount('jobber')).toContain('the client import that runs from it')
  })

  it('no section lands on the no-access guard', async () => {
    for (const key of ['emails', 'texts', 'newleads', 'slack', 'jobber', 'mailchimp', 'location', 'team', 'profile']) {
      expect(await mount(key), `section='${key}'`).not.toContain(NO_ACCESS)
    }
  })
})

describe('nothing that worked before is unreachable', () => {
  // issue 246 step 1 — Your team's three halves, each pinned at its new
  // address. This is the whole risk of the step: JSX moved by line range, and
  // a block that lands nowhere is invisible to lint and to the type checker.
  it('the sending identity landed on Emails, whole', async () => {
    // The 'Sending identity' HEADING is gone as of issue 303 — the card no
    // longer leads with the location's own identity, because under a sequence
    // toggle that was the wrong answer to "who do these come from". It leads
    // with what the shown sequence actually sends as, and the location trio is
    // the labelled fallback underneath.
    //
    // What this test is FOR is unchanged and still asserted: issue 246 step 1
    // moved this block by line range, and the risk it guards is a block that
    // lands nowhere. The three rows are the block; they are what "whole" means.
    const text = await mount('emails')
    expect(text).toContain('Send From Name')
    expect(text).toContain('Send From Email')
    expect(text).toContain('Reply-To Email')
    // Still introduced as a fallback rather than dumped in unlabelled.
    expect(text).toContain('Everything else')
  })

  it('New leads renders its own body at its own address', async () => {
    // issue 246 step 2 rebuilt this section: TeamRouting + NewLeadNotifications
    // became NewLeadsSection.
    //
    // This used to assert 'Every kind of job' / 'Who hears about new leads' and
    // looked like a content guarantee. It was not: those were CommsLabels the
    // SETTINGS SECTION rendered around the components, so they appeared whether
    // the components rendered anything or not — and at this mount they never
    // did, because there is no resolved location UUID here. The labels now live
    // with their lists inside NewLeadsSection, which is where they belong.
    //
    // What this address can honestly promise without a location is that the
    // section is its own live surface. The real content guarantee — both lists,
    // with fixtures — is lib/beta-new-leads-246b.test.tsx.
    const text = await mount('newleads')
    expect(text).not.toContain(NO_ACCESS)
    expect(text).toContain('Who handles each kind of job')
    expect(text).toContain('New-lead settings become available once your location is saved')
  })

  it('SlackCard landed on Connections › Slack', async () => {
    // SlackCard's own copy, so this fails if only the heading moved.
    expect(await mount('slack')).toContain('Slack')
    expect(await mount('slack')).not.toContain(NO_ACCESS)
  })

  it('JobberCard landed on Connections › Jobber, and left Location', async () => {
    expect(await mount('jobber')).toContain('Jobber')
    // Location kept everything else and lost only this.
    const loc = await mount('location')
    expect(loc).toContain('Location Name')
    expect(loc).toContain('Assessment Default')   // still here, still honest
    expect(loc).not.toContain('Integrations')
  })

  it('Emails still carries both project-type sequences', async () => {
    // Same guarantee, different carrier: issue 240 step 11 retired the two
    // tiles and step 7b put the pair behind a toggle. Neither sequence may
    // become unreachable — 4 locations hold a fork on moving alone.
    const text = await mount('emails')
    expect(text).toContain('Every email a client can receive')
    expect(text).toContain('Organizing')
    expect(text).toContain('Moving')
  })

  it('Emails owns no template section at all, and Texts & scripts owns its two', async () => {
    // Issue 240 step 11: the email template section is gone from this tab.
    // Creating and deleting a reusable email template is corporate's, in
    // Admin → Content. The list above is the only email surface left here.
    const emails = await mount('emails')
    expect(emails).not.toContain('Email Templates')
    // And it certainly must not have inherited the other two slices.
    expect(emails).not.toContain('Text Templates')
    expect(emails).not.toContain('Call Scripts')

    const texts = await mount('texts')
    // 'Text Templates' was an empty accordion locked behind a chip that could
    // never be earned; issue 240 step 6 replaced it with an inert preview.
    expect(texts).toContain('Text messages')
    expect(texts).not.toContain('Text Templates')
    expect(texts).toContain('Call Scripts')
    expect(texts).not.toContain('Email Templates')
  })
})

describe('deep links to the old sections still resolve', () => {
  it('?section=paths lands on Emails, not the no-access guard', async () => {
    // The landmark moved with step 11 — an old bookmark must still arrive at
    // the surface that replaced what it pointed at.
    const text = await mount('paths')
    expect(text).not.toContain(NO_ACCESS)
    expect(text).toContain('Every email a client can receive')
  })

  it('?section=templates lands on Emails too', async () => {
    const text = await mount('templates')
    expect(text).not.toContain(NO_ACCESS)
    expect(text).toContain('Every email a client can receive')
  })

  it('?section=billing still lands on Team & Billing (the older alias survives)', async () => {
    expect(await mount('billing')).not.toContain(NO_ACCESS)
  })

  it('?section=yourteam lands on New leads — the larger of the three halves', async () => {
    // issue 246 step 1. Your team split into Emails (sending identity),
    // New leads (routing + recipients) and Slack. A deep link picks one, and
    // it picks where the bulk went AND where the section's stated job went:
    // "who hears about a new lead".
    const text = await mount('yourteam')
    expect(text).not.toContain(NO_ACCESS)
    expect(text).toContain('Who handles each kind of job')
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

  it('the rail is a fixed width and does not grow with the viewport', async () => {
    // issue 246 step 1 — the pill row became a rail; the cap moved with it
    // (CONTROL_W.tab → CONTROL_W.rail) and does the same job.
    await mount('emails')
    const rail = container.querySelector('[data-settings-nav="rail"]') as HTMLElement
    expect(rail, 'the settings rail').toBeTruthy()
    expect(rail.style.width, 'the rail carries an explicit width').toBeTruthy()
    expect(rail.style.flexGrow, 'the rail does not grow with the container').not.toBe('1')
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
