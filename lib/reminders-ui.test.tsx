// @vitest-environment happy-dom
//
// Reminders — what owners see. The REAL record cards are mounted (not the
// strip on its own), against a fake /api/reminders that behaves like the
// real one (the server half is pinned in reminders-api.test.ts).
//
//   A) On each record kind — a lead, a client, an engagement, a Network
//      person — a reminder sets in three taps (Tomorrow / Next week / pick,
//      a line, Done) and the record then shows "Reminder: <note>" with its
//      day under the name. The door is the gold bell in the bottom action
//      bar (client, engagement) AND "Set a reminder" in the ··· menu (all
//      four); both open the same setter and save the same thing. Nothing
//      floats under the name when there is no reminder.
//   E) The action bar at every child count, desktop (one row, bell at the
//      end) and phone (two columns, bell last); the other actions still
//      work beside it.
//   B) Home: nothing when nothing is due; today's on its day (not before);
//      overdue ones ABOVE today's, in amber; sits at the top of Home.
//   C) The Reminders page: soonest first with the person's name and the
//      note; tick finishes, pencil changes the date, X deletes; the name
//      opens the record. In the sidebar, with its own address.
//   D) The browser never sends an owner — the server decides it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'
import EngagementPanel from '@/components/hive/EngagementPanel'
import NetworkPersonRecord from '@/components/hive/NetworkPersonRecord'
import RemindersScreen, { HomeReminders } from '@/components/hive/RemindersScreen'
import { T } from '@/components/hive/shared/tokens'
import { ROUTE_TO_NAV, NAV_TO_URL, NAV_TO_SCREEN, parseHubUrl } from '@/components/hive/shared/hubUrl'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

// Wednesday 30 Sep 2026, midday local.
const WED = new Date(2026, 8, 30, 12, 0, 0)
const setDay = (d: Date) => vi.setSystemTime(d)

// ── fake /api/reminders (+ the record routes the cards load) ─────────
let rows: any[] = []
let seq = 0
let calls: Array<{ url: string; method: string; body: any }> = []
const NAMES: Record<string, string> = { 'lead-new': 'Nora New', 'lead-9': 'Dana Client', p1: 'Karen Martinez' }
const named = (r: any) => ({
  ...r,
  record_type: r.lead_id ? 'client' : r.engagement_id ? 'engagement' : 'network',
  record_name: r.lead_id ? NAMES[r.lead_id] : r.engagement_id ? 'Dana Client · Kitchen + Pantry' : NAMES[r.partner_id],
  client_id: r.lead_id || (r.engagement_id ? 'lead-9' : null),
})
const seed = (r: any) => { const row = { id: `r${++seq}`, user_id: 'me', lead_id: null, engagement_id: null, partner_id: null, done_at: null, created_at: `2026-09-2${seq}T00:00:00Z`, ...r }; rows.push(row); return row }
const res = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })

const now = Date.now()
const profileBody = (stage: string, id: string, name: string) => ({
  client: {
    id, name, first_name: name.split(' ')[0], last_name: name.split(' ')[1], stage,
    email: 'x@x.com', phone: null, address: null, city: null, state: null, zip: null,
    created_at: new Date(now - 400 * 86400000).toISOString(), source: 'Webform', paused: false, marketing_opt_out: false,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: 'Client', location_name: 'Denver',
  },
  referred_us: [], contacts: [], engagements: [], touchpoints: [], buzz_notes: [], job_notes: [],
  aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
})
const engBody = {
  engagement: {
    id: 'eng-1', title: 'Kitchen + Pantry', stage: 'Request', founded_by: 'manual',
    created_at: new Date(now - 30 * 86400000).toISOString(), stage_entered_at: null, location_uuid: 'loc-1',
    project_type: 'Client', description: null, closed_at: null, closed_reason: null, closed_note: null,
    total_invoiced: 0, total_paid: 0, balance_owing: 0,
  },
  children: { service_requests: [], assessments: [], quotes: [], jobs: [], invoices: [], notes: [], touchpoints: [] },
  client: {
    id: 'lead-9', name: 'Dana Client', email: null, phone: null, address: null, city: null, state: null, zip: null,
    request_details: null, source: 'Webform', referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    buzz: [], lifetime_paid: 0, prior_engagements: 0, other_open: 0,
  },
}
let profile: any = profileBody('New', 'lead-new', 'Nora New')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  setDay(WED)
  rows = []; seq = 0; calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: any, init: any = {}) => {
    const url = String(input)
    const method = (init.method || 'GET').toUpperCase()
    const body = init.body ? JSON.parse(init.body) : null
    calls.push({ url, method, body })
    if (url.startsWith('/api/reminders')) {
      const [path, qs] = url.split('?')
      const id = path.split('/')[3]
      if (method === 'GET') {
        const q = new URLSearchParams(qs || '')
        const list = rows.filter(r => !r.done_at && [...q.entries()].every(([k, v]) => r[k] === v))
          .sort((a, b) => a.due_on.localeCompare(b.due_on))
        return res({ reminders: list.map(named) })
      }
      if (method === 'POST') return res({ reminder: named(seed({ ...body })) }, 201)
      const row = rows.find(r => r.id === id)
      if (!row) return res({ error: 'reminder_not_found' }, 404)
      if (method === 'PATCH') {
        if (body.done) row.done_at = '2026-09-30T12:00:00Z'
        if (body.due_on) row.due_on = body.due_on
        if (body.note) row.note = body.note
        return res({ reminder: named(row) })
      }
      if (method === 'DELETE') { rows = rows.filter(r => r !== row); return res({ ok: true }) }
    }
    if (url.includes('/api/engagements/')) return res(engBody)
    if (url.includes('/profile')) return res(profile)
    if (url.includes('/referrals')) return res({ partner: { id: 'p1' }, referred: [], totals: { count: 0, converted: 0, revenue: 0 }, total: 0 })
    if (url.includes('/timeline')) return res({ touchpoints: [] })
    return res({})
  }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

// ── DOM helpers ──────────────────────────────────────────────
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => {})
  await act(async () => {})
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element | null | undefined) => act(async () => {
  if (!el) throw new Error('nothing to click')
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const byText = (root: Element, text: string) =>
  [...root.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)
const type = (input: HTMLInputElement, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const strip = (host: Element) => host.querySelector('[data-testid="record-reminder"]') as HTMLElement
const setterEl = () => document.querySelector('[data-testid="reminder-setter"]') as HTMLElement

const PARTNER = {
  id: 'p1', name: 'Karen Martinez', type: 'partner', locationId: 'loc-1', title: 'Agent', company: 'Meridian Realty', companyId: null,
  phone: '', email: '', website: '', specialties: [], stage: 'Building', tags: [], lastContactedAt: null,
  isCustomer: false, customerLeadId: null, addresses: [], notes: [], referrals: [], activity: [], isDeleted: false,
  nextSteps: [{ id: 'ns1', text: 'Old next step', date: '2026-09-01', done: false }],
}

// hasBar: the card has a bottom action bar (client + engagement). The
// Network person has none, so its door is the ··· menu alone.
const RECORDS = [
  { label: 'a lead (New)', key: 'lead_id', id: 'lead-new', hasBar: true, menu: 'More',
    render: () => { profile = profileBody('New', 'lead-new', 'Nora New'); return <ClientProfile clientId="lead-new" people={[]} onClose={() => {}} setToast={() => {}} lookupOptions={{ sources: [], projectTypes: [] }} /> } },
  { label: 'a client', key: 'lead_id', id: 'lead-9', hasBar: true, menu: 'More',
    render: () => { profile = profileBody('Active', 'lead-9', 'Dana Client'); return <ClientProfile clientId="lead-9" people={[]} onClose={() => {}} setToast={() => {}} lookupOptions={{ sources: [], projectTypes: [] }} /> } },
  { label: 'an engagement', key: 'engagement_id', id: 'eng-1', hasBar: true, menu: 'Engagement actions',
    render: () => <EngagementPanel engagementId="eng-1" people={[]} onClose={() => {}} setToast={() => {}} lookupOptions={{ sources: [], projectTypes: [] }} /> },
  { label: 'a Network person', key: 'partner_id', id: 'p1', hasBar: false, menu: 'Partner actions',
    render: () => <NetworkPersonRecord partner={PARTNER} companies={[]} people={[]} /> },
]

// The ··· menu's "Set a reminder" — CardMenu (client) renders in place,
// RecordMenu (engagement, Network) portals to the body; search the document.
const menuReminderItem = async (host: Element, rec: any) => {
  await click(host.querySelector(`[aria-label="${rec.menu}"]`))
  return [...document.querySelectorAll('button, [role="menuitem"]')].find(b => (b.textContent || '').trim() === 'Set a reminder') as HTMLElement | undefined
}
const openSetter = async (host: Element, rec: any, via: 'bar' | 'menu') => {
  if (via === 'bar') await click(host.querySelector('[data-testid="reminder-button"]'))
  else await click(await menuReminderItem(host, rec))
}
const fillAndSave = async (when: string, note: string) => {
  await click(byText(setterEl(), when))
  await type(setterEl().querySelector('input[aria-label="What is this reminder for?"]') as HTMLInputElement, note)
  await click(byText(setterEl(), 'Done'))
}

// ── A) every record ──────────────────────────────────────────
describe('A) reminders on every record', () => {
  for (const rec of RECORDS) {
    it(`${rec.label}: an existing reminder shows under the name on open`, async () => {
      seed({ [rec.key]: rec.id, due_on: '2026-10-06', note: 'call about the garage' })
      const { host } = await mount(rec.render())
      const s = strip(host)
      expect(s).toBeTruthy()
      expect(s.textContent).toContain('Reminder: call about the garage')
      expect(s.textContent).toContain('Tuesday')
      // Asked only for THIS record's reminders.
      expect(calls.some(c => c.method === 'GET' && c.url === `/api/reminders?${rec.key}=${rec.id}`)).toBe(true)
    })

    it(`${rec.label}: nothing floats under the name when there is no reminder`, async () => {
      const { host } = await mount(rec.render())
      expect(strip(host)).toBeNull()
      const btn = host.querySelector('[data-testid="reminder-button"]')
      if (rec.hasBar) {
        // …the button lives in the pinned bottom action bar, and ONLY there.
        expect(host.querySelectorAll('[data-testid="reminder-button"]')).toHaveLength(1)
        expect(btn!.closest('[data-testid="card-action-bar"]')).toBeTruthy()
        expect(btn!.closest('[data-testid="record-reminder"]')).toBeNull()
      } else {
        // No bar on this card → no free-standing button at all.
        expect(btn).toBeNull()
      }
    })

    it(`${rec.label}: "Set a reminder" is in the ··· menu`, async () => {
      const { host } = await mount(rec.render())
      expect(await menuReminderItem(host, rec)).toBeTruthy()
    })

    it(`${rec.label}: three taps — Tomorrow, a line, Done`, async () => {
      const { host } = await mount(rec.render())
      await openSetter(host, rec, rec.hasBar ? 'bar' : 'menu')
      await fillAndSave('Tomorrow', 'send the quote')
      const post = calls.find(c => c.method === 'POST')!
      expect(post.body).toEqual({ [rec.key]: rec.id, due_on: '2026-10-01', note: 'send the quote' })
      expect(strip(host).textContent).toContain('Reminder: send the quote')
      expect(strip(host).textContent).toContain('Tomorrow')
      expect(setterEl()).toBeNull()
    })
  }

  for (const rec of RECORDS.filter(r => r.hasBar)) {
    it(`${rec.label}: the bar and the ··· menu do the SAME thing`, async () => {
      const fromBar = await mount(rec.render())
      await openSetter(fromBar.host, rec, 'bar')
      // The setter opens in the pinned bar, above the buttons.
      expect(setterEl().closest('[data-testid="reminder-setter-panel"]')).toBeTruthy()
      await fillAndSave('Next week', 'chase deposit')
      const barPost = calls.filter(c => c.method === 'POST')
      const barText = strip(fromBar.host).textContent
      await fromBar.unmount()

      rows = []; calls = []
      const fromMenu = await mount(rec.render())
      await openSetter(fromMenu.host, rec, 'menu')
      expect(setterEl().closest('[data-testid="reminder-setter-panel"]')).toBeTruthy() // same place
      await fillAndSave('Next week', 'chase deposit')
      const menuPost = calls.filter(c => c.method === 'POST')

      expect(barPost).toHaveLength(1)
      expect(menuPost).toEqual(barPost)
      expect(strip(fromMenu.host).textContent).toBe(barText)
    })
  }

  it('the bar button is gold (brand gold tokens), not the teal accent of Call / Send to Jobber', async () => {
    const { host } = await mount(RECORDS[1].render())
    const btn = host.querySelector('[data-testid="reminder-button"]') as HTMLElement
    const norm = (v: string) => { const d = document.createElement('div'); d.style.color = v; return d.style.color }
    expect(btn.style.background).toBe(norm(T.brand.goldSoft))
    expect(btn.style.color).toBe(norm(T.brand.goldText))
    expect(btn.style.background).not.toBe(norm(T.accent.soft))
    expect(btn.textContent).toContain('Reminder')
    expect(btn.getAttribute('aria-label')).toBe('Set a reminder')
  })

  it('Next week is seven days on; Pick a date takes any day; Done waits for a date AND a line', async () => {
    const { host } = await mount(RECORDS[0].render())
    await openSetter(host, RECORDS[0], 'bar')
    const s = setterEl()
    const done = () => byText(s, 'Done') as HTMLButtonElement
    expect(done().disabled).toBe(true)
    await click(byText(s, 'Next week'))
    expect(done().disabled).toBe(true) // no line yet
    await type(s.querySelector('input[aria-label="What is this reminder for?"]') as HTMLInputElement, 'chase deposit')
    expect(done().disabled).toBe(false)
    await click(byText(s, 'Pick a date'))
    expect(done().disabled).toBe(true) // picking cleared the quick pick
    await type(s.querySelector('input[aria-label="Reminder date"]') as HTMLInputElement, '2026-11-12')
    await click(done())
    expect(calls.find(c => c.method === 'POST')!.body.due_on).toBe('2026-11-12')
  })

  it('pressing the bell again (or Cancel) closes the setter without saving', async () => {
    const { host } = await mount(RECORDS[1].render())
    await openSetter(host, RECORDS[1], 'bar')
    expect(setterEl()).toBeTruthy()
    await click(host.querySelector('[data-testid="reminder-button"]'))
    expect(setterEl()).toBeNull()
    await openSetter(host, RECORDS[1], 'bar')
    await click(byText(setterEl(), 'Cancel'))
    expect(setterEl()).toBeNull()
    expect(calls.some(c => c.method === 'POST')).toBe(false)
  })

  it("the Network person's old What's next section is gone — Reminders replaced it", async () => {
    const { host } = await mount(RECORDS[3].render())
    expect(host.querySelector('[data-testid="next-steps"]')).toBeNull()
    expect(host.textContent).not.toContain('What’s next')
    expect(host.textContent).not.toContain('Old next step')
  })
})

// ── E) the action bar at every child count ───────────────────
// The real ClientProfile bar, desktop and phone. `kids` = the actions other
// than the bell. Desktop: one row, kids in equal columns, bell last at its
// own width. Phone: a two-column grid, bell as the last cell.
describe('E) the action bar lays out at every child count, and the other actions still work', () => {
  const LINKED = 'Z2lkOi8vSm9iYmVyL0NsaWVudC8x'
  const CASES = [
    { name: 'Call + Log + Send', over: { phone: '555-0100' }, props: {}, kids: ['Call', 'Log touchpoint', 'Send to Jobber'] },
    { name: 'Call + Log + Open in Jobber', over: { phone: '555-0100', jobber_client_id: LINKED }, props: {}, kids: ['Call', 'Log touchpoint', 'Open in Jobber'] },
    { name: 'Log + Send (no phone)', over: {}, props: {}, kids: ['Log touchpoint', 'Send to Jobber'] },
    { name: 'Call + Open (read-only)', over: { phone: '555-0100', jobber_client_id: LINKED }, props: { readOnly: true }, kids: ['Call', 'Open in Jobber'] },
    { name: 'Open only (read-only, no phone)', over: { jobber_client_id: LINKED }, props: { readOnly: true }, kids: ['Open in Jobber'] },
    { name: 'loc_other: Transfer', over: { location_id: 'loc_other', phone: '555-0100' }, props: {}, kids: ['Transfer'] },
    { name: 'nothing but the bell (read-only, no phone, not linked)', over: {}, props: { readOnly: true }, kids: [] },
  ]
  const mountCase = async (c: any, width: number, onSendToJobber = vi.fn()) => {
    ;(globalThis as any).__BEE_TEST_WIDTH__ = width
    ;(window as any).innerWidth = width
    profile = profileBody('New', 'lead-new', 'Nora New')
    Object.assign(profile.client, c.over)
    const m = await mount(<ClientProfile clientId="lead-new" people={[]} onClose={() => {}} setToast={() => {}} onSendToJobber={onSendToJobber} lookupOptions={{ sources: [], projectTypes: [] }} {...c.props} />)
    return { ...m, onSendToJobber }
  }
  const layout = (host: Element) => host.querySelector('[data-testid="card-action-bar"] > [data-action-layout]') as HTMLElement
  const labels = (els: Element[]) => els.map(e => (e.textContent || '').trim())
  afterEach(() => { (globalThis as any).__BEE_TEST_WIDTH__ = 1200; (window as any).innerWidth = 1200 })

  for (const c of CASES) {
    it(`desktop · ${c.name}: kids in ${c.kids.length || 'no'} equal column(s), bell at the end`, async () => {
      const { host } = await mountCase(c, 1200)
      const row = layout(host)
      expect(row.dataset.actionLayout).toBe('row')
      const [first, ...rest] = [...row.children] as HTMLElement[]
      const bell = row.lastElementChild as HTMLElement
      expect(bell.dataset.testid).toBe('reminder-button')
      if (c.kids.length) {
        expect(first.style.gridTemplateColumns).toBe(`repeat(${c.kids.length}, 1fr)`)
        expect(labels([...first.children])).toEqual(c.kids)
        expect(rest).toHaveLength(1) // the grid, then the bell — nothing else
      } else {
        expect(first.children).toHaveLength(0) // spacer: the bell still sits at the end
      }
    })

    it(`phone · ${c.name}: two-column grid, bell as the last cell`, async () => {
      const { host } = await mountCase(c, 375)
      const grid = layout(host)
      expect(grid.dataset.actionLayout).toBe('two-column')
      const cells = [...grid.children] as HTMLElement[]
      expect(grid.style.gridTemplateColumns).toBe(`repeat(${Math.min(2, c.kids.length + 1)}, minmax(0, 1fr))`)
      expect(labels(cells.slice(0, -1))).toEqual(c.kids)
      expect(cells[cells.length - 1].dataset.testid).toBe('reminder-button')
      expect(cells[cells.length - 1].textContent).toContain('Reminder') // word shown on phones too
    })
  }

  it('Call dials, Log touchpoint opens its window, Send to Jobber sends — with the bell beside them', async () => {
    const { host, onSendToJobber } = await mountCase(CASES[0], 1200)
    const row = layout(host)
    const call = [...row.querySelectorAll('a')].find(a => a.textContent!.includes('Call')) as HTMLAnchorElement
    expect(call.getAttribute('href')).toBe('tel:555-0100')
    await click(byText(row, 'Log touchpoint'))
    expect(document.querySelector('[aria-label="Log touchpoint"][role="dialog"], [aria-label="Log touchpoint"]:not(button)')).toBeTruthy()
    await click([...row.querySelectorAll('button')].find(b => b.textContent!.includes('Send to Jobber')))
    expect(onSendToJobber).toHaveBeenCalledWith('lead-new')
  })

  it('Open in Jobber still links out; Transfer still opens its window on loc_other', async () => {
    const linked = await mountCase(CASES[1], 1200)
    const open = [...layout(linked.host).querySelectorAll('a')].find(a => a.textContent!.includes('Open in Jobber')) as HTMLAnchorElement
    expect(open.getAttribute('href')).toContain('secure.getjobber.com')
    await linked.unmount()
    const other = await mountCase(CASES[5], 1200)
    await click([...layout(other.host).querySelectorAll('button')].find(b => b.textContent!.includes('Transfer')))
    expect(document.querySelector('[aria-label="Transfer lead"]')).toBeTruthy()
  })

  it('the engagement bar carries the bell the same way', async () => {
    ;(globalThis as any).__BEE_TEST_WIDTH__ = 375; (window as any).innerWidth = 375
    const phone = await mount(RECORDS[2].render())
    expect(layout(phone.host).dataset.actionLayout).toBe('two-column')
    expect((layout(phone.host).lastElementChild as HTMLElement).dataset.testid).toBe('reminder-button')
    await phone.unmount()
    ;(globalThis as any).__BEE_TEST_WIDTH__ = 1200; (window as any).innerWidth = 1200
    const desk = await mount(RECORDS[2].render())
    expect(layout(desk.host).dataset.actionLayout).toBe('row')
    expect((layout(desk.host).lastElementChild as HTMLElement).dataset.testid).toBe('reminder-button')
  })
})

// ── B) Home ──────────────────────────────────────────────────
describe('B) Home', () => {
  it('shows nothing when nothing is due today or earlier', async () => {
    seed({ lead_id: 'lead-new', due_on: '2026-10-01', note: 'tomorrow thing' })
    const { host } = await mount(<HomeReminders />)
    expect(host.querySelector('[data-testid="home-reminders"]')).toBeNull()
  })

  it('a reminder appears on its due day, not before', async () => {
    seed({ lead_id: 'lead-new', due_on: '2026-10-01', note: 'call about the garage' })
    const before = await mount(<HomeReminders />)
    expect(before.host.textContent).not.toContain('call about the garage')
    await before.unmount()

    setDay(new Date(2026, 9, 1, 8, 0, 0)) // Thursday morning
    const onDay = await mount(<HomeReminders />)
    const today = onDay.host.querySelector('[data-testid="home-reminders-today"]') as HTMLElement
    expect(today.textContent).toContain('Nora New')
    expect(today.textContent).toContain('call about the garage')
    expect(today.textContent).toContain('Today')
    const row = today.querySelector('[data-testid="reminder-row"]') as HTMLElement
    expect(row.dataset.state).toBe('today')
    expect(row.style.background).not.toBe(T.state.warning.bg)
  })

  it('once missed it goes amber, and overdue ones sit ABOVE today’s', async () => {
    seed({ partner_id: 'p1', due_on: '2026-09-30', note: 'today one' })
    seed({ lead_id: 'lead-new', due_on: '2026-09-28', note: 'missed one' })
    seed({ lead_id: 'lead-9', due_on: '2026-10-05', note: 'later one' })
    const { host } = await mount(<HomeReminders />)
    const text = host.textContent!
    expect(text).toContain('missed one')
    expect(text).toContain('today one')
    expect(text).not.toContain('later one')
    expect(text.indexOf('missed one')).toBeLessThan(text.indexOf('today one'))
    const late = host.querySelector('[data-state="overdue"]') as HTMLElement
    expect(late.textContent).toContain('missed one')
    expect(late.textContent).toContain('overdue')
    expect(late.style.background).toBe(T.state.warning.bg)
    // an ignored one just sits there — still amber a week on
    setDay(new Date(2026, 9, 7, 9))
    const later = await mount(<HomeReminders />)
    expect((later.host.querySelector('[data-state="overdue"]') as HTMLElement).textContent).toContain('missed one')
  })

  it('ticking it on Home finishes it', async () => {
    seed({ lead_id: 'lead-new', due_on: '2026-09-30', note: 'today one' })
    const { host } = await mount(<HomeReminders />)
    await click(host.querySelector('[aria-label="Finish reminder"]'))
    expect(calls.find(c => c.method === 'PATCH')!.body).toEqual({ done: true })
    expect(host.querySelector('[data-testid="home-reminders"]')).toBeNull()
  })

  it('sits at the TOP of Home — above Needs attention — on both Homes', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'BeeHub.jsx'), 'utf8')
    const home = src.slice(src.indexOf('function DashboardScreen('))
    const main = home.slice(home.indexOf('<ImportGapBanner locationId={effectiveLocId} />'))
    expect(main.indexOf('<HomeReminders')).toBeGreaterThan(-1)
    expect(main.indexOf('<HomeReminders')).toBeLessThan(main.indexOf('Needs attention'))
    const all = home.slice(home.indexOf("if (isElevated && locFilter==='all') return ("))
    expect(all.indexOf('<HomeReminders')).toBeLessThan(all.indexOf('<HomeSystemHealth'))
  })
})

// ── C) the Reminders page ────────────────────────────────────
describe('C) the Reminders page', () => {
  const seedThree = () => {
    seed({ lead_id: 'lead-new', due_on: '2026-10-08', note: 'send the quote' })
    seed({ partner_id: 'p1', due_on: '2026-09-29', note: 'thank-you card' })
    seed({ engagement_id: 'eng-1', due_on: '2026-10-02', note: 'check the invoice' })
  }

  it('lists soonest due first, with the person’s name and the note', async () => {
    seedThree()
    const { host } = await mount(<RemindersScreen />)
    const rowsEl = [...host.querySelectorAll('[data-testid="reminder-row"]')] as HTMLElement[]
    expect(rowsEl.map(r => r.textContent)).toEqual([
      expect.stringContaining('Karen Martinez'),
      expect.stringContaining('Dana Client · Kitchen + Pantry'),
      expect.stringContaining('Nora New'),
    ])
    expect(rowsEl[0].textContent).toContain('thank-you card')
    expect(rowsEl[0].dataset.state).toBe('overdue')
    expect(rowsEl[1].textContent).toContain('Friday')
  })

  it('tick finishes, pencil changes the date, X deletes', async () => {
    seedThree()
    const { host } = await mount(<RemindersScreen />)
    const row = (note: string) => ([...host.querySelectorAll('[data-testid="reminder-row"]')] as HTMLElement[]).find(r => r.textContent!.includes(note))

    // tick
    await click(row('thank-you card')!.querySelector('[aria-label="Finish reminder"]'))
    expect(row('thank-you card')).toBeUndefined()
    expect(rows.find(r => r.note === 'thank-you card').done_at).toBeTruthy()

    // pencil → Next week → Done
    await click(row('send the quote')!.querySelector('[aria-label="Change date"]'))
    const setter = host.querySelector('[data-testid="reminder-setter"]') as HTMLElement
    expect((setter.querySelector('input[aria-label="What is this reminder for?"]') as HTMLInputElement).value).toBe('send the quote')
    await click(byText(setter, 'Next week'))
    await click(byText(setter, 'Done'))
    expect(rows.find(r => r.note === 'send the quote').due_on).toBe('2026-10-07')
    expect(row('send the quote')!.textContent).toContain('Oct 7')

    // X
    await click(row('check the invoice')!.querySelector('[aria-label="Delete reminder"]'))
    expect(row('check the invoice')).toBeUndefined()
    expect(rows.find(r => r.note === 'check the invoice')).toBeUndefined()

    expect(host.querySelectorAll('[data-testid="reminder-row"]')).toHaveLength(1)
  })

  it('the name opens the record', async () => {
    seedThree()
    const onOpen = vi.fn()
    const { host } = await mount(<RemindersScreen onOpen={onOpen} />)
    await click(byText(host, 'Karen Martinez'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ record_type: 'network', partner_id: 'p1' }))
  })

  it('an empty page says where the button is', async () => {
    const { host } = await mount(<RemindersScreen />)
    expect(host.querySelector('[data-testid="reminders-empty"]')!.textContent).toContain('Reminder')
  })

  it('has its own sidebar item and address: /reminders', () => {
    expect(ROUTE_TO_NAV.reminders).toBe('reminders')
    expect(NAV_TO_URL.reminders).toBe('/reminders')
    expect(NAV_TO_SCREEN.reminders).toBe('Reminders')
    expect(parseHubUrl('/reminders', '').nav).toBe('reminders')
    const src = readFileSync(join(__dirname, '..', 'components', 'BeeHub.jsx'), 'utf8')
    expect(src).toContain("{ key:'reminders', icon:'🔔', label:'Reminders' }")
    expect(src).toContain("if (activeNav==='reminders') return <div style={pageStyle}><RemindersScreen")
    expect(readFileSync(join(__dirname, '..', 'app', 'reminders', 'page.tsx'), 'utf8')).toContain('initialRoute="reminders"')
  })
})

// ── D) the browser never names an owner ──────────────────────
describe('D) the owner is never sent from the browser', () => {
  it('create and edit bodies carry no user id', async () => {
    const { host } = await mount(RECORDS[0].render())
    await openSetter(host, RECORDS[0], 'bar')
    await fillAndSave('Tomorrow', 'x')
    await click(strip(host).querySelector('[aria-label="Change date"]'))
    await click(byText(strip(host), 'Next week'))
    await click(byText(strip(host), 'Done'))
    const writes = calls.filter(c => c.method !== 'GET' && c.url.startsWith('/api/reminders'))
    expect(writes.length).toBe(2)
    for (const w of writes) expect(Object.keys(w.body)).not.toContain('user_id')
  })
})
