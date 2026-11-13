// @vitest-environment happy-dom
//
// Settings slice 4 of 4 (2026-11-13): Connections, and Texts splits in two.
//
// CONNECTIONS — one landing page where the nav had three items. A card per
// connection in THIS LOCATION's own state; a card opens the screen that
// connection always had (SlackCard, JobberCard, MailchimpCard), which is not
// restyled. Pinned here:
//   · Mailchimp is a live connection like the other two — never "coming soon"
//   · Gmail and Dialpad are greyed ROADMAP cards ("Coming soon"): not buttons,
//     never counted as connected
//   · the counts are this location's own
//   · slack / jobber / mailchimp links still land on their screens
//   · a manager cannot reach any of it
//
// TEXTS — "Texts and scripts" split. Call scripts is its own section holding
// what the call half held (create, edit, delete). Text messaging is a greyed
// item with a "Soon" chip — the same treatment Tags got in slice 3, not a
// second pattern. An old `texts` link lands on Call scripts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as BeeHubModule from '@/components/BeeHub'
import { ConnectionsPage, connectionCards, connectionSummary, ROADMAP_CARDS, MAILCHIMP_NOT_SYNCING, LOGO_DOMAINS, logoUrl } from '@/components/settings/ConnectionsPage'
import { SLACK_MARK_PATHS } from '@/components/hive/shared/SlackMark'
import { NOT_LIVE_COPY } from '@/lib/mailchimp-connection-state'

const { SettingsScreen, CurrentUserContext } = BeeHubModule as any

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const HUB = read('components/BeeHub.jsx')
const PAGE = read('components/settings/ConnectionsPage.jsx')
const PAGE_CODE = PAGE.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
const SETTINGS = HUB.slice(HUB.indexOf('export function SettingsScreen('))

const LOC = '2b3c4d5e-1111-4222-8333-444455556666'
const user = { id: 'u-owner', email: 'riley@bee.test', name: 'Riley Park', role: 'franchise', locationId: LOC, first_name: 'Riley', last_name: 'Park', phone: '', booking_link: null }
// What a location row looks like to SettingsScreen (its selectedLoc shape).
const loc = (over: Record<string, any> = {}) => ({
  id: LOC, name: 'Seattle', street: '101 Pine St', city: 'Seattle', state: 'WA', zip: '98101', timezone: 'Pacific Time (PT)', crmStatus: 'active',
  slackConnected: false, jobberConnected: false, mailchimpConnected: false, ...over,
})
const ALL = { slackConnected: true, slackChannelName: 'leads', slackTeamName: 'Bee Seattle', jobberConnected: true, jobberAccountName: 'Bee Organized Seattle', mailchimpConnected: true, mailchimpAccountName: 'Bee Seattle MC', mailchimpListId: 'L1', mailchimpListName: 'Bee Organized Friends' }

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: Array<{ url: string; method: string; body: any }>
let alerts: string[]
let mcLive: boolean | 'fail' = false
let templates: any[] = []

const res = (body: any, ok = true, status = 200) => ({ ok, status, json: async () => body })
beforeEach(() => {
  calls = []; alerts = []; mcLive = false; templates = []
  vi.stubGlobal('fetch', vi.fn(async (u: any, init: any = {}) => {
    const url = String(u); const method = init.method || 'GET'
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined })
    if (url.startsWith('/api/mailchimp/status')) return mcLive === 'fail' ? res({}, false, 500) : res({ live: mcLive })
    if (url === '/api/templates' && method === 'GET') return res({ templates })
    if (url === '/api/templates' && method === 'POST') return res({ template: { id: 'new-1', legacy_id: null, ...JSON.parse(init.body), is_own_custom: true, is_active: true } })
    if (url.startsWith('/api/templates/') && method === 'PATCH') return res({ template: { id: 't1', ...JSON.parse(init.body), is_active: true } })
    return res({})
  }))
  vi.stubGlobal('alert', (m: string) => { alerts.push(String(m)) })
  vi.stubGlobal('confirm', () => true)
  window.history.replaceState(null, '', '/')
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const settle = async (ms = 15) => { await act(async () => { await new Promise(r => setTimeout(r, ms)) }) }
const mount = async (props: Record<string, any> = {}, location: any = loc()) => {
  await act(async () => root.unmount()); container.remove()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={user}>
        <SettingsScreen initialSection="connections" franchiseRole="owner" selectedLoc={location} {...props} />
      </CurrentUserContext.Provider>,
    )
  })
  await settle()
}
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
const all = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[]
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle() }
const type = async (input: Element | null | undefined, value: string) => {
  if (!input) throw new Error('no input')
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const rail = () => q('[data-settings-nav="rail"]')!
const drill = () => q('[data-settings-nav="drill"]')!
const pane = () => drill().nextElementSibling as HTMLElement
const railCurrent = () => rail().querySelector('[aria-current="page"]')?.getAttribute('data-section')
const card = (id: string) => q(`[data-connection="${id}"]`) as HTMLButtonElement
const chip = (id: string) => card(id).querySelector('[data-connection-chip]')!.textContent
const summary = () => q('[data-connections-summary]')!.textContent
const NO_ACCESS = "You don't have access to this section"

// ═══════════════════════════════════════════════════════════════════════════
// 1 · THE CARDS ARE THIS LOCATION'S OWN STATE
// ═══════════════════════════════════════════════════════════════════════════
describe('each card says what is true for this location', () => {
  it('the rules, on their own: three cards, each in one of three states', () => {
    const none = connectionCards({})
    expect(none.map(c => [c.id, c.state, c.chip])).toEqual([['slack', 'off', 'Not connected'], ['jobber', 'off', 'Not connected'], ['mailchimp', 'off', 'Not connected']])
    const every = connectionCards({ slackConnected: true, slackChannelName: '#leads', slackTeamName: 'Bee Seattle', jobberStatus: 'connected', jobberAccountName: 'Acct', mailchimpConnected: true, mailchimpListId: 'L1', mailchimpListName: 'Friends' })
    expect(every.map(c => [c.id, c.state, c.chip, c.detail])).toEqual([
      ['slack', 'connected', 'Connected', '#leads · Bee Seattle'],
      ['jobber', 'connected', 'Connected', 'Acct'],
      ['mailchimp', 'connected', 'Connected', 'Friends'],
    ])
    // Linked but something is owed: not counted as connected.
    const owed = connectionCards({ jobberStatus: 'reconnect_required', jobberAccountName: 'Acct', mailchimpConnected: true, mailchimpAccountName: 'MC', mailchimpListId: '' })
    expect(owed.map(c => [c.id, c.state, c.chip, c.detail])).toEqual([
      ['slack', 'off', 'Not connected', ''],
      ['jobber', 'finish', 'Reconnect required', 'Acct'],
      ['mailchimp', 'finish', 'Finish setting up', 'MC'],
    ])
  })

  it('the banner counts only what is there, and has its own words for nothing at all', () => {
    const s = (...states: string[]) => connectionSummary(states.map(state => ({ state })) as any)
    expect(s('off', 'off', 'off')).toBe('Nothing connected yet')
    expect(s('connected', 'off', 'off')).toBe('1 connected · 2 not connected')
    expect(s('connected', 'connected', 'off')).toBe('2 connected · 1 not connected')
    expect(s('connected', 'connected', 'connected')).toBe('3 connected')
    expect(s('connected', 'finish', 'off')).toBe('1 connected · 1 to finish · 1 not connected')
    expect(s('finish', 'off', 'off')).toBe('1 to finish · 2 not connected')
    // Roadmap cards are counted as coming soon and as nothing else — never
    // as connected, never as something the owner has left undone.
    expect(s('off', 'off', 'off', 'soon', 'soon')).toBe('Nothing connected yet · 2 coming soon')
    expect(s('connected', 'off', 'off', 'soon', 'soon')).toBe('1 connected · 2 not connected · 2 coming soon')
    expect(s('connected', 'connected', 'connected', 'soon', 'soon')).toBe('3 connected · 2 coming soon')
    expect(s('connected', 'finish', 'off', 'soon', 'soon')).toBe('1 connected · 1 to finish · 1 not connected · 2 coming soon')
    expect(s('soon', 'soon')).toBe('Nothing connected yet · 2 coming soon')
  })

  const cases: Array<[string, Record<string, any>, string, string[], string[]]> = [
    ['nothing connected (a new franchise)', {}, 'Nothing connected yet · 2 coming soon', ['Not connected', 'Not connected', 'Not connected'], ['Connect', 'Connect', 'Connect']],
    ['Slack only', { slackConnected: true, slackChannelName: 'leads' }, '1 connected · 2 not connected · 2 coming soon', ['Connected', 'Not connected', 'Not connected'], ['Manage', 'Connect', 'Connect']],
    ['Slack and Jobber', { slackConnected: true, jobberConnected: true }, '2 connected · 1 not connected · 2 coming soon', ['Connected', 'Connected', 'Not connected'], ['Manage', 'Manage', 'Connect']],
    ['Mailchimp only', { mailchimpConnected: true, mailchimpListId: 'L1', mailchimpListName: 'Friends' }, '1 connected · 2 not connected · 2 coming soon', ['Not connected', 'Not connected', 'Connected'], ['Connect', 'Connect', 'Manage']],
    ['everything', ALL, '3 connected · 2 coming soon', ['Connected', 'Connected', 'Connected'], ['Manage', 'Manage', 'Manage']],
    ['Mailchimp linked with no audience picked', { mailchimpConnected: true, mailchimpAccountName: 'MC' }, '1 to finish · 2 not connected · 2 coming soon', ['Not connected', 'Not connected', 'Finish setting up'], ['Connect', 'Connect', 'Manage']],
  ]
  for (const [name, over, banner, chips, actions] of cases) {
    it(`${name}: "${banner}"`, async () => {
      await mount({}, loc(over))
      expect(summary()).toBe(banner)
      expect(['slack', 'jobber', 'mailchimp'].map(chip)).toEqual(chips)
      expect(['slack', 'jobber', 'mailchimp'].map(id => card(id).querySelector('[data-connection-action]')!.textContent)).toEqual(actions)
      // Three live cards, then the two roadmap cards.
      expect(all('[data-connection]').map(c => c.getAttribute('data-connection'))).toEqual(['slack', 'jobber', 'mailchimp', 'gmail', 'dialpad'])
    })
  }

  it('a connected card says which channel, account or audience', async () => {
    await mount({}, loc(ALL))
    expect(card('slack').querySelector('[data-connection-detail]')!.textContent).toBe('#leads · Bee Seattle')
    expect(card('jobber').querySelector('[data-connection-detail]')!.textContent).toBe('Bee Organized Seattle')
    expect(card('mailchimp').querySelector('[data-connection-detail]')!.textContent).toBe('Bee Organized Friends')
    await mount({}, loc())
    expect(q('[data-connection-detail]')).toBeNull()
  })

  it('no number on the page is fixed: the banner is built from the cards, and nothing is typed in', () => {
    expect(PAGE_CODE).toContain('{connectionSummary(cards)}')
    expect(PAGE_CODE).not.toMatch(/['"`>]\s*\d+ connected/)
    expect(PAGE_CODE).not.toMatch(/['"`>]\s*\d+ coming soon/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · MAILCHIMP IS LIVE; GMAIL AND DIALPAD ARE NOT PROMISED
// ═══════════════════════════════════════════════════════════════════════════
describe('Mailchimp reads as a live connection', () => {
  it('its card is a card like Slack’s and Jobber’s: a button, not dimmed, not "soon"', async () => {
    await mount({}, loc(ALL))
    for (const id of ['slack', 'jobber', 'mailchimp']) {
      const c = card(id)
      expect(c.tagName, id).toBe('BUTTON')
      expect(c.disabled, id).toBe(false)
      expect(c.getAttribute('data-state'), id).toBe('connected')
      expect(c.style.opacity, id).toBe(''); expect(c.style.filter, id).toBe('')
      expect(c.querySelector('[data-connection-action]')!.textContent, id).toBe('Manage')
    }
    expect(chip('mailchimp')).toBe(chip('slack'))
    for (const id of ['slack', 'jobber', 'mailchimp']) expect(card(id).textContent, id).not.toMatch(/coming soon|\bsoon\b/i)
    expect(card('mailchimp').hasAttribute('data-soon')).toBe(false)
  })

  it('the three states use the words the Mailchimp screen itself uses', async () => {
    await mount({}, loc())
    expect(chip('mailchimp')).toBe('Not connected')
    await mount({}, loc({ mailchimpConnected: true }))
    expect(chip('mailchimp')).toBe('Finish setting up')
    await mount({}, loc({ mailchimpConnected: true, mailchimpListId: 'L1' }))
    expect(chip('mailchimp')).toBe('Connected')
  })

  it('connected but sync not switched on: still Connected, with the Mailchimp screen’s own sentence under it', async () => {
    mcLive = false
    await mount({}, loc(ALL))
    expect(chip('mailchimp')).toBe('Connected')
    expect(summary()).toBe('3 connected · 2 coming soon')
    const note = card('mailchimp').querySelector('[data-connection-note]')!
    expect(note.textContent).toBe('Syncing isn’t switched on for your location yet, we’ll let you know when it is.')
    expect(NOT_LIVE_COPY).toBe('Connected. ' + MAILCHIMP_NOT_SYNCING)
    // Asked once, the way the Mailchimp screen asks.
    expect(calls.filter(c => c.url.startsWith('/api/mailchimp/status')).map(c => [c.url, c.method])).toEqual([[`/api/mailchimp/status?location_id=${LOC}`, 'GET']])
    // Only Mailchimp carries it.
    expect(all('[data-connection-note]').length).toBe(1)
  })

  it('sync switched on: no such line', async () => {
    mcLive = true
    await mount({}, loc(ALL))
    expect(chip('mailchimp')).toBe('Connected')
    expect(q('[data-connection-note]')).toBeNull()
  })

  it('if it cannot find out, it says nothing rather than guess', async () => {
    mcLive = 'fail'
    await mount({}, loc(ALL))
    expect(q('[data-connection-note]')).toBeNull()
    expect(chip('mailchimp')).toBe('Connected')
  })

  it('it only asks when there is a finished connection to ask about', async () => {
    for (const over of [{}, { mailchimpConnected: true, mailchimpListId: '' }, { slackConnected: true, jobberConnected: true }]) {
      await mount({}, loc(over))
      expect(calls.filter(c => c.url.startsWith('/api/mailchimp/')), JSON.stringify(over)).toEqual([])
    }
    // …and not for a location you are only looking at.
    await mount({}, loc({ ...ALL, id: 'loc_demo_slug' }))
    expect(calls.filter(c => c.url.startsWith('/api/mailchimp/'))).toEqual([])
  })

  it('opening the page changes nothing anywhere: every request it makes is a read', async () => {
    await mount({}, loc(ALL))
    expect(calls.filter(c => c.method !== 'GET')).toEqual([])
  })
})

// Kevin, 2026-11-13: greyed roadmap cards are how Bee Hub shows what is
// coming, so these two are deliberate. What must hold is that they can never
// be mistaken for something that works today.
describe('Gmail and Dialpad are roadmap cards: greyed, "Coming soon", and nothing more', () => {
  it('both are on the page after the three live cards, whatever the location has connected', async () => {
    for (const over of [{}, ALL, { slackConnected: true }]) {
      await mount({}, loc(over))
      expect(all('[data-connection]').map(c => [c.getAttribute('data-connection'), c.getAttribute('data-state')]).slice(3)).toEqual([['gmail', 'soon'], ['dialpad', 'soon']])
      expect(chip('gmail')).toBe('Coming soon'); expect(chip('dialpad')).toBe('Coming soon')
    }
    expect(ROADMAP_CARDS.map(c => [c.id, c.state, c.chip])).toEqual([['gmail', 'soon', 'Coming soon'], ['dialpad', 'soon', 'Coming soon']])
  })

  it('neither is a button, neither has a Connect or Manage action, and there is nothing to tab to', async () => {
    await mount({}, loc(ALL))
    for (const id of ['gmail', 'dialpad']) {
      const c = card(id)
      expect(c.tagName, id).toBe('DIV')
      expect(c.getAttribute('aria-disabled'), id).toBe('true')
      expect(c.hasAttribute('data-soon'), id).toBe(true)
      expect(c.hasAttribute('data-scard'), `${id} takes no hover`).toBe(false)
      expect(c.querySelector('button, a, [tabindex], [data-connection-action]'), id).toBeNull()
      expect(c.hasAttribute('tabindex'), id).toBe(false)
      expect(c.textContent, id).not.toMatch(/Connect|Manage|Connected|Not connected/)
      expect(c.style.cursor, id).toBe('default')
    }
    expect(all('[data-connection] [data-connection-action]').length).toBe(3)
  })

  it('clicking one opens nothing and asks the server nothing', async () => {
    await mount({}, loc())
    const push = vi.spyOn(window.history, 'pushState')
    calls = []
    for (const id of ['gmail', 'dialpad']) { await click(card(id)); await click(card(id).querySelector('[data-connection-chip]')) }
    expect(push).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(pane().querySelector('h1')!.textContent).toBe('Connections')
    expect(q('[data-connections-summary]')).toBeTruthy()
  })

  it('they cannot be reached by a link either: gmail and dialpad are not sections', async () => {
    for (const key of ['gmail', 'dialpad']) {
      await mount({ initialSection: key }, loc(ALL))
      expect(pane().textContent, key).toContain(NO_ACCESS)
      expect(q('[data-connection]'), key).toBeNull()
    }
    expect(HUB).toContain("const CONNECTION_SECTIONS = ownerConfig ? ['slack', 'jobber', 'mailchimp'] : []")
    expect(SETTINGS).not.toMatch(/activeSection==='(gmail|dialpad)'/)
  })

  it('the greyed treatment is the one Tags and Text messaging get: words at half strength, a muted chip at full strength', async () => {
    await mount({}, loc())
    const navItem = rail().querySelector('[data-section="tags"]') as HTMLElement
    const navChip = navItem.querySelector('[data-soon-chip]') as HTMLElement
    const navName = Array.from(navItem.querySelectorAll('span')).find(x => x.textContent === 'Tags') as HTMLElement
    for (const id of ['gmail', 'dialpad']) {
      const c = card(id)
      const cardChip = c.querySelector('[data-soon-chip]') as HTMLElement
      // The chip: same fill, same ink, never dimmed.
      expect(cardChip.style.background, id).toBe(navChip.style.background)
      expect(cardChip.style.color, id).toBe(navChip.style.color)
      expect(cardChip.style.opacity, id).toBe('')
      let el: HTMLElement | null = cardChip.parentElement
      while (el && el !== c) { expect(el.style.opacity, `${id}: the chip sits inside something dimmed`).toBe(''); el = el.parentElement }
      // The name, the category and the line: at the strength the nav gives a closed item's name.
      const name = Array.from(c.querySelectorAll('span')).find(x => x.textContent === ROADMAP_CARDS.find(r => r.id === id)!.name) as HTMLElement
      expect(name.parentElement!.style.opacity, id).toBe(navName.style.opacity)
      expect(name.parentElement!.style.opacity, id).toBe('0.5')
      expect(c.style.opacity, id).toBe('')   // the card itself is not faded, so the chip stays readable
    }
  })

  it('each says what the feature WILL do, in the design’s words, and claims nothing about today', async () => {
    await mount({}, loc(ALL))
    expect(card('gmail').textContent).toBe('GComing soonGmailEmailSend client emails from your own Gmail address.')
    expect(card('dialpad').textContent).toBe('DComing soonDialpadPhone & textsLog calls and send texts from your business line.')
    for (const id of ['gmail', 'dialpad']) expect(card(id).querySelector('[data-connection-detail], [data-connection-note]'), id).toBeNull()
  })

  it('the banner counts them as coming soon — never as connected, and never as "not connected"', async () => {
    await mount({}, loc())
    expect(summary()).toBe('Nothing connected yet · 2 coming soon')
    await mount({}, loc(ALL))
    expect(summary()).toBe('3 connected · 2 coming soon')
    await mount({}, loc({ slackConnected: true }))
    // Two not connected (Jobber, Mailchimp) — not four.
    expect(summary()).toBe('1 connected · 2 not connected · 2 coming soon')
    // No location data can turn one on: they are not read from the location at all.
    await mount({}, loc({ ...ALL, gmailConnected: true, dialpadConnected: true, gmail_connected: true }))
    expect(summary()).toBe('3 connected · 2 coming soon')
    expect(connectionCards({ gmailConnected: true, dialpadConnected: true }).map(c => c.id)).toEqual(['slack', 'jobber', 'mailchimp'])
    // …even handed straight to the page, past everything Settings filters out.
    await act(async () => root.unmount()); container.remove()
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
    await act(async () => { root.render(<ConnectionsPage {...({ location: { gmailConnected: true, dialpadConnected: true, gmail: true, dialpad: true, gmailStatus: 'connected' }, locationId: null, onOpen: () => {} } as any)} />) })
    expect(summary()).toBe('Nothing connected yet · 2 coming soon')
    expect(card('gmail').getAttribute('data-state')).toBe('soon'); expect(card('dialpad').getAttribute('data-state')).toBe('soon')
  })

  it('a manager is shown neither', async () => {
    await mount({ franchiseRole: 'manager' }, loc(ALL))
    expect(pane().textContent).toContain(NO_ACCESS)
    expect(pane().textContent).not.toMatch(/Gmail|Dialpad|Coming soon/)
  })
})

describe('the marks', () => {
  it('Slack’s is Slack’s own published mark, reused, with the clear space it asks for', async () => {
    await mount()
    const tile = card('slack').querySelector('[data-mark="slack"]') as HTMLElement
    const paths = Array.from(tile.querySelectorAll('svg path')).map(p => p.getAttribute('d'))
    expect(paths).toEqual(SLACK_MARK_PATHS.map(p => p[1]))
    expect(PAGE).toContain("import SlackMark from '@/components/hive/shared/SlackMark'")
    // A 24px mark in a 48px tile: 12px each side, and the terms ask for 0.473 × 24 = 11.4.
    const svg = tile.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('24')
    expect(tile.style.width).toBe('48px')
    expect((48 - 24) / 2).toBeGreaterThanOrEqual(0.473 * 24)
  })

  // 2026-11-13: the export's own approach. Bee Hub ships no logo files for
  // these four; each company's site icon is fetched live from Google's
  // favicon service. Kevin has accepted that an owner's browser asks Google
  // for them when Connections opens. What must hold: the right four
  // addresses and nothing more, a letter tile whenever a picture has not
  // (or never) arrived, and a greyed picture on a greyed card.
  const LOGOS: Array<[string, string, string]> = [
    ['jobber', 'J', 'https://www.google.com/s2/favicons?domain=getjobber.com&sz=128'],
    ['mailchimp', 'M', 'https://www.google.com/s2/favicons?domain=mailchimp.com&sz=128'],
    ['gmail', 'G', 'https://www.google.com/s2/favicons?domain=gmail.com&sz=128'],
    ['dialpad', 'D', 'https://www.google.com/s2/favicons?domain=dialpad.com&sz=128'],
  ]
  const mark = (id: string) => card(id).querySelector('[data-mark]') as HTMLElement
  const fire = async (el: Element, type: string) => { await act(async () => { el.dispatchEvent(new Event(type)) }) }
  // The test browser never fetches a picture, and reports every <img> as
  // "finished, and empty" at once. `pending(true)` makes a picture look the
  // way it does in a real browser while it is still on its way, so the load
  // and error events below are what decide — nothing passes by not running.
  const proto = () => (window as any).HTMLImageElement.prototype
  const pending = (isPending: boolean, naturalWidth = 0) => {
    Object.defineProperty(proto(), 'complete', { configurable: true, get: () => !isPending })
    Object.defineProperty(proto(), 'naturalWidth', { configurable: true, get: () => naturalWidth })
  }
  beforeEach(() => pending(true))
  afterEach(() => { delete proto().complete; delete proto().naturalWidth })

  it('Jobber, Mailchimp, Gmail and Dialpad each ask Google’s favicon service for that company’s own site icon', async () => {
    await mount({}, loc(ALL))
    expect(LOGOS.map(([id]) => card(id).querySelector('img')!.getAttribute('src'))).toEqual(LOGOS.map(l => l[2]))
    expect(LOGO_DOMAINS).toEqual({ jobber: 'getjobber.com', mailchimp: 'mailchimp.com', gmail: 'gmail.com', dialpad: 'dialpad.com' })
    expect(logoUrl('getjobber.com')).toBe('https://www.google.com/s2/favicons?domain=getjobber.com&sz=128')
    // Exactly four pictures on the page, and Slack's is not one of them.
    expect(all('[data-settings-page] img').length).toBe(4)
    expect(card('slack').querySelector('img')).toBeNull()
    for (const [id] of LOGOS) {
      const img = card(id).querySelector('img')!
      expect(img.getAttribute('alt'), id).toBe('')                         // decorative: the card names it
      expect(img.getAttribute('referrerpolicy'), id).toBe('no-referrer')   // Google is not told which page asked
    }
  })

  it('the address carries the company’s public domain and nothing about the owner or the location', async () => {
    await mount({}, loc(ALL))
    for (const img of all('[data-settings-page] img')) {
      const u = new URL(img.getAttribute('src')!)
      expect(u.origin + u.pathname).toBe('https://www.google.com/s2/favicons')
      expect(Array.from(u.searchParams.keys())).toEqual(['domain', 'sz'])
      expect(img.getAttribute('src')).not.toContain(LOC)
      expect(img.getAttribute('src')).not.toMatch(/seattle|riley|bee/i)
    }
    // No other outside address anywhere in the page's code.
    expect(Array.from(PAGE_CODE.matchAll(/https?:\/\/[^\s'"`)]+/g)).map(m => m[0])).toEqual(['https://www.google.com/s2/favicons?domain=${domain}&sz=128'])
  })

  it('until a picture has loaded the tile shows the letter, and the picture is not displayed', async () => {
    await mount({}, loc(ALL))
    for (const [id, letter] of LOGOS) {
      const m = mark(id)
      expect(m.getAttribute('data-logo-state'), id).toBe('loading')
      expect(m.getAttribute('data-mark'), id).toBe('letter')
      expect(m.textContent, id).toBe(letter)
      expect((m.querySelector('img') as HTMLElement).style.display, id).toBe('none')
    }
  })

  it('a picture that LOADS replaces the letter', async () => {
    await mount({}, loc(ALL))
    for (const [id] of LOGOS) {
      const img = card(id).querySelector('img')!
      expect(img, `${id}: a picture is on its way`).toBeTruthy()
      await fire(img, 'load')
      const m = mark(id)
      expect(m.getAttribute('data-mark'), id).toBe('logo')
      expect(m.getAttribute('data-logo-state'), id).toBe('loaded')
      expect(m.textContent, id).toBe('')
      expect((m.querySelector('img') as HTMLElement).style.display, id).toBe('block')
    }
  })

  it('a picture that FAILS falls back to the letter tile — the picture is taken out, so no broken-image icon can show', async () => {
    await mount({}, loc(ALL))
    for (const [id, letter] of LOGOS) {
      const img = card(id).querySelector('img')!
      expect(img, `${id}: a picture is on its way`).toBeTruthy()
      await fire(img, 'error')
      const m = mark(id)
      expect(m.getAttribute('data-logo-state'), id).toBe('failed')
      expect(m.getAttribute('data-mark'), id).toBe('letter')
      expect(m.textContent, id).toBe(letter)
      expect(m.querySelector('img'), `${id}: no <img> left to draw a broken icon`).toBeNull()
      // The letter tile as it was before logos: the soft sage tile, no outline.
      expect(m.style.width).toBe('48px')
      expect(m.querySelector('svg, path')).toBeNull()
    }
    expect(all('[data-settings-page] img').length).toBe(0)
    // Every card still reads right with no pictures at all.
    expect(['slack', 'jobber', 'mailchimp', 'gmail', 'dialpad'].map(chip)).toEqual(['Connected', 'Connected', 'Connected', 'Coming soon', 'Coming soon'])
  })

  it('one failing does not take the others with it, and a late load after a failure changes nothing', async () => {
    await mount({}, loc(ALL))
    const j = card('jobber').querySelector('img')!, m = card('mailchimp').querySelector('img')!
    await fire(j, 'error')
    await fire(m, 'load')
    expect(mark('jobber').getAttribute('data-mark')).toBe('letter')
    expect(mark('mailchimp').getAttribute('data-mark')).toBe('logo')
    expect(card('jobber').querySelector('img')).toBeNull()
    expect(mark('gmail').getAttribute('data-logo-state')).toBe('loading')
  })

  it('a picture the browser had already given up on before the page was listening still falls back', async () => {
    pending(false, 0)   // finished, and empty: a failed picture whose error event has been and gone
    await mount({}, loc(ALL))
    for (const [id, letter] of LOGOS) {
      expect(mark(id).getAttribute('data-logo-state'), id).toBe('failed')
      expect(mark(id).textContent, id).toBe(letter)
      expect(card(id).querySelector('img'), id).toBeNull()
    }
  })

  it('…and one the browser already had, whole, is shown without waiting for an event', async () => {
    pending(false, 128)   // finished, with a real picture: served from the browser's own store
    await mount({}, loc(ALL))
    for (const [id] of LOGOS) {
      expect(mark(id).getAttribute('data-logo-state'), id).toBe('loaded')
      expect((card(id).querySelector('img') as HTMLElement).style.display, id).toBe('block')
    }
  })

  it('a roadmap card’s picture is greyed to match its card; a live card’s is in full colour', async () => {
    await mount({}, loc(ALL))
    for (const id of ['gmail', 'dialpad']) {
      const img = card(id).querySelector('img') as HTMLElement
      expect(img.style.filter, `${id}: greyed even before it shows`).toBe('grayscale(1)')
      await fire(img, 'load')
      const shown = card(id).querySelector('img') as HTMLElement
      expect(shown.style.filter, id).toBe('grayscale(1)')
      // …and it sits at the half strength the rest of the card's words have.
      expect((mark(id).parentElement as HTMLElement).style.opacity, id).toBe('0.5')
    }
    for (const id of ['jobber', 'mailchimp']) {
      const img = card(id).querySelector('img') as HTMLElement
      await fire(img, 'load')
      expect((card(id).querySelector('img') as HTMLElement).style.filter, id).toBe('none')
      expect((mark(id).parentElement as HTMLElement).style.opacity, id).toBe('')
    }
    // Greyed in the letter-tile fallback too.
    expect(PAGE_CODE).toContain("<span style={{ opacity:0.5 }}><Mark greyed /></span>")
  })

  it('it is written down that this is deliberate, and how to swap in real logo files later', () => {
    expect(PAGE).toContain('THIS IS DELIBERATE, NOT AN ACCIDENT (Kevin, 2026-11-13)')
    expect(PAGE).toMatch(/owner's browser makes four requests to google\.com/)
    expect(PAGE).toContain('TO REPLACE IT LATER with real logo files')
    // Nothing is drawn or shipped for these four.
    expect(PAGE_CODE).not.toMatch(/\.png|\.svg['"]|#[0-9a-fA-F]{3,8}\b/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · WHAT A CARD OPENS, AND THE OLD LINKS
// ═══════════════════════════════════════════════════════════════════════════
const SCREENS: Array<[string, string, string]> = [
  ['slack', 'Slack', 'New leads also post to your Slack channel'],
  ['jobber', 'Jobber', 'Your Jobber account, and the client import that runs from it.'],
  ['mailchimp', 'Mailchimp', 'Your Mailchimp account, and the audience your clients belong to.'],
]
describe('a card opens the screen that connection always had', () => {
  for (const [id, title, words] of SCREENS) {
    it(`${id}: the same screen, with Connections still lit and a way back`, async () => {
      await mount()
      const push = vi.spyOn(window.history, 'pushState')
      await click(card(id))
      // A real navigation, so the back button returns to Connections.
      expect(push).toHaveBeenCalledTimes(1)
      expect(String(push.mock.calls[0][2])).toContain(`section=${id}`)
      expect(pane().querySelector('h1')!.textContent).toBe(title)
      expect(pane().textContent).toContain(words)
      expect(q('[data-connections-summary]')).toBeNull()
      expect(railCurrent()).toBe('connections')
      await click(q('[data-connections-back] button'))
      expect(q('[data-connections-summary]')).toBeTruthy()
      expect(pane().querySelector('h1')!.textContent).toBe('Connections')
    })
  }

  it('the three screens are mounted exactly as they were — same components, same props', () => {
    expect(SETTINGS).toContain('<SlackCard settings={settings} updateLocation={updateLocation} />')
    expect(SETTINGS).toContain('<JobberCard settings={settings} updateLocation={updateLocation} />')
    expect(SETTINGS).toContain('<MailchimpCard settings={settings} updateLocation={updateLocation} />')
    for (const c of ['SlackCard', 'JobberCard', 'MailchimpCard']) expect(SETTINGS.split(`<${c} `).length - 1, c).toBe(1)
    // The landing page mounts none of them and connects nothing itself.
    expect(PAGE_CODE).not.toMatch(/SlackCard|JobberCard|MailchimpCard|oauth/i)
    // Its one request is the read of Mailchimp's sync switch.
    expect(PAGE_CODE.split('fetch(').length - 1).toBe(1)
    expect(PAGE_CODE).toContain("fetch('/api/mailchimp/status?location_id=' + encodeURIComponent(locationId))")
  })
})

describe('old links still land somewhere', () => {
  for (const [id, title, words] of SCREENS) {
    it(`?section=${id} lands on the ${title} screen`, async () => {
      await mount({ initialSection: id })
      expect(pane().textContent).not.toContain(NO_ACCESS)
      expect(pane().querySelector('h1')!.textContent).toBe(title)
      expect(pane().textContent).toContain(words)
      expect(railCurrent()).toBe('connections')
      expect(q('[data-connections-back]')).toBeTruthy()
    })

    it(`…and so does the back button onto a remembered ${title} page`, async () => {
      await mount({ initialSection: 'profile' })
      await act(async () => {
        window.history.replaceState({ beeSettingsSection: id }, '', `/?section=${id}`)
        window.dispatchEvent(new PopStateEvent('popstate', { state: { beeSettingsSection: id } }))
      })
      await settle()
      expect(pane().querySelector('h1')!.textContent).toBe(title)
    })
  }

  it('?section=texts lands on Call scripts', async () => {
    await mount({ initialSection: 'texts' })
    expect(pane().textContent).not.toContain(NO_ACCESS)
    expect(pane().querySelector('h1')!.textContent).toBe('Call scripts')
    expect(railCurrent()).toBe('scripts')
    window.history.replaceState(null, '', '/?section=texts')
    await mount({ initialSection: undefined })
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
    await settle()
    expect(pane().querySelector('h1')!.textContent).toBe('Call scripts')
  })

  it('the three connection keys are not retired: they are real screens, owner-only by the predicate that gates Connections', () => {
    expect(HUB).toContain("const CONNECTION_SECTIONS = ownerConfig ? ['slack', 'jobber', 'mailchimp'] : []")
    expect(HUB).toContain("{ title:'Apps', items: ownerConfig ? [")
    expect(HUB).toContain('const sectionAllowed = sections.some(s => s.key === activeSection) || CONNECTION_SECTIONS.includes(activeSection)')
    const map = HUB.match(/const SETTINGS_RETIRED_SECTIONS = (\{[^}]+\})/)![1]
    for (const k of ['slack', 'jobber', 'mailchimp', 'connections', 'scripts']) expect(map, k).not.toContain(`${k}:`)
    expect(map).toContain("texts:'scripts'")
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · OWNER ONLY
// ═══════════════════════════════════════════════════════════════════════════
describe('a manager cannot reach Connections, or anything behind it', () => {
  for (const fr of ['manager', 'viewer', 'light', 'readonly', 'some-future-role']) {
    it(`${fr}: no Connections item, no Apps heading, and no Client messages`, async () => {
      await mount({ franchiseRole: fr, initialSection: 'profile' }, loc(ALL))
      for (const nav of [rail(), drill()]) {
        expect(nav.querySelector('[data-section="connections"]')).toBeNull()
        for (const k of ['slack', 'jobber', 'mailchimp', 'scripts', 'texting']) expect(nav.querySelector(`[data-section="${k}"]`), k).toBeNull()
        expect(nav.textContent).not.toMatch(/Apps|Connections|Client messages|Call scripts|Text messaging/)
      }
    })

    for (const key of ['connections', 'slack', 'jobber', 'mailchimp', 'scripts', 'texts', 'texting']) {
      it(`${fr} landing on '${key}': the no-access notice, no card, no connection screen, and Mailchimp is not asked about`, async () => {
        mcLive = false
        await mount({ franchiseRole: fr, initialSection: key }, loc(ALL))
        expect(pane().textContent).toContain(NO_ACCESS)
        expect(q('[data-connection]')).toBeNull()
        expect(q('[data-connections-banner]')).toBeNull()
        expect(q('[data-connections-back]')).toBeNull()
        expect(q('[data-section-closed]')).toBeNull()
        expect(pane().textContent).not.toMatch(/Reconnect Slack|Disconnect|Bee Organized Friends|Create Template/)
        expect(calls.filter(c => c.url.includes('/api/mailchimp') || c.url.includes('/api/templates/'))).toEqual([])
      })
    }
  }

  it('an owner (and so corporate and super admin, who arrive as owner) gets it', async () => {
    await mount({ franchiseRole: 'owner', isSuperAdmin: true, appRole: 'super_admin' }, loc(ALL))
    expect(summary()).toBe('3 connected · 2 coming soon')
    expect(rail().querySelector('[data-section="connections"]')!.textContent).toBe('Connections')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · TEXTS SPLIT IN TWO
// ═══════════════════════════════════════════════════════════════════════════
describe('Text messaging is greyed with the exact treatment Tags got', () => {
  it('the same item, built by the same branch: a div with a "Soon" chip, nothing to click', async () => {
    await mount({ initialSection: 'profile' })
    for (const nav of [rail(), drill()]) {
      const tags = nav.querySelector('[data-section="tags"]') as HTMLElement
      const texting = nav.querySelector('[data-section="texting"]') as HTMLElement
      expect(texting.tagName).toBe('DIV')
      expect(texting.hasAttribute('data-soon')).toBe(true)
      expect(texting.getAttribute('aria-disabled')).toBe('true')
      expect(texting.querySelector('button, a, [tabindex]')).toBeNull()
      // Identical markup once the name and the icon are taken out.
      const shape = (el: HTMLElement) => { const c = el.cloneNode(true) as HTMLElement; c.querySelectorAll('svg').forEach(s => s.remove()); return c.outerHTML.replace(/data-section="[^"]+"/, '').replace(/>(Tags|Text messaging)</, '><') }
      expect(shape(texting)).toBe(shape(tags))
      expect(texting.querySelector('[data-soon-chip]')!.textContent).toBe(tags.querySelector('[data-soon-chip]')!.textContent)
    }
    expect(rail().querySelector('[data-section="texting"] [data-soon-chip]')!.textContent).toBe('Soon')
    // One branch per nav draws a closed item; there is no second pattern.
    const shell = read('components/settings/SettingsShell.jsx')
    expect(shell.split('if (sec.soon) return (').length - 1).toBe(2)
    expect(HUB).toContain("{ key:'texting', label:'Text messaging', icon:'💬', soon:true },")
  })

  it('clicking it does nothing, and landing on it shows a short line — not a blank page and not the old preview', async () => {
    await mount({ initialSection: 'profile' })
    await click(rail().querySelector('[data-section="texting"]'))
    expect(q('[data-section-closed]')).toBeNull()
    await mount({ initialSection: 'texting' })
    const line = q('[data-section-closed="texting"]')!
    expect(line.textContent).toContain('Text messaging is on its way.')
    expect(line.textContent).toContain('Nothing is sent by text today')
    expect(pane().querySelector('h1')!.textContent).toBe('Text messaging')
    expect(railCurrent()).toBeUndefined()
    expect(pane().textContent).not.toContain('Not sending yet')
    // The Tags line still says its own thing.
    await mount({ initialSection: 'tags' })
    expect(q('[data-section-closed="tags"]')!.textContent).toContain('Tags are being rebuilt.')
  })

  it('the old texts preview is no longer mounted by Settings (the component still exists)', () => {
    expect(SETTINGS).not.toContain('<TextsComingSoon')
    expect(HUB).toContain('export function TextsComingSoon() {')
    expect(HUB.split('<TextsComingSoon').length - 1).toBe(0)
  })
})

// Call scripts moved into the new look in slice 5 (2026-11-13). Its create,
// edit and delete — still the same three routes — are clicked through in
// lib/settings-call-scripts.test.tsx. What stays here is slice 4's own claim:
// it is its own section, in the nav, apart from Text messaging.
describe('Call scripts is its own section', () => {
  it('it is in the nav as "Call scripts", and the page says scripts are not sent to anyone', async () => {
    await mount({ initialSection: 'scripts' })
    expect(rail().querySelector('[data-section="scripts"]')!.textContent).toBe('Call scripts')
    expect(railCurrent()).toBe('scripts')
    expect(pane().querySelector('h1')!.textContent).toBe('Call scripts')
    expect(pane().textContent).toContain('Nothing here is sent to anyone')
    expect(pane().querySelector('[data-call-scripts]')).toBeTruthy()
    expect(pane().textContent).not.toContain('Text messages')
    expect(pane().textContent).not.toContain('Email Templates')
  })
})
