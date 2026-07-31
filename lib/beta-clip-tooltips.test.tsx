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
// #136: the ContactLine leaf tests that used to sit here were retired with
// the component (dead since the tabbed-card unification). The LIVE #118
// guarantee is the 'Client card (ClientProfile)' describe: it mounts the
// surface a user actually reaches and asserts the title rides the clipped
// email/phone/address there (shared/ContactField + shared/AddressField).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'
import ClientProfile from '@/components/hive/ClientProfile'

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

// ── Client card (ClientProfile) — the LIVE #118 surface ─────────────────
// This is where Ankur's clipped email actually lives: ClientProfile Key
// Facts mounts shared/ContactField (phone/email) + shared/AddressField,
// whose value line is the ellipsized element (metaValueStyle). The first
// #118 pass put the title on ContactLine — a dead component, deleted in
// #136 — so these tests mount the card a user opens and assert the title is on
// the VALUE element itself. That placement is also the shadowing fix: the
// row keeps title="Edit email"/"Edit address" (the edit affordance), and
// in HTML the nearest titled ancestor wins — so the title must sit ON the
// value anchor/span for hover-over-the-clipped-text to show the value.
const LONG_STREET = '4471 Southwest Meadowbrook Crossing Boulevard Apartment 12B'
const clientCardPayload = () => ({
  client: {
    id: 'lead-9', name: 'Ankur Venkataraghavan', first_name: 'Ankur', last_name: 'Venkataraghavan',
    email: LONG_EMAIL, phone: LONG_PHONE,
    address: LONG_STREET, city: 'Palm Beach Gardens', state: 'FL', zip: '33418',
    created_at: new Date(now - 40 * 86400000).toISOString(), source: 'Webform', paused: false,
    marketing_opt_out: false, referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: null, location_name: 'Palm Beach',
  },
  referred_us: [], contacts: [], engagements: [],
  touchpoints: [], buzz_notes: [], job_notes: [],
  aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
})

describe('Client card (ClientProfile) — value tooltips on the live surface (#118)', () => {
  beforeEach(() => {
    ;(globalThis as any).fetch = vi.fn(async (url: any) => {
      const u = String(url)
      if (u.includes('/profile')) return { ok: true, status: 200, json: async () => clientCardPayload() }
      return { ok: true, status: 200, json: async () => ({}) }
    })
  })
  const mountCard = () => mount(<ClientProfile clientId="lead-9" onClose={() => {}} setToast={() => {}} />)

  it('the email row: the mailto anchor ITSELF carries title with the full email', async () => {
    const { host, unmount } = await mountCard()
    const anchor = host.querySelector('p[data-meta-row="email"] a[href^="mailto:"]') as HTMLElement
    expect(anchor).toBeTruthy()
    expect(anchor.textContent).toBe(LONG_EMAIL)
    expect(anchor.getAttribute('title')).toBe(LONG_EMAIL)
    await unmount()
  })

  it('the email value title WINS over the row\'s "Edit email" (nearest titled ancestor of the text is the anchor, not the wrapper)', async () => {
    const { host, unmount } = await mountCard()
    const anchor = host.querySelector('p[data-meta-row="email"] a[href^="mailto:"]') as HTMLElement
    // Hover resolution: the browser shows the title of the nearest
    // ancestor-or-self with one. The clipped text lives inside the anchor,
    // so the anchor must be that nearest titled element…
    expect(anchor.closest('[title]')).toBe(anchor)
    // …while the row wrapper keeps the edit affordance for the rest of
    // the row (icon / pencil / padding).
    expect(host.querySelector('p[data-meta-row="email"]')!.getAttribute('title')).toBe('Edit email')
    await unmount()
  })

  it('the phone row: the tel anchor carries title with the full phone', async () => {
    const { host, unmount } = await mountCard()
    const anchor = host.querySelector('p[data-meta-row="phone"] a[href^="tel:"]') as HTMLElement
    expect(anchor).toBeTruthy()
    expect(anchor.getAttribute('title')).toBe(LONG_PHONE)
    expect(anchor.closest('[title]')).toBe(anchor)
    await unmount()
  })

  it('the address row: the ellipsized value span carries title with the full display address', async () => {
    const { host, unmount } = await mountCard()
    const span = host.querySelector('p[data-meta-row="address"] span[title]') as HTMLElement
    expect(span).toBeTruthy()
    // title === exactly what the span shows (formatLeadAddress display),
    // and it holds the whole long street the row clips.
    expect(span.getAttribute('title')).toBe(span.textContent)
    expect(span.getAttribute('title')).toContain(LONG_STREET)
    expect(span.getAttribute('title')).toContain('33418')
    expect(span.closest('[title]')).toBe(span)
    await unmount()
  })
})
