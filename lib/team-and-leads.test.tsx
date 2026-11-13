// @vitest-environment happy-dom
//
// Settings slice 2 of 4 (2026-11-13): Team.
//
// Today's Team and Seats with the New leads section folded into it, in the new
// look. The pieces are components/settings/TeamAndLeads.jsx; the Seats card is
// TeamSection in BeeHub.jsx; the Bees card is
// components/hive/BeeRosterSettings.jsx. What this file pins is what a reskin
// loses quietly:
//
//   1 · a manager sees the Bees half and NO Seats half — no orphan heading,
//       no banner, no recipients request
//   2 · the server still refuses a manager the recipients list
//       (the seats / invite / billing routes: lib/beta-team-seats-manager.test.ts)
//   3 · an outside email can still be MUTED and unmuted, not only removed
//   4 · every switch and action sends exactly what the New leads section sent
//       — the old component is mounted beside the new page and the requests
//       are compared
//   5 · 'newleads' and 'yourteam' land on this page, not on a dead section,
//       and nothing in Settings still sends anyone to "New leads"
//   6 · the counter, the notes under a switch, the banner
//   7 · the seven faults on the old Bees layout
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import * as BeeHubModule from '@/components/BeeHub'
import BeeRosterSettings, { beeSlackLine, slackUnreachableNote } from '@/components/hive/BeeRosterSettings'
import { notificationRecipientsManageableServer } from '@/lib/notification-access'

const { SettingsScreen, NewLeadsSection, SlackCard, CurrentUserContext, CurrentLocationContext, LocationUsersContext, SeatsContext } = BeeHubModule as any

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const HUB = read('components/BeeHub.jsx')
const PIECES = read('components/settings/TeamAndLeads.jsx')

const LOC = '11111111-2222-4333-8444-555555555555'
const LONG_EMAIL = 'bartholomew.maximilian.featherstonehaugh-cholmondeley@a-very-long-company-name-organizing.example.com'
const owner = { id: 'u-owner', email: 'riley@bee.test', name: 'Riley Park', role: 'franchise', locationId: LOC, first_name: 'Riley', last_name: 'Park', phone: '', booking_link: null }
const roster = [
  { id: 'u-owner', name: 'Riley Park', initials: 'RP', email: 'riley@bee.test', locationId: LOC, role: 'owner', status: 'active', jobberUserId: 'j1' },
  { id: 'u-mgr', name: 'Kevin Test', initials: 'KT', email: 'kevin@bee.test', locationId: LOC, role: 'manager', status: 'active', jobberUserId: null },
  // On the roster, not on the told list: gets no switch.
  { id: 'u-new', name: 'Nia New', initials: 'NN', email: 'nia@bee.test', locationId: LOC, role: 'readonly', status: 'active', jobberUserId: null },
]
const seats = {
  seats: [{ id: 's1', location_id: LOC, tier: 'owner', user_id: 'u-owner', status: 'active' }, { id: 's2', location_id: LOC, tier: 'manager', user_id: 'u-mgr', status: 'active' }],
  setSeats() {}, pendingInvites: [], setPendingInvites() {},
  seatCountsByTier: () => ({ owner: { total: 1, assigned: 1, available: 0, pending: 0 } }),
  availableSeatsByTierWithPending: () => 0, pendingInviteCount: () => 0, invitableSeatIds: () => new Set<string>(),
}
const location = (over: Record<string, any> = {}) => ({ id: LOC, name: 'Test Location', jobber_connected: true, jobber_team_roster: [], payment_source: 'corporate_sponsored', ...over })

type Notif = { users: any[]; externals: any[] }
const freshNotif = (): Notif => ({
  users: [
    { hub_user_id: 'u-owner', name: 'Riley Park', email: 'riley@bee.test', role: 'owner', subscribed: true },
    { hub_user_id: 'u-mgr', name: 'Kevin Test', email: 'kevin@bee.test', role: 'manager', subscribed: false },
    // On the told list, not on the roster: must still get a switch.
    { hub_user_id: 'u-ghost', name: 'Gia Ghost', email: 'gia@bee.test', role: 'manager', subscribed: true },
  ],
  externals: [
    { id: 'e1', name: 'Front Desk', email: 'frontdesk@x.test', phone: '2065550144', subscribed: true },
    { id: 'e2', name: 'bookkeeper@x.test', email: 'bookkeeper@x.test', phone: null, subscribed: false },
  ],
})
const HANDLERS = { people: [], project_type_groups: [], assignments: [{ project_type: 'Moving', source_user_id: 'u-mgr' }] }
const BEES = [
  { id: 'b1', name: 'Kevin Bee', email: 'kevinbee@x.test', is_active: true, slack_user_id: null, slack_checked_at: '2026-11-01T00:00:00Z' },
  { id: 'b2', name: 'Morgan Lee', email: LONG_EMAIL, is_active: true, slack_user_id: null, slack_checked_at: null },
]

let container: HTMLElement
let root: ReturnType<typeof createRoot>
let calls: Array<{ url: string; method: string; body: any; credentials: any; headers: any }>
let notif: Notif
let fail: { bees?: boolean; leads?: boolean; write?: boolean }

const res = (body: any, ok = true, status = 200) => ({ ok, status, json: async () => body })
beforeEach(() => {
  calls = []; notif = freshNotif(); fail = {}
  vi.stubGlobal('fetch', vi.fn(async (u: any, init: any = {}) => {
    const url = String(u); const method = init.method || 'GET'
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined, credentials: init.credentials, headers: init.headers })
    if (url.endsWith('/bees')) return fail.bees ? res({ error: 'boom' }, false, 500) : res({ bees: BEES, slackConnected: true, locationName: 'Test Location' })
    if (url.includes('/bees/')) return res({ bee: { ...BEES[1], slack_checked_at: null }, slackConnected: true, slackCheck: 'unavailable' })
    if (url.endsWith('/project-type-senders')) return res(HANDLERS)
    if (url.includes('notification-recipients')) {
      if (method === 'GET') return fail.leads ? res({}, false, 500) : res(JSON.parse(JSON.stringify(notif)))
      if (fail.write) return res({}, false, 500)
      return res({})
    }
    return res({})
  }))
  vi.stubGlobal('alert', () => {})
  window.history.replaceState(null, '', '/')
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 15)) }) }
const render = async (node: React.ReactNode) => {
  await act(async () => root.unmount()); container.remove()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  await act(async () => { root.render(node) })
  await settle()
}
const mount = (props: Record<string, any> = {}, loc: any = location()) => render(
  <CurrentUserContext.Provider value={owner}>
    <CurrentLocationContext.Provider value={loc}>
      <LocationUsersContext.Provider value={roster}>
        <SeatsContext.Provider value={seats}>
          <SettingsScreen initialSection="team" franchiseRole="owner" locationId={LOC} {...props} />
        </SeatsContext.Provider>
      </LocationUsersContext.Provider>
    </CurrentLocationContext.Provider>
  </CurrentUserContext.Provider>,
)
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
const all = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[]
const click = async (el: Element | null | undefined) => { if (!el) throw new Error('nothing to click'); await act(async () => { (el as HTMLElement).click() }); await settle() }
const type = async (input: Element | null, value: string) => {
  if (!input) throw new Error('no input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const sw = (label: string) => q(`button[role="switch"][aria-label="${label}"]`)
const writes = () => calls.filter(c => c.method !== 'GET')
const railCurrent = () => q('[data-settings-nav="rail"] [aria-current="page"]')?.getAttribute('data-section')
const pane = () => (q('[data-settings-nav="drill"]')!.nextElementSibling as HTMLElement)
const NO_ACCESS = "You don't have access to this section"
const RECIPIENT_REQUEST = /notification-recipients|project-type-senders/

// ═══════════════════════════════════════════════════════════════════════════
// 1 · THE TWO HALVES AND WHO SEES THEM
// ═══════════════════════════════════════════════════════════════════════════
describe('who sees which half', () => {
  it('an owner sees the banner, Seats, then Bees — under one page title', async () => {
    await mount()
    expect(q('[data-team-screen] h1')!.textContent).toBe('Team')
    expect(all('[data-team-screen] h2').map(h => h.textContent)).toEqual(['People who sign in', 'Test Location’s bees'])
    expect(all('[data-team-screen] [data-ssection] > div:first-child p:first-child').map(p => p.textContent)).toEqual(['Seats', 'Bees'])
    const order = ['[data-payment-banner]', '[data-team-seats]', '[data-team-bees]'].map(s => q(s)!)
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(railCurrent()).toBe('team')
    expect(q('[data-settings-nav="rail"] [data-section="team"]')!.textContent).toBe('Team')
  })

  it('a manager sees the Bees half only: one heading, no Seats card, no banner, no switch, and asks the server for nothing about seats or leads', async () => {
    await mount({ franchiseRole: 'manager' })
    expect(pane().textContent).not.toContain(NO_ACCESS)
    // ONE card heading on the page, and it is the bees'. No "Seats" eyebrow
    // or "People who sign in" standing over nothing.
    expect(all('[data-team-screen] h2').map(h => h.textContent)).toEqual(['Test Location’s bees'])
    expect(all('[data-team-screen] [data-ssection]').length).toBe(1)
    expect(q('[data-team-seats]')).toBeNull()
    expect(q('[data-team-seats-section]')).toBeNull()
    expect(q('[data-payment-banner]')).toBeNull()
    expect(q('[data-outside]')).toBeNull()
    expect(q('[data-billing-row]')).toBeNull()
    expect(all('button[role="switch"]')).toEqual([])
    for (const t of ['People who sign in', 'Seats', 'New lead emails', 'outside email', 'told about new leads', 'Invite', 'Sync Jobber', 'Billing', 'Sponsored', 'who hears about new leads', 'Who signs in']) {
      expect(pane().textContent, `manager must not see "${t}"`).not.toContain(t)
    }
    expect(q('[data-team-screen] header')!.textContent).toBe('TeamThe people who work your jobs.')
    // Their half is live…
    expect(calls.map(c => c.url)).toContain(`/api/locations/${LOC}/bees`)
    // …and nothing about who is told was even asked for.
    expect(calls.filter(c => RECIPIENT_REQUEST.test(c.url))).toEqual([])
    expect(calls.filter(c => /\/api\/(seats|pending_invites|hub_users)/.test(c.url))).toEqual([])
  })

  it('a read-only sign-in gets the no-access notice, as before', async () => {
    await mount({ franchiseRole: 'viewer' })
    expect(pane().textContent).toContain(NO_ACCESS)
    expect(q('[data-team-screen]')).toBeNull()
    expect(calls.filter(c => RECIPIENT_REQUEST.test(c.url) || c.url.includes('/bees'))).toEqual([])
  })

  it('the gates are the ones that were there: seats owner-only, bees owner and manager', () => {
    expect(HUB).toContain("const canManageTeam = franchiseRole === 'owner'")
    expect(HUB).toContain('const canSeeSeats = canManageTeam')
    expect(HUB).toContain('const canSeeBees = canManageOwnTags')
    expect(HUB).toContain('{canSeeSeats && (\n                <TUI.PaymentBanner')
    expect(HUB).toMatch(/\{canSeeSeats && \(\s*<TeamSection /)
    expect(HUB).toContain('{canSeeBees && <BeeRosterSettings ')
    // The pieces know nothing about roles.
    expect(PIECES.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')).not.toMatch(/franchiseRole|canSee|canManage|isSuperAdmin/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE SERVER STILL REFUSES A MANAGER
// ═══════════════════════════════════════════════════════════════════════════
describe('who is told about a lead is still the owner’s to manage, on the server', () => {
  it('the access rule refuses a manager and a read-only user of the SAME location, and an owner of another', () => {
    expect(notificationRecipientsManageableServer('owner', LOC, LOC)).toBe(true)
    expect(notificationRecipientsManageableServer('manager', LOC, LOC)).toBe(false)
    expect(notificationRecipientsManageableServer('lite_user', LOC, LOC)).toBe(false)
    expect(notificationRecipientsManageableServer('owner', 'another-location', LOC)).toBe(false)
  })

  it('every verb of both recipients routes goes through that rule — and this slice changed neither file', () => {
    for (const [file, verbs] of [
      ['app/api/locations/[id]/notification-recipients/route.ts', ['GET', 'PATCH', 'POST']],
      ['app/api/locations/[id]/notification-recipients/externals/[extId]/route.ts', ['PATCH', 'DELETE']],
    ] as Array<[string, string[]]>) {
      const src = read(file)
      expect(src, file).toContain('notificationRecipientsManageableServer(')
      const handlers = src.split(/export async function /).slice(1)
      expect(handlers.map(h => h.slice(0, h.indexOf('('))).sort(), file).toEqual([...verbs].sort())
      for (const h of handlers) expect(h, `${file} ${h.slice(0, 6)}`).toMatch(/authForLocation\(|authFor\w*\(/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3 · A SWITCH UNDER EACH PERSON
// ═══════════════════════════════════════════════════════════════════════════
describe('each person who signs in carries their New lead emails switch', () => {
  it('the switch is inside that person’s row and shows their own setting', async () => {
    await mount()
    const riley = q('[data-seat="riley@bee.test"]')!, kevin = q('[data-seat="kevin@bee.test"]')!
    expect(riley.textContent).toContain('New lead emails')
    expect(riley.querySelector('button[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
    expect(kevin.querySelector('button[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
    expect(riley.querySelector('button[role="switch"]')!.getAttribute('aria-label')).toBe('Tell Riley Park about new leads')
    // Role and Jobber chips, from the same tables as before.
    expect(riley.textContent).toContain('Zee Bee'); expect(riley.textContent).toContain('Jobber')
    expect(kevin.textContent).toContain('Hive Manager'); expect(kevin.textContent).toContain('No Jobber')
    expect(q('[data-jobber-count]')!.textContent).toBe(' Jobber: 1 linked · 2 not linked.')
  })

  it('someone on the roster but not on the told list gets no switch; someone on the told list but not the roster still gets one', async () => {
    await mount()
    expect(q('[data-seat="nia@bee.test"]')!.querySelector('button[role="switch"]')).toBeNull()
    const ghost = q('[data-seat="gia@bee.test"]')!
    expect(ghost.querySelector('button[role="switch"]')!.getAttribute('aria-label')).toBe('Tell Gia Ghost about new leads')
    // …and is not a button that opens a seat sheet they do not have.
    expect(ghost.querySelector('[data-seat-open]')).toBeNull()
    // Every switch on the old list is on this page: nobody became impossible to switch off.
    expect(all('[data-seat-list] button[role="switch"]').length).toBe(notif.users.length)
  })

  it('the two notes under a switch survive: what a handler still gets, and the owner’s fallback', async () => {
    notif.users[0].subscribed = false
    await mount()
    expect(q('[data-handles="kevin@bee.test"]')!.textContent).toBe('Handles Moving — still emailed about these; the switch only covers other leads')
    expect(q('[data-owner-note="riley@bee.test"]')!.textContent).toBe('Any lead without a handler is assigned to the owner — those still email Riley')
    notif.users[0].subscribed = true; notif.users[1].subscribed = true
    await mount()
    expect(q('[data-handles="kevin@bee.test"]')!.textContent).toBe('Handles Moving')
    expect(q('[data-owner-note="riley@bee.test"]')).toBeNull()
  })

  it('opening a person (their role, Jobber link, remove access) is a separate button from their switch', async () => {
    await mount()
    const kevin = q('[data-seat="kevin@bee.test"]')!
    const open = kevin.querySelector('[data-seat-open]')!
    expect(open.getAttribute('aria-label')).toBe('Manage Kevin Test')
    expect(open.contains(kevin.querySelector('button[role="switch"]'))).toBe(false)
    await click(kevin.querySelector('button[role="switch"]'))
    expect(writes().length).toBe(1)          // the switch saved…
    expect(document.body.textContent).not.toContain('Remove access')   // …and did not open their sheet
  })

  it('if the list cannot be loaded it says so, and draws no switch that would lie', async () => {
    fail.leads = true
    await mount()
    expect(q('[data-leads-error]')!.textContent).toBe('Could not load who is told about new leads. Reload the page to try again.')
    expect(all('button[role="switch"]')).toEqual([])
    expect(q('[data-told-count]')).toBeNull()
    // The people are still listed.
    expect(q('[data-seat="riley@bee.test"]')).toBeTruthy()
  })

  it('a save the server refuses is said, and the switch goes back', async () => {
    await mount()
    fail.write = true
    await click(sw('Tell Riley Park about new leads'))
    expect(q('[data-leads-error]')!.textContent).toBe('That did not save. Try again.')
    expect(sw('Tell Riley Park about new leads')!.getAttribute('aria-checked')).toBe('true')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4 · OUTSIDE EMAILS: MUTE IS NOT REMOVE, AND THE COUNTER
// ═══════════════════════════════════════════════════════════════════════════
describe('an outside email can be muted and unmuted, not only removed', () => {
  const EXT = (id: string) => `/api/locations/${LOC}/notification-recipients/externals/${id}`

  it('the switch on its row mutes it: one PATCH {subscribed:false}, and the row STAYS, marked muted', async () => {
    await mount()
    const row = () => q('[data-outside-email="frontdesk@x.test"]')
    expect(row()!.hasAttribute('data-muted')).toBe(false)
    await click(sw('Tell frontdesk@x.test about new leads'))
    expect(writes()).toEqual([{ url: EXT('e1'), method: 'PATCH', body: { subscribed: false }, credentials: 'include', headers: { 'Content-Type': 'application/json' } }])
    expect(row()).toBeTruthy()
    expect(row()!.hasAttribute('data-muted')).toBe(true)
    expect(row()!.textContent).toContain('Muted — not emailed')
    expect(sw('Tell frontdesk@x.test about new leads')!.getAttribute('aria-checked')).toBe('false')
  })

  it('…and unmutes it: one PATCH {subscribed:true}', async () => {
    await mount()
    expect(q('[data-outside-email="bookkeeper@x.test"]')!.textContent).toContain('Muted — not emailed')
    await click(sw('Tell bookkeeper@x.test about new leads'))
    expect(writes()).toEqual([{ url: EXT('e2'), method: 'PATCH', body: { subscribed: true }, credentials: 'include', headers: { 'Content-Type': 'application/json' } }])
    expect(q('[data-outside-email="bookkeeper@x.test"]')!.textContent).not.toContain('Muted')
  })

  it('removing is a different control and a different request: DELETE, and the row goes', async () => {
    await mount()
    const bin = q('[data-outside-email="frontdesk@x.test"] button[aria-label="Remove frontdesk@x.test"]')!
    expect(bin.getAttribute('title')).toBe('Remove this address from the list entirely')
    await click(bin)
    expect(writes().map(c => [c.url, c.method, c.body])).toEqual([[EXT('e1'), 'DELETE', undefined]])
    expect(q('[data-outside-email="frontdesk@x.test"]')).toBeNull()
  })

  it('the counter is kept, beside the add action, and counts people and outside emails that are switched on', async () => {
    await mount()
    // Riley + Gia on, Kevin off; Front Desk on, bookkeeper muted.
    expect(q('[data-told-count]')!.textContent).toBe('3 told about new leads')
    expect(q('[data-told-count]')!.parentElement!.contains(q('[data-outside-add-open]'))).toBe(true)
    await click(sw('Tell frontdesk@x.test about new leads'))
    expect(q('[data-told-count]')!.textContent).toBe('2 told about new leads')
    await click(sw('Tell Kevin Test about new leads'))
    expect(q('[data-told-count]')!.textContent).toBe('3 told about new leads')
  })

  it('adding one: the form opens from the text action, refuses a bad address without asking the server, and posts a good one', async () => {
    await mount()
    expect(q('[data-outside-add-open]')!.textContent).toBe('+ Add outside email for new leads')
    expect(q('[data-outside-add]')).toBeNull()
    await click(q('[data-outside-add-open]'))
    const field = (label: string) => all('[data-outside-add] label').find(l => l.querySelector('span')!.textContent === label)!.querySelector('input')
    expect(all('[data-outside-add] label span').map(s => s.textContent)).toEqual(['First name', 'Last name', 'Email', 'Phone (optional)'])
    await type(field('Email'), 'not-an-email')
    await click(q('[data-outside-add] button[type="submit"]'))
    expect(writes()).toEqual([])
    expect(q('[data-outside-add] [role="alert"]')!.textContent).toBe('Enter a valid email address.')
    await type(field('First name'), ' Pat '); await type(field('Email'), ' pat@x.test ')
    await click(q('[data-outside-add] button[type="submit"]'))
    expect(writes().map(c => [c.url, c.method, c.body])).toEqual([[`/api/locations/${LOC}/notification-recipients`, 'POST', { first_name: 'Pat', last_name: null, email: 'pat@x.test', phone: null }]])
    expect(q('[data-outside-add]')).toBeNull()
  })

  it('the Slack line is kept: a channel gets every lead whatever is set here', async () => {
    await mount()
    expect(q('[data-leads-slack]')!.textContent).toContain('every new lead posts there too, whatever is set here')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5 · THE SAME REQUESTS THE NEW LEADS SECTION SENT
// ═══════════════════════════════════════════════════════════════════════════
// NewLeadsSection is untouched (it still draws "who handles what" on Emails)
// and still has its "who is told" half behind only="recipients". So the old
// screen can be mounted, clicked through, and compared with the new page —
// address, verb, body, credentials and headers, in order.
describe('turning a switch on or off changes exactly what it changed before', () => {
  const steps: Array<[string, { old: () => Promise<void>; neu: () => Promise<void> }]> = [
    ['switch a person off', {
      old: () => click(sw('Tell Riley Park about new leads')),
      neu: () => click(sw('Tell Riley Park about new leads')),
    }],
    ['switch a person on', {
      old: () => click(sw('Tell Kevin Test about new leads')),
      neu: () => click(sw('Tell Kevin Test about new leads')),
    }],
    ['mute an outside email', {
      old: () => click(sw('Tell frontdesk@x.test about new leads')),
      neu: () => click(sw('Tell frontdesk@x.test about new leads')),
    }],
    ['unmute an outside email', {
      old: () => click(sw('Tell bookkeeper@x.test about new leads')),
      neu: () => click(sw('Tell bookkeeper@x.test about new leads')),
    }],
    ['remove an outside email', {
      old: () => click(Array.from(q('[data-recipient="frontdesk@x.test"]')!.querySelectorAll('button')).find(b => b.textContent === 'Remove')),
      neu: () => click(q('button[aria-label="Remove frontdesk@x.test"]')),
    }],
    ['add an outside email', {
      old: async () => {
        await click(all('button').find(b => b.textContent === '+ Add outside email'))
        await type(q('input[placeholder="First name"]'), ' Pat '); await type(q('input[placeholder="Last name"]'), 'Lee')
        await type(q('input[placeholder="email@example.com *"]'), ' pat@x.test '); await type(q('input[placeholder="Phone (optional)"]'), '206 555 0199')
        await click(all('button').find(b => b.textContent === 'Add email'))
      },
      neu: async () => {
        await click(q('[data-outside-add-open]'))
        const field = (label: string) => all('[data-outside-add] label').find(l => l.querySelector('span')!.textContent === label)!.querySelector('input')
        await type(field('First name'), ' Pat '); await type(field('Last name'), 'Lee')
        await type(field('Email'), ' pat@x.test '); await type(field('Phone (optional)'), '206 555 0199')
        await click(q('[data-outside-add] button[type="submit"]'))
      },
    }],
  ]

  it('the page asks for the same two things on opening', async () => {
    await render(<NewLeadsSection realLocId={LOC} readOnly={false} only="recipients" />)
    const old = calls.filter(c => RECIPIENT_REQUEST.test(c.url))
    calls = []
    await mount()
    const neu = calls.filter(c => RECIPIENT_REQUEST.test(c.url))
    expect(old.length).toBe(2)
    expect(neu).toEqual(old)
  })

  for (const [name, step] of steps) {
    it(`${name}: identical request`, async () => {
      await render(<NewLeadsSection realLocId={LOC} readOnly={false} only="recipients" />)
      calls = []
      await step.old()
      const old = writes()
      expect(old.length, 'the old screen sent one write').toBe(1)

      notif = freshNotif()
      await mount()
      calls = []
      await step.neu()
      expect(writes()).toEqual(old)
    })
  }

  it('the New leads component itself is byte for byte what it was — still serving Emails', () => {
    const a = HUB.indexOf('export function NewLeadsSection('), b = HUB.indexOf('// Format an integer cent amount', a)
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a)
    expect(HUB.slice(a, b)).toContain("{only !== 'handlers' && <>")
    expect(HUB.split('<NewLeadsSection ').length - 1).toBe(1)
    expect(HUB).toContain('<NewLeadsSection realLocId={realLocId} readOnly={false} only="handlers" />')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6 · OLD LINKS
// ═══════════════════════════════════════════════════════════════════════════
describe('nothing points at New leads any more', () => {
  for (const key of ['newleads', 'yourteam', 'bees', 'billing', 'team']) {
    it(`an owner arriving on '${key}' lands on Team`, async () => {
      await mount({ initialSection: key })
      expect(pane().textContent).not.toContain(NO_ACCESS)
      expect(q('[data-team-screen] h1')!.textContent).toBe('Team')
      expect(railCurrent()).toBe('team')
      expect(q('[data-team-seats]')).toBeTruthy()
      // 'billing' still opens the billing details expanded.
      expect(!!q('[data-billing-details]')).toBe(key === 'billing')
    })
  }

  it('a ?section=newleads link lands there too, including when it arrives by the back button', async () => {
    window.history.replaceState(null, '', '/?section=newleads')
    await mount({ initialSection: undefined })
    await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')) })
    expect(q('[data-team-screen] h1')!.textContent).toBe('Team')
    expect(pane().textContent).not.toContain(NO_ACCESS)
  })

  it("a manager arriving on 'newleads' or 'yourteam' gets their half of the page, not a dead section and not the Seats half", async () => {
    for (const key of ['newleads', 'yourteam']) {
      await mount({ franchiseRole: 'manager', initialSection: key })
      expect(q('[data-team-bees]'), key).toBeTruthy()
      expect(q('[data-team-seats]'), key).toBeNull()
    }
  })

  it('no retired key points at another retired key, and every target is a real section', async () => {
    const m = HUB.match(/const SETTINGS_RETIRED_SECTIONS = (\{[^}]+\})/)![1]
    const map = Object.fromEntries(Array.from(m.matchAll(/(\w+):'(\w+)'/g)).map(x => [x[1], x[2]]))
    expect(map).toEqual({ billing: 'team', bees: 'team', paths: 'emails', templates: 'emails', yourteam: 'team', newleads: 'team' })
    await mount()
    const live = all('[data-settings-nav="rail"] [data-section]').map(b => b.getAttribute('data-section'))
    for (const [from, to] of Object.entries(map)) {
      expect(live, `${from} → ${to}`).toContain(to)
      expect(Object.keys(map), `${to} is itself retired`).not.toContain(to)
      expect(live, `${from} is still in the nav`).not.toContain(from)
    }
    expect(live).not.toContain('newleads')
    expect(HUB).not.toContain("activeSection==='newleads'")
  })

  it('no Settings section an owner can open still tells them to go to New leads', async () => {
    for (const key of ['profile', 'location', 'team', 'tags', 'emails', 'texts', 'slack', 'jobber', 'mailchimp']) {
      // Without a location context: some old sections need the app's router once they have a real location.
      await render(<CurrentUserContext.Provider value={owner}><SettingsScreen initialSection={key} franchiseRole="owner" /></CurrentUserContext.Provider>)
      // Tags is closed (slice 3): it is never the current page.
      expect(railCurrent(), key).toBe(key === 'tags' ? undefined : key)
      const text = pane().textContent || ''
      for (const stale of ['on New leads', 'Notifications ›', 'Settings → New leads', 'New leads section', 'Team and Seats']) {
        expect(text, `${key}: "${stale}"`).not.toContain(stale)
      }
    }
    await render(<CurrentUserContext.Provider value={owner}><SettingsScreen initialSection="slack" franchiseRole="owner" /></CurrentUserContext.Provider>)
    expect(pane().textContent).toContain('New leads also post to your Slack channel, on top of the new lead emails you set on Team.')
  })

  it('the messages Bee Hub writes elsewhere name pages that exist', () => {
    // Held-email reasons used to send owners to "Settings → New leads → Who
    // handles what" — which moved to Emails on 2026-10-30 and is now gone.
    for (const f of ['lib/sender-domain.ts', 'lib/drip-send.ts']) {
      const strings = read(f).split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
      expect(strings, f).not.toContain('New leads →')
      expect(strings, f).not.toContain('Settings → New leads')
    }
    expect(read('lib/sender-domain.ts')).toContain('in Settings → Emails, under Who your emails come from.')
    // Two messages named this page by its old title.
    expect(read('components/hive/shared/BeeSlackStatus.jsx')).toContain('Check their email in Settings › Team.')
    expect(read('app/api/engagements/[id]/bees/route.ts')).toContain('bring them back in Settings › Team first.')
    for (const f of ['components/hive/shared/BeeSlackStatus.jsx', 'app/api/engagements/[id]/bees/route.ts']) expect(read(f), f).not.toContain('Team and Seats')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 7 · THE BANNER AND THE BILLING ROW
// ═══════════════════════════════════════════════════════════════════════════
describe('the payment banner and billing row', () => {
  it('a sponsored location reads sponsored, with the warning and no Stripe button', async () => {
    await mount()
    const b = q('[data-payment-banner]')!
    expect(b.textContent).toContain('Sponsored by Bee Organized — Testing Period')
    expect(b.textContent).toContain('Important: When testing concludes')
    expect(q('[data-manage-billing]')).toBeNull()
  })

  it('a paying location reads active, with the Stripe button and no warning', async () => {
    await mount({}, location({ payment_source: 'direct' }))
    const b = q('[data-payment-banner]')!
    expect(b.textContent).toContain('Subscription active')
    expect(b.textContent).not.toContain('Important:')
    expect(q('[data-manage-billing]')!.textContent).toBe('Manage billing in Stripe')
  })

  it('"Billing & seat details" is collapsed until asked for, and opens what it opened before', async () => {
    await mount()
    const row = q('[data-billing-row]')!
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(q('[data-billing-details]')).toBeNull()
    await click(row)
    expect(q('[data-billing-row]')!.getAttribute('aria-expanded')).toBe('true')
    for (const t of ['Your seats this year', 'Seat roster', 'View billing history', 'Pre-buy seats']) expect(q('[data-billing-details]')!.textContent).toContain(t)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 8 · THE SEVEN FAULTS ON THE OLD BEES LAYOUT
// ═══════════════════════════════════════════════════════════════════════════
describe('the faults on the old Bees layout are closed', () => {
  const mountBees = () => render(<BeeRosterSettings {...({ locationId: LOC, locationName: 'Test Location' } as any)} />)

  it('1 · a load failure says the list could not be loaded, offers Try again, and does NOT say there are no bees', async () => {
    fail.bees = true
    await mountBees()
    expect(q('[data-bee-load-failed]')!.textContent).toContain('We couldn’t load your bees just now. Nothing has been changed.')
    expect(q('[data-bee-empty]')).toBeNull()
    expect(container.textContent).not.toMatch(/No bees on your list|HTTP 500|boom/)
    fail.bees = false
    await click(q('[data-bee-retry]'))
    expect(q('[data-bee-load-failed]')).toBeNull()
    expect(all('[data-bee-list] [data-bee]').length).toBe(2)
  })

  it('2 · a long email is shown whole: it wraps, here and on a seat and on an outside address', async () => {
    await mountBees()
    const email = all('[data-bee-email]').find(e => e.textContent === LONG_EMAIL)!
    expect(email.style.overflowWrap).toBe('anywhere')
    expect(email.style.textOverflow).toBe(''); expect(email.style.whiteSpace).toBe(''); expect(email.style.overflow).toBe('')
    notif.externals[0].email = LONG_EMAIL
    await mount()
    for (const el of [q('[data-seat-email]')!, ...all('[data-outside-email] span span').filter(e => !(e.textContent || '').startsWith('Muted'))]) {
      expect(el.style.textOverflow, el.textContent || '').toBe('')
      expect(el.style.whiteSpace, el.textContent || '').toBe('')
    }
    // Nothing on the whole page is cut with an ellipsis.
    expect(all('[data-team-screen] *').filter(e => e.style.textOverflow === 'ellipsis' && !e.closest('[data-billing-details]'))).toEqual([])
  })

  it('3 · the "could not reach Slack" line names the button that bee is actually showing', async () => {
    expect(beeSlackLine({ slack_checked_at: null }).action).toBe('Check now')
    expect(slackUnreachableNote({ slack_checked_at: null })).toContain('tap Check now in a minute')
    expect(slackUnreachableNote({ slack_checked_at: '2026-11-01' })).toContain('tap Check again in a minute')
    await mountBees()
    // Morgan has never been checked: her button says "Check now"…
    const morgan = q('[data-bee="b2"]')!
    expect(morgan.querySelector('[data-bee-recheck]')!.textContent).toBe('Check now')
    await click(morgan.querySelector('[data-bee-recheck]'))   // the server answers "Slack unavailable"
    // …and the line says the same two words, not "Check again".
    expect(q('[data-bee-note]')!.textContent).toContain('tap Check now in a minute')
    expect(q('[data-bee="b2"] [data-bee-recheck]')!.textContent).toBe('Check now')
  })

  it('4 · the pencil and the bin cannot drop to a line of their own: one grid row, four fixed columns', async () => {
    await mountBees()
    for (const row of all('[data-bee-row]')) {
      expect(row.style.display).toBe('grid')
      expect(row.style.gridTemplateColumns).toBe('auto minmax(0,1fr) auto auto')
      expect(row.style.flexWrap).toBe('')
      expect(Array.from(row.children).map(c => c.tagName)).toEqual(['SPAN', 'SPAN', 'BUTTON', 'BUTTON'])
    }
  })

  it('5 · no button’s words are left at the 16px the app forces on buttons: every one sits in a sized span', async () => {
    await mount()
    await click(q('[data-bee-add-open]')); await click(q('[data-outside-add-open]'))
    const buttons = all('[data-team-screen] button').filter(b => !b.closest('[data-billing-details]'))
    expect(buttons.length).toBeGreaterThan(12)
    for (const b of buttons) {
      const loose = Array.from(b.childNodes).filter(n => n.nodeType === 3 && (n.textContent || '').trim())
      expect(loose.map(n => n.textContent), `loose text in <button> "${b.textContent}"`).toEqual([])
      for (const s of Array.from(b.querySelectorAll('span')).filter(s => s.children.length === 0 && (s.textContent || '').trim())) {
        let el: HTMLElement | null = s, size = ''
        while (el && el !== b && !size) { size = el.style.fontSize; el = el.parentElement }
        expect(['11px', '12px', '13px', '14px'], `"${s.textContent}" in "${b.textContent}"`).toContain(size)
      }
    }
  })

  it('6 · the Slack card shows the whole workspace name: the connected line wraps instead of being cut', async () => {
    const settings = { location: { slackStatus: 'connected', slackConnected: true, slackTeamName: 'Bee Organized Kansas City and Surrounding Areas Workspace', slackChannelName: 'new-leads' } }
    await render(<SlackCard settings={settings} updateLocation={() => {}} />)
    const line = q('[data-slack-connected-line]')
    const src = HUB.slice(HUB.indexOf('export function SlackCard('), HUB.indexOf('export function SlackCard(') + 16000)
    const tag = src.slice(src.indexOf('data-slack-connected-line') - 10, src.indexOf('data-slack-connected-line') + 120)
    expect(tag).toContain("overflowWrap:'anywhere'")
    expect(tag).not.toMatch(/ellipsis|nowrap/)
    expect(line).toBeTruthy()
    expect(line!.style.textOverflow).toBe(''); expect(line!.style.whiteSpace).toBe(''); expect(line!.style.overflowWrap).toBe('anywhere')
    expect(line!.textContent).toContain('Bee Organized Kansas City and Surrounding Areas Workspace')
    // Its parent no longer clips it either.
    expect(line!.parentElement!.style.overflow).toBe('')
  })

  it('7 · "Add a bee" is not left lit above its open form: it goes while the form is open and comes back on Cancel', async () => {
    await mountBees()
    await click(q('[data-bee-add-open]'))
    expect(q('[data-bee-add]')).toBeTruthy()
    expect(q('[data-bee-add-open]')).toBeNull()
    await click(all('[data-bee-add] button').find(b => b.textContent === 'Cancel'))
    expect(q('[data-bee-add]')).toBeNull()
    expect(q('[data-bee-add-open]')!.textContent).toBe('Add a bee')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 9 · THE BEES CARD DID NOT LOSE ANYTHING
// ═══════════════════════════════════════════════════════════════════════════
describe('the Bees card in the new look', () => {
  it('no bees: says so, and offers Add a bee', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res({ bees: [], slackConnected: false, locationName: 'Test Location' })))
    await render(<BeeRosterSettings {...({ locationId: LOC } as any)} />)
    expect(q('[data-bee-empty]')!.textContent).toBe('No bees on your list yet.')
    expect(q('h2')!.textContent).toBe('Test Location’s bees')
    expect(q('[data-bee-add-open]')).toBeTruthy()
    expect(container.textContent).not.toMatch(/Slack/)
  })

  it('a bee Slack cannot find: one chip, one amber box, one Check again button', async () => {
    await render(<BeeRosterSettings {...({ locationId: LOC } as any)} />)
    const row = q('[data-bee="b1"]')!
    expect(row.querySelector('[data-bee-slack="not_found"]')!.textContent).toBe('Not in Slack')
    const note = row.querySelector('[data-bee-slack-note="not_found"]')!
    expect(note.textContent).toContain('That email isn’t in your Slack. Use the one they sign in to Slack with.')
    expect(note.querySelector('[data-bee-recheck]')!.textContent).toBe('Check again')
  })
})
