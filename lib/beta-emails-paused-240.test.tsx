// @vitest-environment happy-dom
//
// Issue 240 step 9a — the paused state. Render only, no writes.
//
// The two blockers are taken from the SEND PATHS, not from the mockup:
//   missing_rate         lib/rate-guard.ts       — wording quotes the rate tag
//                                                  and the location has none
//   missing_booking_link lib/booking-link.ts     — TWO conditions: the
//                        per-assignee tag needs the OWNER's link, the two
//                        location aliases need the LOCATION's link
// Both are checked against the TEMPLATE TEXT, so step 8b's Edit can newly
// block or unblock a row. Every other unresolved tag renders as an empty
// string and sends anyway (applyVars), so it is deliberately not "paused".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { EmailsList, emailRowBlockers, blockedSentence } from '@/components/BeeHub'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const RATE = '{{rate_per_hour}}'
const OWNER_LINK = '{{owner_booking_link}}'
const LOC_LINK = '{{book_assessment_link}}'

const step = (order: number, subject: string, body: string) => ({
  id: `master_organizing-a_${order}`, order, type: 'email',
  delay_days: order === 1 ? 0 : order === 2 ? 5 : 30,
  subject, body, fromMaster: true,
})
const tpl = (o: any) => ({
  dbId: o.dbId, legacyId: o.legacyId ?? null, name: '', type: 'email',
  subject: o.subject, body: o.body, isActive: true,
  isMaster: !!o.isMaster, isOwnCustom: !!o.isOwnCustom,
  clonedFromId: o.clonedFromId ?? null, updatedAt: '2026-01-01',
})
const TEMPLATES = [
  tpl({ dbId: 't-welcome', legacyId: 'welcome', isMaster: true, subject: 'Welcome!', body: 'Welcome\n\nPlain.' }),
  tpl({ dbId: 't-3mo', legacyId: 'opp_closed_job_3mo', isMaster: true, subject: '3mo', body: '3mo\n\nPlain.' }),
  tpl({ dbId: 't-12mo', legacyId: 'opp_closed_job_12mo', isMaster: true, subject: '12mo', body: '12mo\n\nPlain.' }),
]
const ALL_SET = { ratePerHour: '95', ownerBookingLink: 'https://cal/me', locationCalendarLink: 'https://cal/loc' }

let container: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const mount = async (over: any = {}) => {
  const steps = over.steps ?? [step(1, 'One', 'One\n\nPlain body.'), step(2, 'Two', 'Two\n\nPlain body.'), step(3, 'Three', 'Three\n\nPlain body.')]
  const props = {
    pathSteps: { 'organizing-a': steps }, masterSteps: { 'organizing-a': steps },
    templates: TEMPLATES, generalDefault: 'organizing-a', moveDefault: 'organizing-a',
    actions: { edit: vi.fn(), reset: vi.fn() }, sendConfig: ALL_SET,
    ...over,
  }
  delete (props as any).steps
  await act(async () => { root.render(<EmailsList {...props} />) })
  return props
}
const pausedBadges = () => Array.from(container.querySelectorAll('span')).filter(s => s.textContent === 'Paused')
const text = () => container.textContent ?? ''

// ─────────────── the enumeration, as a pure function ───────────────
describe('what actually blocks a send', () => {
  const row = (body: string) => ({ subject: 'S', body })

  it('the rate tag blocks only when the location has no rate', () => {
    expect(emailRowBlockers(row(`Our rate is ${RATE}.`), { ...ALL_SET, ratePerHour: '' }))
      .toEqual(['it mentions your hourly rate, and we don’t have that yet'])
    expect(emailRowBlockers(row(`Our rate is ${RATE}.`), ALL_SET)).toEqual([])
  })

  it('the per-assignee tag needs the OWNER link, not the location one', () => {
    const cfg = { ...ALL_SET, ownerBookingLink: '' }
    expect(emailRowBlockers(row(`Book here: ${OWNER_LINK}`), cfg).length).toBe(1)
    // A location link set does NOT satisfy the owner tag — the guard checks
    // the two families separately.
    expect(emailRowBlockers(row(`Book here: ${OWNER_LINK}`), cfg)[0]).toContain('your own booking link')
  })

  it('the location aliases need the LOCATION link, not the owner one', () => {
    const cfg = { ...ALL_SET, locationCalendarLink: '' }
    expect(emailRowBlockers(row(`Book here: ${LOC_LINK}`), cfg).length).toBe(1)
    expect(emailRowBlockers(row(`Book here: ${LOC_LINK}`), cfg)[0]).toContain('your booking link')
  })

  it('a row with no guarded tag is never blocked, however much is unset', () => {
    expect(emailRowBlockers(row('Hi {{first_name}}, plain text.'), { ratePerHour: '', ownerBookingLink: '', locationCalendarLink: '' }))
      .toEqual([])
  })

  it('an unguarded tag is NOT a blocker — it renders blank and sends anyway', () => {
    // applyVars returns '' for null/undefined; nothing is held.
    expect(emailRowBlockers(row('Call {{location_phone}} or see {{reviews_link}}.'), { ratePerHour: '', ownerBookingLink: '', locationCalendarLink: '' }))
      .toEqual([])
  })

  it('a row can trip more than one, and they read as one sentence', () => {
    const reasons = emailRowBlockers(row(`${RATE} and ${OWNER_LINK}`), { ratePerHour: '', ownerBookingLink: '', locationCalendarLink: '' })
    expect(reasons.length).toBe(2)
    expect(blockedSentence(reasons)).toContain('; and ')
  })

  it('the subject counts too, not just the body', () => {
    expect(emailRowBlockers({ subject: `Rates from ${RATE}`, body: 'Plain.' }, { ...ALL_SET, ratePerHour: '' }).length).toBe(1)
  })
})

// ─────────────── the render ───────────────
describe('a blocked row is dimmed and says why', () => {
  it('renders the badge and the reason', async () => {
    await mount({
      steps: [step(1, 'One', `Our rate is ${RATE}.`), step(2, 'Two', 'Plain.'), step(3, 'Three', 'Plain.')],
      sendConfig: { ...ALL_SET, ratePerHour: '' },
    })
    expect(pausedBadges().length).toBe(1)
    expect(text()).toContain('Not sending — it mentions your hourly rate')
  })

  it('still shows the wording — paused, not hidden', async () => {
    await mount({
      steps: [step(1, 'One', `Our rate is ${RATE}.\n\nSecond line survives.`), step(2, 'Two', 'Plain.'), step(3, 'Three', 'Plain.')],
      sendConfig: { ...ALL_SET, ratePerHour: '' },
    })
    expect(text()).toContain('Second line survives')
    expect(Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'Read').length).toBe(5)  // issue 314: was 6
  })

  it('an unblocked row renders normally', async () => {
    await mount()
    expect(pausedBadges().length).toBe(0)
    expect(text()).not.toContain('Not sending')
  })

  it('nothing is ever dimmed silently — a badge always has a reason beside it', async () => {
    await mount({
      steps: [step(1, 'One', `${RATE} ${OWNER_LINK}`), step(2, 'Two', 'Plain.'), step(3, 'Three', 'Plain.')],
      sendConfig: { ratePerHour: '', ownerBookingLink: '', locationCalendarLink: '' },
    })
    expect(pausedBadges().length).toBe(1)
    expect(text()).toContain('Not sending —')
  })

  it('the reason is owner language — no field names, routes, or null', async () => {
    await mount({
      steps: [step(1, 'One', `${RATE} ${OWNER_LINK} ${LOC_LINK}`), step(2, 'Two', 'Plain.'), step(3, 'Three', 'Plain.')],
      sendConfig: { ratePerHour: '', ownerBookingLink: '', locationCalendarLink: '' },
    })
    // Scoped to the REASON sentence. The row also renders the owner's own
    // wording, which legitimately contains {{merge_tags}} — step 7 shows those
    // raw on purpose. Asserting over the whole row would test the fixture's
    // body, not the language we wrote.
    const reasons = Array.from(container.querySelectorAll('p'))
      .map(el => el.textContent ?? '')
      .filter(t => t.startsWith('Not sending —'))
    expect(reasons.length, 'a reason is present').toBeGreaterThan(0)
    for (const t of reasons) {
      for (const banned of ['rate_per_hour', 'booking_link', 'calendar_link', 'null', 'undefined', '/api/', '{{', 'location_uuid', 'is_active']) {
        expect(t, `must not leak "${banned}"`).not.toContain(banned)
      }
    }
  })

  it('a stage row is blocked by the same rule as a drip row', async () => {
    const withRate = [
      TEMPLATES[0],
      tpl({ dbId: 't-3mo', legacyId: 'opp_closed_job_3mo', isMaster: true, subject: '3mo', body: `Rate ${RATE}\n\nPlain.` }),
      TEMPLATES[2],
    ]
    await mount({ templates: withRate, sendConfig: { ...ALL_SET, ratePerHour: '' } })
    expect(pausedBadges().length).toBe(1)
  })
})

describe('a pause and a disabled reset are independent', () => {
  it('both reasons show; neither suppresses the other', async () => {
    // A forked, drifted path (reset disabled) whose row ALSO quotes the rate.
    const forked = [
      { ...step(1, 'One', `Our rate is ${RATE}.`), fromMaster: false, dbId: 'db1' },
      { ...step(2, 'Two', 'Plain.'), fromMaster: false, dbId: 'db2' },
      { ...step(3, 'Three', 'Plain.'), fromMaster: false, dbId: 'db3' },
      { ...step(4, 'Four', 'Plain.'), fromMaster: false, dbId: 'db4' },   // drift
    ]
    await mount({
      pathSteps: { 'organizing-a': forked },
      masterSteps: { 'organizing-a': [step(1, 'One', 'x'), step(2, 'Two', 'x'), step(3, 'Three', 'x')] },
      sendConfig: { ...ALL_SET, ratePerHour: '' },
    })
    // The row is paused on the list.
    expect(pausedBadges().length).toBe(1)
    // And inside, BOTH sentences appear.
    await act(async () => {
      (Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'Read')[0]).click()
    })
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Not sending —')
    expect(dialog.textContent).toContain("Can't undo this —")
  })
})

describe('no add affordance, still', () => {
  it('offers no way to add or delete a row', async () => {
    await mount()
    const labels = Array.from(container.querySelectorAll('button')).map(b => b.textContent?.trim() ?? '')
    for (const banned of ['+ Add another email', 'Add another email', '＋ Add another email', 'Delete', 'Remove', '+ Add step']) {
      expect(labels, `must not offer "${banned}"`).not.toContain(banned)
    }
  })
})
