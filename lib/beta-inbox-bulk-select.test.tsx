// @vitest-environment happy-dom
// Inbox bulk selection (feedback #5) + the Jobber-owns-deletion rule
// (Kevin 7/10: leads are deletable ONLY pre-Jobber; linked records'
// lifecycle belongs to Jobber). Covers:
//   - entry affordance: the TOP-LEFT header select-all checkbox (the
//     column-header convention) — one gesture enters selection mode AND
//     selects all visible selectable rows; tri-state in mode; row
//     long-press stays the secondary door in
//   - selection mechanics: checkboxes, row click toggles instead of
//     opening, count chip, Cancel exits + clears
//   - select-all-visible respects active filters
//   - bulk Remove = mark-junk batched (is_junk=true per row), rows
//     leave instantly, ONE batch Undo restores every removed row
//   - N>5 confirm step: no writes until confirmed; Keep backs out
//   - linked exclusion: grayed disabled checkbox ('Managed in
//     Jobber'), select-all skips linked, row click can't select it,
//     and the linked row's ··· menu carries no 'Mark as junk'
//   - ClientProfile + PersonCard ··· guards: no junk menu on linked
//   - source guard: the API 409 (jobber_linked_junk_rejected) exists
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'
import ClientProfile from '@/components/hive/ClientProfile'
import PersonCard from '@/components/hive/PersonCard'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

let seq = 0
const person = (over: any = {}) => ({
  id: `p-${++seq}-${Math.random().toString(36).slice(2, 6)}`,
  name: `Lead ${seq}`,
  email: 'lead@email.com',
  phone: '(561) 555-0199',
  locationId: 'loc-uuid-1',
  created: daysAgo(3), // < 30d, no outreach → derived New
  isJunk: false,
  snoozeUntil: null,
  inboxDismissedAt: null,
  jobberRef: null,
  outreachTimeline: [],
  ...over,
})

const profilePayload = (over: any = {}) => ({
  client: {
    id: 'lead-9', name: 'Dana Client', first_name: 'Dana', last_name: 'Client',
    email: 'dana@x.com', phone: '(561) 555-0100',
    created_at: daysAgo(40), source: 'Webform', paused: false, marketing_opt_out: false,
    referred_by_kind: null, referred_by_id: null, referred_by_name: null,
    jobber_client_id: null, location_uuid: 'loc-uuid-1', location_id: null,
    paid_amount: 0, request_details: null, project_type: null, location_name: 'Denver',
    ...(over.client || {}),
  },
  referred_us: [], contacts: [], engagements: [], touchpoints: [],
  buzz_notes: [], job_notes: [],
  aggregates: { lifetime_paid: 0, open_pipeline: 0, owing: 0, open_count: 0, total_count: 0 },
})

// ── fetch mock ─────────────────────────────────────────────
const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
let patches: Array<{ id: string; body: any }> = []
let profileOver: any = {}
const installFetch = () => {
  patches = []
  profileOver = {}
  const mock = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (/\/api\/leads\/[^/]+$/.test(u) && opts.method === 'PATCH') {
      const body = JSON.parse(opts.body)
      patches.push({ id: u.split('/').pop()!, body })
      return jsonRes({ lead: { id: u.split('/').pop(), ...body } })
    }
    if (u.includes('/profile')) return jsonRes(profilePayload(profileOver))
    if (u.includes('/outreach-timeline')) return jsonRes({ items: [], drip_progress_id: null, drip_path_name: null, paused: false, stopped: false, completed: false, completed_at: null, stopped_at: null })
    return jsonRes({})
  })
  ;(globalThis as any).fetch = mock
  return mock
}

// ── DOM helpers ────────────────────────────────────────────
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return {
    host,
    rerender: async (next: React.ReactElement) => { await act(async () => { root.render(next) }) },
    unmount: async () => { await act(async () => root.unmount()); host.remove() },
  }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const buttonByText = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === text)
const rowByName = (host: Element, name: string) =>
  [...host.querySelectorAll('.bee-inbox-row')].find(r => (r.textContent || '').includes(name))
// Row-scoped: the header select-all checkbox is a permanent fixture now,
// so 'are we in selection mode' reads off the per-row checkboxes only.
const rowCheckboxes = (host: Element) =>
  [...host.querySelectorAll('.bee-inbox-row input[type="checkbox"]')] as HTMLInputElement[]
// The ··· menu portals to <body> (the cards clip overflow) — menu items
// are queried through the portal container, not the mount host.
const menuButton = (text: string) =>
  [...document.querySelectorAll('[data-bee-row-menu] button')].find(b => (b.textContent || '').trim() === text)

const clickUndo = async (toast: any) => {
  const kids = React.Children.toArray(toast.msg.props.children) as any[]
  const btn = kids.find(k => k?.type === 'button')
  expect(btn, 'undo toast should carry an Undo button').toBeTruthy()
  await act(async () => { await btn.props.onClick() })
}

let lastToast: any = null
const setToast = (t: any) => { lastToast = t }

const inbox = (people: any[], over: any = {}) => (
  <InboxScreen people={people} engagements={[]} locFilter="all" setToast={setToast} {...over} />
)

// THE entry affordance: the top-left header select-all checkbox. One
// click = selection mode + everything visible+selectable selected.
const headerCheckbox = (host: Element) =>
  host.querySelector('input[aria-label="Select all"]') as HTMLInputElement | null
const enterSelectAll = async (host: Element) => { await click(headerCheckbox(host)!) }
// Mode with an EMPTY selection: enter (selects all), uncheck (clears,
// stays in mode).
const enterSelectEmpty = async (host: Element) => {
  await click(headerCheckbox(host)!)
  await click(headerCheckbox(host)!)
}

beforeEach(() => {
  installFetch()
  lastToast = null
  ;(globalThis as any).window?.localStorage?.clear?.()
})

// ═══ entry affordances ═════════════════════════════════════
describe('entry affordances', () => {
  it('header checkbox: ONE gesture enters selection mode AND selects all visible; tri-state tracks; in-mode uncheck clears', async () => {
    const a = person({ name: 'Alice Apple' })
    const b = person({ name: 'Bob Berry' })
    const m = await mount(inbox([a, b]))

    // the old header Select pill is gone — the checkbox IS the entry
    expect(buttonByText(m.host, 'Select')).toBeFalsy()
    expect(rowCheckboxes(m.host)).toHaveLength(0)

    await click(headerCheckbox(m.host)!)
    expect(rowCheckboxes(m.host)).toHaveLength(2)
    expect(m.host.textContent).toContain('2 selected')
    expect(buttonByText(m.host, 'Remove (2)')).toBeTruthy()
    expect(headerCheckbox(m.host)!.checked).toBe(true)

    // deselecting one row → partial → indeterminate, not checked
    await click(rowByName(m.host, 'Alice Apple')!)
    expect(m.host.textContent).toContain('1 selected')
    expect(headerCheckbox(m.host)!.checked).toBe(false)
    expect(headerCheckbox(m.host)!.indeterminate).toBe(true)

    // in-mode uncheck-all: clears the selection but STAYS in mode
    await click(rowByName(m.host, 'Alice Apple')!)
    expect(m.host.textContent).toContain('2 selected')
    await click(headerCheckbox(m.host)!)
    expect(m.host.textContent).toContain('0 selected')
    expect(rowCheckboxes(m.host)).toHaveLength(2)
    expect(patches).toHaveLength(0) // selection alone never writes
    await m.unmount()
  })

  it('header checkbox is disabled when every visible row is Jobber-linked', async () => {
    const m = await mount(inbox([
      person({ name: 'Judy Jobber', jobberRef: '111', created: daysAgo(2) }),
      person({ name: 'Jack Jobber', jobberRef: '222', created: daysAgo(2) }),
    ]))
    expect(headerCheckbox(m.host)!.disabled).toBe(true)
    await m.unmount()
  })

  it('long-press on a row still enters selection with that row selected; the release click is swallowed', async () => {
    const a = person({ name: 'Alice Apple' })
    const b = person({ name: 'Bob Berry' })
    const m = await mount(inbox([a, b]))

    // Rows remount on every render — re-query after each state change.
    await act(async () => {
      const row = rowByName(m.host, 'Alice Apple')!
      row.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      await new Promise(r => setTimeout(r, 600)) // past the 500ms threshold
      row.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(rowCheckboxes(m.host)).toHaveLength(2) // mode entered
    expect(m.host.textContent).toContain('1 selected')

    // the click that trails the long-press release is swallowed…
    await click(rowByName(m.host, 'Alice Apple')!)
    expect(m.host.textContent).toContain('1 selected')
    // …and the NEXT click toggles normally
    await click(rowByName(m.host, 'Alice Apple')!)
    expect(m.host.textContent).toContain('0 selected')
    await m.unmount()
  })
})

// ═══ selection mechanics ═══════════════════════════════════
describe('selection mechanics', () => {
  it('row clicks toggle; count chip tracks; Cancel exits + clears', async () => {
    const a = person({ name: 'Alice Apple' })
    const b = person({ name: 'Bob Berry' })
    const m = await mount(inbox([a, b]))

    await enterSelectEmpty(m.host)
    expect(m.host.textContent).toContain('0 selected')

    await click(rowByName(m.host, 'Alice Apple')!)
    expect(m.host.textContent).toContain('1 selected')
    expect(buttonByText(m.host, 'Remove (1)')).toBeTruthy()

    // toggling off
    await click(rowByName(m.host, 'Alice Apple')!)
    expect(m.host.textContent).toContain('0 selected')
    expect(buttonByText(m.host, 'Remove (0)')).toBeFalsy()

    // Cancel exits selection mode AND clears the set
    await click(rowByName(m.host, 'Bob Berry')!)
    await click(buttonByText(m.host, 'Cancel')!)
    expect(rowCheckboxes(m.host)).toHaveLength(0)
    expect(patches).toHaveLength(0) // selection alone never writes
    await enterSelectEmpty(m.host)
    expect(m.host.textContent).toContain('0 selected')
    await m.unmount()
  })

  it('in selection mode row clicks select — they do NOT open the PersonCard; after exit they do again', async () => {
    const p = person({ name: 'Alice Apple' })
    const onOpenPerson = vi.fn()
    const m = await mount(inbox([p], { onOpenPerson }))

    await enterSelectEmpty(m.host)
    await click(rowByName(m.host, 'Alice Apple')!)
    expect(onOpenPerson).not.toHaveBeenCalled()

    await click(buttonByText(m.host, 'Cancel')!)
    await click(rowByName(m.host, 'Alice Apple')!)
    expect(onOpenPerson).toHaveBeenCalledWith(p)
    await m.unmount()
  })
})

// ═══ select-all respects filters ═══════════════════════════
describe('select-all-visible', () => {
  it('respects active filters: only visible rows are selected and removed', async () => {
    const withPhoneA = person({ name: 'Alice Apple' })
    const withPhoneB = person({ name: 'Bob Berry' })
    const phoneless = person({ name: 'Nadia NoPhone', phone: '' })
    const m = await mount(inbox([withPhoneA, withPhoneB, phoneless]))
    expect(m.host.textContent).toContain('Nadia NoPhone')

    // Apply 'Has phone' through the real popover — the same filters the
    // selection universe must respect.
    await click(buttonByText(m.host, 'Filter & sort')!)
    await click(buttonByText(m.host, 'Has phone')!)
    expect(m.host.textContent).not.toContain('Nadia NoPhone') // filtered out

    // the top-left checkbox selects only what the filters left visible
    await enterSelectAll(m.host)
    expect(m.host.textContent).toContain('2 selected')

    await click(buttonByText(m.host, 'Remove (2)')!)
    expect(patches.map(x => x.id).sort()).toEqual([withPhoneA.id, withPhoneB.id].sort())
    expect(patches.every(x => x.body.is_junk === true)).toBe(true)
    await m.unmount()
  })

  it("bulk bar 'Select all' stays and mirrors the header checkbox: Clear selection when everything is selected", async () => {
    const m = await mount(inbox([person({ name: 'Alice Apple' })]))
    await enterSelectAll(m.host)
    expect(buttonByText(m.host, 'Clear selection')).toBeTruthy()
    await click(buttonByText(m.host, 'Clear selection')!)
    expect(m.host.textContent).toContain('0 selected')
    expect(buttonByText(m.host, 'Select all (1)')).toBeTruthy()
    await m.unmount()
  })
})

// ═══ bulk remove + undo ════════════════════════════════════
describe('bulk Remove (mark-junk semantics) + batch Undo', () => {
  it('removes the selected rows via is_junk=true, leaves others, exits selection; Undo restores ALL removed', async () => {
    const a = person({ name: 'Alice Apple' })
    const b = person({ name: 'Bob Berry' })
    const keep = person({ name: 'Karla Keeper' })
    const m = await mount(inbox([a, b, keep]))

    await enterSelectEmpty(m.host)
    await click(rowByName(m.host, 'Alice Apple')!)
    await click(rowByName(m.host, 'Bob Berry')!)
    await click(buttonByText(m.host, 'Remove (2)')!)

    expect(patches.map(x => x.id).sort()).toEqual([a.id, b.id].sort())
    expect(patches.every(x => x.body.is_junk === true)).toBe(true)
    expect(m.host.textContent).not.toContain('Alice Apple')
    expect(m.host.textContent).not.toContain('Bob Berry')
    expect(m.host.textContent).toContain('Karla Keeper')
    expect(rowCheckboxes(m.host)).toHaveLength(0) // selection mode exited

    // Batch undo — every removed row PATCHed back and re-rendered.
    await clickUndo(lastToast)
    const undos = patches.slice(2)
    expect(undos.map(x => x.id).sort()).toEqual([a.id, b.id].sort())
    expect(undos.every(x => x.body.is_junk === false)).toBe(true)
    expect(m.host.textContent).toContain('Alice Apple')
    expect(m.host.textContent).toContain('Bob Berry')
    await m.unmount()
  })

  it('N>5 requires the confirm step: no writes until confirmed, Keep backs out with selection intact', async () => {
    const six = Array.from({ length: 6 }, (_, i) => person({ name: `Bulk Lead${i}` }))
    const m = await mount(inbox(six))

    await enterSelectAll(m.host) // header checkbox: mode + all 6 selected
    await click(buttonByText(m.host, 'Remove (6)')!)

    // Confirm step, not a write
    expect(patches).toHaveLength(0)
    expect(m.host.textContent).toContain('Remove 6 leads?')

    // Keep → back to armed state, selection intact, still no writes
    await click(buttonByText(m.host, 'Keep')!)
    expect(patches).toHaveLength(0)
    expect(m.host.textContent).not.toContain('Remove 6 leads?')
    expect(m.host.textContent).toContain('6 selected')

    // Confirm for real
    await click(buttonByText(m.host, 'Remove (6)')!)
    await click(buttonByText(m.host, 'Remove 6')!)
    expect(patches).toHaveLength(6)
    expect(patches.every(x => x.body.is_junk === true)).toBe(true)
    await m.unmount()
  })

  it('N<=5 removes without a confirm step', async () => {
    const five = Array.from({ length: 5 }, (_, i) => person({ name: `Bulk Lead${i}` }))
    const m = await mount(inbox(five))
    await enterSelectAll(m.host)
    await click(buttonByText(m.host, 'Remove (5)')!)
    expect(patches).toHaveLength(5)
    await m.unmount()
  })
})

// ═══ linked exclusion (Jobber-owns-deletion rule) ══════════
describe('Jobber-linked rows in the Inbox', () => {
  it('linked row: disabled grayed checkbox titled "Managed in Jobber"; select-all + row click both skip it; Remove never touches it', async () => {
    const linked = person({ name: 'Judy Jobber', jobberRef: '12345' })
    const free = person({ name: 'Frank Free' })
    const m = await mount(inbox([linked, free]))
    expect(m.host.textContent).toContain('Judy Jobber') // renders normally

    // header select-all skips the linked row: only the unlinked one lands
    await enterSelectAll(m.host)
    expect(m.host.textContent).toContain('1 selected')
    const linkedBox = rowCheckboxes(m.host).find(c => c.title === 'Managed in Jobber')
    expect(linkedBox).toBeTruthy()
    expect(linkedBox!.disabled).toBe(true)

    // clicking the linked row cannot select it
    await click(rowByName(m.host, 'Judy Jobber')!)
    expect(m.host.textContent).toContain('1 selected')

    await click(buttonByText(m.host, 'Remove (1)')!)
    expect(patches).toHaveLength(1)
    expect(patches[0].id).toBe(free.id)
    expect(m.host.textContent).toContain('Judy Jobber') // untouched
    await m.unmount()
  })

  it("linked row's ··· menu has no 'Mark as junk' (Dismiss stays); unlinked keeps it", async () => {
    const linked = person({ name: 'Judy Jobber', jobberRef: '12345' })
    const m = await mount(inbox([linked]))
    await click(m.host.querySelector('button[aria-label="More"]')!)
    expect(menuButton('Dismiss')).toBeTruthy()
    expect(menuButton('Mark as junk')).toBeFalsy()
    await m.unmount()

    const m2 = await mount(inbox([person({ name: 'Frank Free' })]))
    await click(m2.host.querySelector('button[aria-label="More"]')!)
    expect(menuButton('Mark as junk')).toBeTruthy()
    await m2.unmount()
  })
})

// ═══ ClientProfile + PersonCard ··· guards ═════════════════
describe('card menus enforce the linked guard', () => {
  it('ClientProfile: junk menu present for unlinked, GONE for jobber-linked', async () => {
    const m = await mount(
      <ClientProfile clientId="lead-9" onClose={() => {}} setToast={setToast} />
    )
    expect(m.host.querySelector('button[aria-label="More"]')).toBeTruthy()
    await click(m.host.querySelector('button[aria-label="More"]')!)
    expect(buttonByText(m.host, 'Mark as junk')).toBeTruthy()
    await m.unmount()

    profileOver = { client: { jobber_client_id: 'jc-77' } }
    const m2 = await mount(
      <ClientProfile clientId="lead-9" onClose={() => {}} setToast={setToast} />
    )
    expect(m2.host.textContent).toContain('Dana Client') // profile loaded
    expect(m2.host.querySelector('button[aria-label="More"]')).toBeFalsy()
    await m2.unmount()
  })

  it('PersonCard: junk menu present for unlinked, GONE when person.jobberRef or profile jobber_client_id is set', async () => {
    const m = await mount(
      <PersonCard person={person({ name: 'Frank Free' })} onClose={() => {}} setToast={setToast} />
    )
    expect(m.host.querySelector('button[aria-label="More"]')).toBeTruthy()
    await m.unmount()

    const m2 = await mount(
      <PersonCard person={person({ name: 'Judy Jobber', jobberRef: '12345' })} onClose={() => {}} setToast={setToast} />
    )
    expect(m2.host.querySelector('button[aria-label="More"]')).toBeFalsy()
    await m2.unmount()

    profileOver = { client: { jobber_client_id: 'jc-77' } }
    const m3 = await mount(
      <PersonCard person={person({ name: 'Linda Linked' })} onClose={() => {}} setToast={setToast} />
    )
    expect(m3.host.querySelector('button[aria-label="More"]')).toBeFalsy()
    await m3.unmount()
  })
})

// ═══ source guards ═════════════════════════════════════════
describe('wiring', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

  it('the junk PATCH 409s server-side on jobber-linked leads (enforcement, not just browser gates)', () => {
    const route = src('app/api/leads/[id]/route.ts')
    expect(route).toMatch(/jobber_linked_junk_rejected/)
    expect(route).toMatch(/patch\.is_junk === true && existing\.jobber_client_id/)
  })

  it('classic PersonPanel delete stays guarded behind !person.jobberRef', () => {
    const hub = src('components/BeeHub.jsx')
    // The 🗑 trigger renders only for unlinked records — the guard the
    // sweep verified still holds.
    expect(hub).toMatch(/!person\.jobberRef &&[\s\S]{0,600}setPopup\("delete"\)/)
  })
})
