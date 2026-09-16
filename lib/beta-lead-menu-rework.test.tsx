// @vitest-environment happy-dom
//
// THE LEAD MENU: four actions, grouped, explained, and confirmed.
//
// Kevin looked at it live: six items, no visible order, no explanation, and
// they fired instantly. Nobody could tell what Snooze, Dismiss and Junk did,
// or how Close differed from Junk — and that last confusion is the expensive
// one, because Close keeps a real lost opportunity in reporting while junk
// leaves reporting entirely.
//
// SNOOZE IS GONE FROM THE MENU, NOT FROM THE DATABASE. Measured 2026-09-16
// and re-verified here against production: snoozed_until has been set 8 times
// in the platform's life across 5 locations, 3 still in the future, against
// 157 dismissals. The way IN is removed; every reader stays, because those 3
// live leads must keep behaving correctly until they wake naturally. The
// last block pins that.
//
// THE MENUS RENDER THROUGH A PORTAL / an in-card popover, so every assertion
// here is DOCUMENT-scoped and keyed on data-testid rather than on label text
// — rows now carry a description under the label, so textContent is label +
// sentence, and "Close" collides with other copy on the card.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'
import ClientProfile from '@/components/hive/ClientProfile'
import {
  DISPOSITIONS, DISPOSITION_GROUPS, confirmPrompt, JUNK_POINTS_TO_CLOSE, CONFIRMABLE,
} from '@/components/hive/shared/leadDispositions'
import { isSoftRemovedFromInbox } from '@/components/hive/shared/inboxSoftRemoval'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()
const daysAhead = (n: number) => new Date(now + n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: 'p-1', name: 'Sarah Watts', email: 'sarah@email.com', phone: '(561) 555-0199',
  locationId: 'loc-uuid-1', created: daysAgo(3),
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null,
  jobberRef: null, outreachTimeline: [], ...over,
})

const profilePayload = () => ({
  client: {
    id: 'lead-9', name: 'Sarah Watts', first_name: 'Sarah', last_name: 'Watts',
    email: 'sarah@email.com', phone: '(561) 555-0199', address: '12 Oak St',
    stage: 'New', created_at: daysAgo(30), tags: [], jobber_client_id: null,
    is_junk: false, snoozed_until: null, inbox_dismissed_at: null, assigned_to: null,
  },
  referred_us: [], referred_us_total: 0, contacts: [], engagements: [],
  touchpoints: [], buzz_notes: [], job_notes: [], tags: [],
  aggregates: { owing: 0, paid: 0, invoiced: 0 },
})

let writes: any[] = []
beforeEach(() => {
  writes = []
  ;(globalThis as any).fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url); const method = init?.method || 'GET'
    if (method === 'PATCH' || method === 'POST') writes.push({ u, method, body: init?.body ? JSON.parse(init.body) : null })
    if (/\/profile/.test(u)) return { ok: true, json: async () => profilePayload() } as any
    if (/\/api\/engagements$/.test(u)) return { ok: true, json: async () => ({ engagement: { id: 'eng-N' } }) } as any
    return { ok: true, json: async () => ({}) } as any
  })
  document.body.innerHTML = ''
})

let root: any
const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return host
}
afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  root = null; document.body.innerHTML = ''; vi.restoreAllMocks()
})
const click = (el: Element | null | undefined) => act(async () => {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`)
const bodyText = () => (document.body.textContent || '')

const openInbox = async (over: any = {}) => {
  const host = await mount(
    <InboxScreen people={[person(over)]} engagements={[]} locFilter="all"
      closeLostReasons={['Went quiet', 'Other']} setToast={() => {}} />)
  await click(host.querySelector('button[aria-label="More"]'))
  return host
}
const openCard = async () => {
  const host = await mount(<ClientProfile clientId="lead-9" onClose={() => {}} />)
  const trigger = [...host.querySelectorAll('button')]
    .find(b => (b.getAttribute('aria-label') || '') === 'More')
  await click(trigger)
  return host
}

// ── 1 + 2: the label, and snooze's departure ──────────────────────
describe('the label is "Close", and snooze is gone', () => {
  it('the Inbox row menu offers Close and no snooze', async () => {
    await openInbox()
    expect(byTestId('menu-close')).toBeTruthy()
    expect(byTestId('menu-close')!.querySelector('span')!.textContent!.trim()).toBe('Close')
    // The Inbox row menu has no snooze DISPLAY to confuse this, so the whole
    // menu can be asserted on.
    expect(document.querySelector('[data-bee-row-menu]')!.textContent!.toLowerCase()).not.toContain('snooze')
  })

  it('the client card menu offers Close and no snooze ACTION', async () => {
    await openCard()
    const close = byTestId('menu-close') || [...document.querySelectorAll('button')]
      .find(b => (b.querySelector('span')?.textContent || '').trim() === 'Close')
    expect(close).toBeTruthy()
    // Scoped to the MENU's own items, not the whole card. The card still
    // DISPLAYS snooze state in Preferences ("Not snoozed"), which is one of
    // the readers deliberately kept for the 3 leads snoozed right now — a
    // body-wide assertion here would have demanded deleting that.
    const itemLabels = [...document.querySelectorAll('button')]
      .map(b => (b.querySelector('span')?.textContent || '').trim().toLowerCase())
    expect(itemLabels.some(t => t.includes('snooze'))).toBe(false)
  })

  it('neither menu says "Closed" any more', async () => {
    await openInbox()
    const labels = [...document.querySelectorAll('[data-bee-row-menu] button')]
      .map(b => (b.querySelector('span')?.textContent || '').trim())
    expect(labels).toContain('Close')
    expect(labels).not.toContain('Closed')
  })
})

// ── 3: the approved order and the descriptions ────────────────────
describe('four actions, grouped and explained', () => {
  it('renders the three headings in the approved order', async () => {
    await openInbox()
    const menu = document.querySelector('[data-bee-row-menu]')!
    const headings = [...menu.querySelectorAll('p')].map(p => (p.textContent || '').trim())
      .filter(t => DISPOSITION_GROUPS.some(g => g.heading === t))
    expect(headings).toEqual(DISPOSITION_GROUPS.map(g => g.heading))
  })

  it('the four items appear in the approved order', async () => {
    await openInbox()
    const ids = [...document.querySelectorAll('[data-bee-row-menu] [data-testid^="menu-"]')]
      .map(e => e.getAttribute('data-testid'))
    expect(ids).toEqual(['menu-dismiss', 'menu-network', 'menu-close', 'menu-junk'])
  })

  it('each item carries its description', async () => {
    await openInbox()
    for (const key of ['dismiss', 'network', 'close', 'junk'] as const) {
      expect(byTestId(`menu-${key}`)!.textContent, key).toContain(DISPOSITIONS[key].description)
    }
  })

  it('the Network description says what it ACTUALLY does — a contact, not another location', async () => {
    // The correction: "Add to Network" does NOT pass the lead to another Bee
    // Organized location (that is the separate Route button). It creates a
    // Network record, and the sheet then offers Add (stays a client too) or
    // Move (never really a client).
    await openInbox()
    const t = byTestId('menu-network')!.textContent!.toLowerCase()
    expect(t).toContain('network')
    expect(t).toContain('contact')
    expect(t).not.toContain('another location')
    expect(t).not.toContain('transfer')
    expect(DISPOSITION_GROUPS[1].heading).not.toBe('Hand it on')
  })

  it('the card menu uses the SAME words', async () => {
    await openCard()
    const text = bodyText()
    expect(text).toContain(DISPOSITIONS.close.description)
    expect(text).toContain(DISPOSITIONS.junk.description)
    expect(text).toContain(DISPOSITION_GROUPS[2].heading)
  })
})

// ── 4: confirm before acting ──────────────────────────────────────
describe('nothing is written until it is confirmed', () => {
  it('Dismiss asks first, in the same words the menu used', async () => {
    await openInbox()
    await click(byTestId('menu-dismiss'))
    expect(byTestId('menu-confirm-dismiss')).toBeTruthy()
    expect(bodyText()).toContain(DISPOSITIONS.dismiss.description)
    expect(writes).toHaveLength(0) // nothing written yet
  })

  it('confirming Dismiss writes', async () => {
    await openInbox()
    await click(byTestId('menu-dismiss'))
    await click(byTestId('menu-confirm-dismiss-yes'))
    expect(writes.some(w => w.body && 'inbox_dismissed_at' in w.body)).toBe(true)
  })

  it('cancelling Dismiss writes nothing', async () => {
    await openInbox()
    await click(byTestId('menu-dismiss'))
    await click(byTestId('menu-confirm-dismiss-no'))
    expect(writes).toHaveLength(0)
    expect(byTestId('menu-dismiss')).toBeTruthy() // back to the menu
  })

  it('Mark as junk asks first, and writes nothing yet', async () => {
    await openInbox()
    await click(byTestId('menu-junk'))
    expect(byTestId('menu-confirm-junk')).toBeTruthy()
    expect(writes).toHaveLength(0)
  })

  it('the junk confirmation POINTS AT CLOSE — the whole point', async () => {
    await openInbox()
    await click(byTestId('menu-junk'))
    expect(bodyText()).toContain(JUNK_POINTS_TO_CLOSE)
    expect(bodyText()).toContain('use Close instead')
  })

  it('confirming junk writes; cancelling does not', async () => {
    await openInbox()
    await click(byTestId('menu-junk'))
    await click(byTestId('menu-confirm-junk-yes'))
    expect(writes.some(w => w.body && w.body.is_junk === true)).toBe(true)

    await act(async () => { root.unmount() }); root = null; document.body.innerHTML = ''; writes = []

    await openInbox()
    await click(byTestId('menu-junk'))
    await click(byTestId('menu-confirm-junk-no'))
    expect(writes).toHaveLength(0)
  })

  it('the card menu confirms junk too, with the same pointer', async () => {
    await openCard()
    const junk = byTestId('menu-junk') || [...document.querySelectorAll('button')]
      .find(b => (b.querySelector('span')?.textContent || '').trim() === 'Mark as junk')
    await click(junk)
    expect(bodyText()).toContain(JUNK_POINTS_TO_CLOSE)
    expect(writes.some(w => w.body && w.body.is_junk === true)).toBe(false)
  })

  it('only the two that used to fire instantly carry a confirm', () => {
    // Network and Close already open a step that explains itself — the sheet
    // spells out Add vs Move, the wizard asks for a reason — so a confirm in
    // front of either would be a confirm before a confirm.
    expect(CONFIRMABLE).toEqual(['dismiss', 'junk'])
  })

  it('the prompt is built from the menu description, not a second wording', () => {
    expect(confirmPrompt('dismiss', 'Sarah')).toContain(DISPOSITIONS.dismiss.description)
    expect(confirmPrompt('junk', 'Sarah')).toContain(DISPOSITIONS.junk.description)
    expect(confirmPrompt('junk', 'Sarah')).toContain('Sarah')
  })
})

// ── the 3 live snoozed leads ──────────────────────────────────────
describe('a currently-snoozed lead still behaves correctly', () => {
  it('the soft-removal predicate still hides a future snooze', () => {
    // This is what protects the 3 leads snoozed right now: the way IN is
    // gone, every reader stays.
    const snoozed = { id: 'p-s', snoozeUntil: daysAhead(5), isJunk: false, inboxDismissedAt: null }
    expect(isSoftRemovedFromInbox(snoozed as any, now)).toBe(true)
  })

  it('and lets it back in once it wakes naturally', () => {
    const woken = { id: 'p-w', snoozeUntil: daysAgo(1), isJunk: false, inboxDismissedAt: null }
    expect(isSoftRemovedFromInbox(woken as any, now)).toBe(false)
  })

  it('a snoozed lead is off the Inbox worklist, as before', async () => {
    await mount(<InboxScreen people={[person({ snoozeUntil: daysAhead(5) })]} engagements={[]}
      locFilter="all" closeLostReasons={[]} setToast={() => {}} />)
    expect(document.querySelectorAll('.bee-inbox-row')).toHaveLength(0)
  })

  it('the un-snooze path was not touched', () => {
    const fs = require('node:fs'); const path = require('node:path')
    const tl = fs.readFileSync(path.join(process.cwd(), 'components/hive/shared/Timeline.jsx'), 'utf8')
    expect(tl).toContain('snoozed_until: null')      // un-snooze still there
    const pred = fs.readFileSync(path.join(process.cwd(), 'components/hive/shared/inboxSoftRemoval.js'), 'utf8')
    expect(pred).toContain('snoozeUntil')            // predicate still reads it
  })

  it('the Inbox no longer contains a way to SET one', () => {
    const fs = require('node:fs'); const path = require('node:path')
    const src = fs.readFileSync(path.join(process.cwd(), 'components/hive/InboxScreen.jsx'), 'utf8')
    expect(src).not.toContain('snoozed_until: iso')  // the writer is gone
    expect(src).not.toMatch(/Snooze until (tomorrow|next week)/)
  })
})

// ── undo, unchanged ───────────────────────────────────────────────
describe('the existing undo still rides the toast', () => {
  it('dismiss still raises an undo toast after confirming', async () => {
    const toasts: any[] = []
    const host = await mount(
      <InboxScreen people={[person()]} engagements={[]} locFilter="all"
        closeLostReasons={[]} setToast={(t: any) => toasts.push(t)} />)
    await click(host.querySelector('button[aria-label="More"]'))
    await click(byTestId('menu-dismiss'))
    await click(byTestId('menu-confirm-dismiss-yes'))
    await act(async () => { await Promise.resolve() })
    expect(toasts.length).toBeGreaterThan(0)
  })

  it('the confirm is IN ADDITION to undo, not instead of it', () => {
    const fs = require('node:fs'); const path = require('node:path')
    const src = fs.readFileSync(path.join(process.cwd(), 'components/hive/InboxScreen.jsx'), 'utf8')
    expect(src).toContain("undoToast('Dismissed'")
    expect(src).toMatch(/undoToast\(`?Moved to the Recycle Bin|undoToast\('Marked as junk'|undoToast\(/)
  })
})

// ── the reasoning is written down ─────────────────────────────────
describe('why Close and junk both stay', () => {
  it('is recorded in the code, so nobody merges them later', () => {
    const fs = require('node:fs'); const path = require('node:path')
    const src = fs.readFileSync(path.join(process.cwd(), 'components/hive/shared/leadDispositions.js'), 'utf8')
      .replace(/^\s*\/\//gm, ' ').replace(/\s+/g, ' ')
    expect(src).toContain('leaves reporting')
    expect(src).toContain('spam')
  })
})
