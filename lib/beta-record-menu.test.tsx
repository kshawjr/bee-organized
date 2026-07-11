// @vitest-environment happy-dom
// RecordMenu — the record masthead ··· overflow menu (EngagementPanel's
// only door to the Close Won/Lost wizards + Reopen).
//
// Regression: the menu "opened" (state flipped, portal mounted) but was
// INVISIBLE and unclickable — no JS error, no visible response. Root cause
// was stacking, not interaction: the body-portal used the inbox's z-80,
// but this menu's home (EngagementPanel masthead) lives inside
// OverlayShell's fixed scrim at z-10005, so the portal rendered BEHIND the
// overlay. Covers:
//   - a trigger click OPENS the menu and it STAYS open (not eaten by the
//     document outside-click closer on the same opening click)
//   - a menu-item click fires that item's handler and closes the menu
//   - outside-click closes; a click INSIDE the portal does not
//   - Esc closes
//   - source/stacking guard: the portal outranks the overlay layer (10005)
//     so a menu spawned from inside an overlay floats OVER it
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import RecordMenu from '@/components/hive/shared/RecordMenu'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

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

const trigger = () => document.querySelector('[data-bee-record-menu-trigger]') as HTMLButtonElement
const menu = () => document.querySelector('[data-bee-record-menu]') as HTMLElement | null
const itemButton = (text: string) =>
  [...document.querySelectorAll('[data-bee-record-menu] button')]
    .find(b => (b.textContent || '').trim() === text) as HTMLButtonElement | undefined

const items = (won: () => void, lost: () => void, reopen: () => void) => ([
  { key: 'won', label: 'Mark as Closed Won', onClick: won },
  { key: 'lost', label: 'Mark as Closed Lost', onClick: lost },
  { key: 'reopen', label: 'Reopen', onClick: reopen },
])

beforeEach(() => { document.body.innerHTML = '' })

describe('open / stay-open', () => {
  it('a trigger click opens the menu AND it stays open (no self-close on the opening click)', async () => {
    const m = await mount(<RecordMenu items={items(() => {}, () => {}, () => {})} />)
    expect(menu()).toBeFalsy()

    await click(trigger())

    // opened — and still present after the click + effects settle inside
    // act(): the document outside-click closer must NOT eat the very click
    // that opened it.
    const el = menu()
    expect(el, 'menu must be open after the trigger click').toBeTruthy()
    expect(el!.parentElement).toBe(document.body)
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    for (const label of ['Mark as Closed Won', 'Mark as Closed Lost', 'Reopen']) {
      expect(itemButton(label), `menu offers "${label}"`).toBeTruthy()
    }
    await m.unmount()
  })

  it('re-clicking the trigger toggles it closed', async () => {
    const m = await mount(<RecordMenu items={items(() => {}, () => {}, () => {})} />)
    await click(trigger())
    expect(menu()).toBeTruthy()
    await click(trigger())
    expect(menu()).toBeFalsy()
    await m.unmount()
  })
})

describe('item clicks fire handlers', () => {
  it('clicking a menu item fires exactly that handler and closes the menu', async () => {
    const won = vi.fn(); const lost = vi.fn(); const reopen = vi.fn()
    const m = await mount(<RecordMenu items={items(won, lost, reopen)} />)

    await click(trigger())
    await click(itemButton('Mark as Closed Lost')!)

    expect(lost).toHaveBeenCalledTimes(1)
    expect(won).not.toHaveBeenCalled()
    expect(reopen).not.toHaveBeenCalled()
    expect(menu(), 'a pick closes the menu').toBeFalsy()
    await m.unmount()
  })
})

describe('close behaviors', () => {
  it('outside click closes; a click INSIDE the portal does not fire any handler', async () => {
    const won = vi.fn(); const lost = vi.fn(); const reopen = vi.fn()
    const m = await mount(<RecordMenu items={items(won, lost, reopen)} />)
    await click(trigger())
    const el = menu()!

    // inside the portal chrome (its padding, not a button) — stays open
    await click(el)
    expect(menu()).toBeTruthy()

    // genuinely outside — closes, nothing fired
    await click(document.body)
    expect(menu()).toBeFalsy()
    expect(won).not.toHaveBeenCalled()
    expect(lost).not.toHaveBeenCalled()
    expect(reopen).not.toHaveBeenCalled()
    await m.unmount()
  })

  it('Esc closes the open menu', async () => {
    const m = await mount(<RecordMenu items={items(() => {}, () => {}, () => {})} />)
    await click(trigger())
    expect(menu()).toBeTruthy()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(menu()).toBeFalsy()
    await m.unmount()
  })
})

describe('stacking guard — the actual bug', () => {
  it('the open portal outranks the OverlayShell scrim (z 10005) so it is not buried', async () => {
    const m = await mount(<RecordMenu items={items(() => {}, () => {}, () => {})} />)
    await click(trigger())
    const z = Number(menu()!.style.zIndex)
    expect(z).toBeGreaterThan(10005)
    await m.unmount()
  })

  it('source: portal zIndex is above the overlay layer, not the inbox z-80', () => {
    const src = readFileSync(join(process.cwd(), 'components/hive/shared/RecordMenu.jsx'), 'utf8')
    const zMatch = src.match(/zIndex:\s*(\d+),\s*background: T\.surface\.raised/)
    expect(zMatch, 'portal declares a zIndex').toBeTruthy()
    expect(Number(zMatch![1])).toBeGreaterThan(10005)
  })

  it('source: still re-anchors on scroll (capture) + resize, and stops propagation on the trigger', () => {
    const src = readFileSync(join(process.cwd(), 'components/hive/shared/RecordMenu.jsx'), 'utf8')
    expect(src).toMatch(/addEventListener\('scroll', place, true\)/)
    expect(src).toMatch(/addEventListener\('resize', place\)/)
    // the trigger stops propagation so its own click never reaches the
    // document outside-click closer
    expect(src).toMatch(/data-bee-record-menu-trigger[\s\S]*?onClick=\{\(ev\) => \{ ev\.stopPropagation\(\)/)
  })
})
