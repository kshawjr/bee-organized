// @vitest-environment happy-dom
// Clipped-value tooltips (#118) — every list/card row that truncates a
// user-supplied value with an ellipsis must carry a title attribute holding
// the FULL value, so hover reveals what the one-line clip hides.
//
// Background: the classic-list tooltip fix (245e74d, #116 audit) rode rows
// that were retired 7/18. On the current Hive UI the affordance was gone, so
// Ankur's clipped-email report (feedback 91561149) came back. The idiom we
// reuse is #68's title={jobDetail} on the Inbox request-details line.
//
// The RULE these tests pin (chosen deliberately):
//   · whenever a real value is present, title carries the FULL value —
//     unconditionally, long OR short. We do not measure truncation (no JS
//     idiom for it in this codebase; #68 set title={jobDetail} regardless of
//     length). A tooltip echoing a fully-visible short value is harmless.
//   · empty / placeholder states carry NO title (a tooltip on "No buzz yet"
//     or an absent contact is noise) — matches #68's bare placeholder.
//
// These mount the SHARED leaf ContactLine (behind the board card, the list
// row, and the panel client strip — so one component is the email+phone
// surface everywhere) plus the Inbox list row (name) and a #68 regression
// guard.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ContactLine from '@/components/hive/ContactLine'
import InboxScreen from '@/components/hive/InboxScreen'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

// A value long enough to clip in any real row.
const LONG_EMAIL = 'ankur.venkataraghavan.palmbeach.franchise@a-very-long-domain-name.example.com'
const LONG_PHONE = '+1 (561) 555-0199 ext. 4471 — call before 5pm ET please'

// The value span carries both the visible text and the title.
const titledSpanWithText = (host: Element, text: string) =>
  [...host.querySelectorAll('span[title]')].find(s => (s.textContent || '') === text) as HTMLElement | undefined

describe('ContactLine — email/phone tooltips (#118)', () => {
  it('a long email in a row → title present with the full value', async () => {
    const { host, unmount } = await mount(<ContactLine email={LONG_EMAIL} />)
    const span = titledSpanWithText(host, LONG_EMAIL)
    expect(span).toBeTruthy()
    expect(span!.getAttribute('title')).toBe(LONG_EMAIL)
    // The mailto link is the host — confirms it is the EMAIL surface.
    expect(host.querySelector('a[href^="mailto:"]')).toBeTruthy()
    await unmount()
  })

  it('a long phone → title present with the full value', async () => {
    const { host, unmount } = await mount(<ContactLine phone={LONG_PHONE} />)
    const span = titledSpanWithText(host, LONG_PHONE)
    expect(span?.getAttribute('title')).toBe(LONG_PHONE)
    expect(host.querySelector('a[href^="tel:"]')).toBeTruthy()
    await unmount()
  })

  it('a SHORT email → still renders, title present and equal to the value (rule: title always carries a present value)', async () => {
    const short = 'a@b.co'
    const { host, unmount } = await mount(<ContactLine email={short} />)
    const span = titledSpanWithText(host, short)
    expect(span?.getAttribute('title')).toBe(short)
    await unmount()
  })

  it('email only → renders the email surface and no phone surface', async () => {
    const { host, unmount } = await mount(<ContactLine email={LONG_EMAIL} />)
    expect(host.querySelector('a[href^="mailto:"]')).toBeTruthy()
    expect(host.querySelector('a[href^="tel:"]')).toBeNull()
    await unmount()
  })

  it('no phone and no email → renders nothing (no stray titled node, no crash)', async () => {
    const { host, unmount } = await mount(<ContactLine />)
    expect(host.querySelector('span[title]')).toBeNull()
    expect(host.textContent).toBe('')
    await unmount()
  })

  it('inline layout (wide panel strip) carries the same title', async () => {
    const { host, unmount } = await mount(<ContactLine email={LONG_EMAIL} phone={LONG_PHONE} layout="inline" />)
    expect(titledSpanWithText(host, LONG_EMAIL)?.getAttribute('title')).toBe(LONG_EMAIL)
    expect(titledSpanWithText(host, LONG_PHONE)?.getAttribute('title')).toBe(LONG_PHONE)
    await unmount()
  })
})

// ── Inbox list row: name clips silently; title must carry the full name.
;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
const now = Date.now()
let seq = 0
const person = (over: any = {}) => ({
  id: `p-${++seq}`,
  name: `Lead ${seq}`,
  email: 'lead@email.com',
  phone: '(561) 555-0199',
  locationId: 'loc-uuid-1',
  created: new Date(now - 3 * 86400000).toISOString(),
  isJunk: false,
  snoozeUntil: null,
  inboxDismissedAt: null,
  jobberRef: null,
  outreachTimeline: [],
  ...over,
})
const inbox = (people: any[], over: any = {}) => (
  <InboxScreen people={people} engagements={[]} locFilter="all" setToast={() => {}} {...over} />
)
const rowByText = (host: Element, text: string) =>
  [...host.querySelectorAll('.bee-inbox-row')].find(r => (r.textContent || '').includes(text))!

describe('Inbox list row — name tooltip (#118)', () => {
  beforeEach(() => { ;(globalThis as any).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })) })

  it('a long name in a list row → the name element carries title with the full name', async () => {
    const LONG_NAME = 'Ankur Venkataraghavan-Chandrasekharan of Palm Beach Gardens Estates LLC'
    const { host, unmount } = await mount(inbox([person({ name: LONG_NAME })]))
    const row = rowByText(host, LONG_NAME)
    const nameEl = [...row.querySelectorAll('[title]')].find(el => (el.textContent || '') === LONG_NAME) as HTMLElement
    expect(nameEl).toBeTruthy()
    expect(nameEl.getAttribute('title')).toBe(LONG_NAME)
    await unmount()
  })

  it('a short name → still renders, title present and equal to the value', async () => {
    const { host, unmount } = await mount(inbox([person({ name: 'Jo Ng' })]))
    const row = rowByText(host, 'Jo Ng')
    const nameEl = [...row.querySelectorAll('[title]')].find(el => (el.textContent || '') === 'Jo Ng') as HTMLElement
    expect(nameEl?.getAttribute('title')).toBe('Jo Ng')
    await unmount()
  })

  it('regression: the #68 request-details line keeps its title', async () => {
    const DETAIL = 'Full-home declutter and garage reset before a move-out on the 14th, two-story house'
    const { host, unmount } = await mount(inbox([person({ jobDetail: DETAIL })]))
    const titled = [...host.querySelectorAll('.bee-inbox-detail[title]')]
    // At least the populated detail line carries its full value.
    expect(titled.some(el => el.getAttribute('title') === DETAIL)).toBe(true)
    await unmount()
  })
})
