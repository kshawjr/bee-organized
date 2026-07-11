// @vitest-environment happy-dom
// Inbox ··· menu clip fix. The row cards keep overflow:hidden (it's what
// clips rows to the 12px radius), which used to amputate the
// position:absolute menu at the card edge — worst on the LAST row, where
// the menu was fully lost. The fix portals the open menu to <body> with
// fixed coords derived from its ··· trigger. Covers:
//   - first AND last row: menu portaled out of the clipped card, all
//     items present and interactable (a pick fires the row's PATCH)
//   - only one menu at a time; re-click toggles closed
//   - outside-click closes; clicks INSIDE the portal do not
//   - Esc closes
//   - source guards: cardStyle keeps overflow:hidden, the menu
//     re-anchors on scroll (capture) + resize, and the mobile/desktop
//     horizontal anchor semantics survived the portal move
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

let seq = 0
const person = (over: any = {}) => ({
  id: `p-${++seq}`,
  name: `Lead ${seq}`,
  email: 'lead@email.com',
  phone: '(561) 555-0199',
  locationId: 'loc-uuid-1',
  created: daysAgo(seq), // distinct ages keep the newest-first order stable
  isJunk: false,
  snoozeUntil: null,
  inboxDismissedAt: null,
  jobberRef: null,
  outreachTimeline: [],
  ...over,
})

let patches: Array<{ id: string; body: any }> = []
const installFetch = () => {
  patches = []
  ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
    const u = String(url)
    if (/\/api\/leads\/[^/]+$/.test(u) && opts.method === 'PATCH') {
      patches.push({ id: u.split('/').pop()!, body: JSON.parse(opts.body) })
    }
    return { ok: true, status: 200, json: async () => ({}) }
  })
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})

const inbox = (people: any[], over: any = {}) => (
  <InboxScreen people={people} engagements={[]} locFilter="all" setToast={() => {}} {...over} />
)

const moreButtons = (host: Element) =>
  [...host.querySelectorAll('button[aria-label="More"]')] as HTMLButtonElement[]
const openMenu = () => document.querySelector('[data-bee-row-menu]') as HTMLElement | null
const menuButton = (text: string) =>
  [...document.querySelectorAll('[data-bee-row-menu] button')].find(b => (b.textContent || '').trim() === text)

// The full portal-escape contract for whichever row's menu is open.
const expectUnclipped = (host: Element) => {
  const menu = openMenu()
  expect(menu, 'menu must render').toBeTruthy()
  // OUT of the overflow:hidden card entirely — under <body>, fixed.
  expect(menu!.parentElement).toBe(document.body)
  expect(host.contains(menu!)).toBe(false)
  expect(menu!.closest('.bee-inbox-row')).toBeNull()
  expect(menu!.style.position).toBe('fixed')
  for (const label of ['Snooze until tomorrow', 'Snooze until next week', 'Dismiss', 'Mark as junk']) {
    expect(menuButton(label), `menu offers "${label}"`).toBeTruthy()
  }
  return menu!
}

beforeEach(() => {
  installFetch()
  ;(globalThis as any).window?.localStorage?.clear?.()
})

describe('portal escapes the clipped card', () => {
  it('FIRST row: menu fully rendered outside the card and interactable', async () => {
    const people = [person(), person(), person(), person()]
    const m = await mount(inbox(people))
    expect(openMenu()).toBeFalsy()

    await click(moreButtons(m.host)[0])
    expectUnclipped(m.host)

    // interactable: a pick actually fires this row's write
    await click(menuButton('Dismiss')!)
    expect(patches).toHaveLength(1)
    expect(Object.keys(patches[0].body)).toEqual(['inbox_dismissed_at'])
    expect(openMenu()).toBeFalsy() // pick closes
    await m.unmount()
  })

  it('LAST row: same contract — the row the old in-card menu lost completely', async () => {
    const people = [person(), person(), person(), person()]
    const m = await mount(inbox(people))
    const triggers = moreButtons(m.host)

    await click(triggers[triggers.length - 1])
    expectUnclipped(m.host)

    // the pick lands on the LAST row's lead (newest-first sort → oldest
    // created = last row)
    const lastRow = [...m.host.querySelectorAll('.bee-inbox-row')].pop()!
    const lastName = people.find(p => (lastRow.textContent || '').includes(p.name))!
    await click(menuButton('Dismiss')!)
    expect(patches).toHaveLength(1)
    expect(patches[0].id).toBe(lastName.id)
    await m.unmount()
  })

  it('one menu at a time; re-clicking its ··· toggles it closed', async () => {
    const m = await mount(inbox([person(), person()]))

    // Re-query the triggers after every click: Row remounts its DOM on
    // each render, so held elements go stale.
    await click(moreButtons(m.host)[0])
    expect(document.querySelectorAll('[data-bee-row-menu]')).toHaveLength(1)
    await click(moreButtons(m.host)[1])
    expect(document.querySelectorAll('[data-bee-row-menu]')).toHaveLength(1)
    await click(moreButtons(m.host)[1])
    expect(openMenu()).toBeFalsy()
    await m.unmount()
  })
})

describe('close behaviors', () => {
  it('outside click closes; a click INSIDE the portal menu does not', async () => {
    const m = await mount(inbox([person()]))
    await click(moreButtons(m.host)[0])
    const menu = openMenu()!

    // inside the portal (non-button padding) — stays open
    await click(menu)
    expect(openMenu()).toBeTruthy()

    // genuinely outside — closes, and nothing was written
    await click(document.body)
    expect(openMenu()).toBeFalsy()
    expect(patches).toHaveLength(0)
    await m.unmount()
  })

  it('Esc closes the open menu', async () => {
    const m = await mount(inbox([person()]))
    await click(moreButtons(m.host)[0])
    expect(openMenu()).toBeTruthy()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(openMenu()).toBeFalsy()
    await m.unmount()
  })
})

describe('source guards', () => {
  const src = readFileSync(join(process.cwd(), 'components/hive/InboxScreen.jsx'), 'utf8')

  it('cardStyle keeps overflow:hidden — the 12px radius clipping the portal exists to survive', () => {
    expect(src).toMatch(/cardStyle = \{[^}]*overflow: 'hidden'/)
  })

  it('menu re-anchors on scroll (capture phase, so scrolling ancestors count) and resize', () => {
    expect(src).toMatch(/addEventListener\('scroll', place, true\)/)
    expect(src).toMatch(/addEventListener\('resize', place\)/)
  })

  it('horizontal anchors survived the portal: mobile grows rightward from the trigger, desktop hugs its right edge', () => {
    // mobile: left edge of the trigger, viewport-clamped
    expect(src).toMatch(/Math\.min\(r\.left, window\.innerWidth - w - 8\)/)
    // desktop: menu's right edge on the trigger's right edge
    expect(src).toMatch(/Math\.max\(8, r\.right - w\)/)
  })

  it('flips above the trigger when the viewport bottom would clip it (last rows)', () => {
    expect(src).toMatch(/below \+ h > window\.innerHeight - 8/)
    expect(src).toMatch(/r\.top - h - 4/)
  })
})
