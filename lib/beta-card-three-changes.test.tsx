// @vitest-environment happy-dom
//
// THE CLIENT CARD: snooze goes, Dismiss arrives.
//
// Two of Kevin's three rulings. THE THIRD — hiding "New engagement" when a
// client has never had one — WAS NOT BUILT, and the reason is measured, not
// preferred: 44 open engagements were founded by hand on a lead with no
// prior engagement, more than an hour after that lead arrived (so not the
// new-client sheet, which founds within seconds). 30 of them in the last 30
// days, across 19 different locations, average 237 days between the lead
// arriving and the work starting. That is owners reviving old leads, roughly
// daily, and it is exactly the case the rule would have hidden the button
// from. The brief said stop if owners rely on it. They do.
//
// 1) SNOOZE IS GONE FROM THE CARD. cd03c92 removed the two Inbox menu items
//    and kept the Preferences row; the ruling is that snooze goes. What stays
//    is the plumbing, because 3 leads are snoozed in production right now:
//    the column, isSoftRemovedFromInbox's future-snooze test, and the
//    Timeline's Un-snooze — now the ONLY hand-operated exit, which is what
//    made removing the Preferences row safe. Both halves are pinned below.
//
// 2) DISMISS IS ON THE CARD. Same action, field, confirmation, wording and
//    group as the Inbox's, out of leadDispositions so they cannot drift.
//
// Menus render through a PORTAL from the Inbox and IN-PLACE from the card, so
// every assertion is document-scoped and keyed on data-testid — labels
// collide with other copy on the card.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import ClientProfile from '@/components/hive/ClientProfile'
import InboxScreen from '@/components/hive/InboxScreen'
import PreferencesBlock from '@/components/hive/shared/PreferencesBlock'
import { isSoftRemovedFromInbox } from '@/components/hive/shared/inboxSoftRemoval'
import { DISPOSITIONS, DISPOSITION_GROUPS, confirmPrompt } from '@/components/hive/shared/leadDispositions'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()
const daysAhead = (n: number) => new Date(now + n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: 'p-1', name: 'Sarah Watts', email: 's@e.com', phone: '(561) 555-0199',
  locationId: 'loc-uuid-1', created: daysAgo(3),
  isJunk: false, snoozeUntil: null, inboxDismissedAt: null,
  jobberRef: null, outreachTimeline: [], ...over,
})

let profileOver: any = {}
const profilePayload = () => ({
  client: {
    id: 'lead-9', name: 'Sarah Watts', first_name: 'Sarah', last_name: 'Watts',
    email: 's@e.com', phone: '(561) 555-0199', address: '12 Oak St', stage: 'New',
    created_at: daysAgo(30), tags: [], jobber_client_id: null, is_junk: false,
    snoozed_until: null, snoozed_note: null, inbox_dismissed_at: null,
    assigned_to: null, marketing_opt_out: false, paused: false,
    ...(profileOver.client || {}),
  },
  referred_us: [], referred_us_total: 0, contacts: [],
  engagements: profileOver.engagements ?? [],
  touchpoints: [], buzz_notes: [], job_notes: [], tags: [],
  aggregates: { owing: 0, paid: 0, invoiced: 0 },
})

let writes: any[] = []
beforeEach(() => {
  writes = []; profileOver = {}
  ;(globalThis as any).fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url); const method = init?.method || 'GET'
    if (method === 'PATCH' || method === 'POST') {
      writes.push({ u, method, body: init?.body ? JSON.parse(init.body) : null })
    }
    if (/\/profile/.test(u)) return { ok: true, json: async () => profilePayload() } as any
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
const bodyText = () => document.body.textContent || ''

const openCard = async (props: any = {}) => {
  const host = await mount(<ClientProfile clientId="lead-9" onClose={() => {}} {...props} />)
  await click([...host.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '') === 'More'))
  return host
}
const openInbox = async () => {
  const host = await mount(<InboxScreen people={[person()]} engagements={[]} locFilter="all"
    closeLostReasons={['Went quiet']} setToast={() => {}} />)
  await click(host.querySelector('button[aria-label="More"]'))
  return host
}

// ── 1) snooze is gone from the card ───────────────────────────────
describe('no snooze control anywhere on the card', () => {
  it('the Preferences block offers none — not a status line, not a picker', async () => {
    await mount(<PreferencesBlock client={{ id: 'x', marketing_opt_out: false, snoozed_until: null, snoozed_note: null, paused: false }}
      openCount={0} onPatched={() => {}} setToast={() => {}} nowMs={now} />)
    const t = bodyText().toLowerCase()
    expect(t).not.toContain('snooze')
    expect(t).not.toContain('not snoozed')
  })

  it('not even for a lead that IS snoozed — the row is gone, not conditional', async () => {
    await mount(<PreferencesBlock client={{ id: 'x', marketing_opt_out: false, snoozed_until: daysAhead(5), snoozed_note: 'call after the holiday', paused: false }}
      openCount={0} onPatched={() => {}} setToast={() => {}} nowMs={now} />)
    expect(bodyText().toLowerCase()).not.toContain('snooze')
    expect(bodyText()).not.toContain('call after the holiday')
  })

  it('and nowhere on the whole card, menu open', async () => {
    profileOver = { client: { snoozed_until: daysAhead(5) } }
    await openCard()
    expect(bodyText().toLowerCase()).not.toContain('snooze')
  })

  it('the card can no longer WRITE a snooze', () => {
    const src = readFileSync(join(process.cwd(), 'components/hive/shared/PreferencesBlock.jsx'), 'utf8')
    expect(src).not.toContain('snoozed_until: until')
    expect(src).not.toMatch(/patchLead\(\{\s*snoozed_until/)
  })
})

describe('a snoozed lead still behaves correctly, and can still be woken', () => {
  it('the soft-removal predicate still hides a future snooze', () => {
    // This is what protects the 3 leads snoozed in production right now.
    expect(isSoftRemovedFromInbox({ id: 'p', snoozeUntil: daysAhead(5), isJunk: false, inboxDismissedAt: null } as any, now)).toBe(true)
  })

  it('and lets it back in once it wakes naturally', () => {
    expect(isSoftRemovedFromInbox({ id: 'p', snoozeUntil: daysAgo(1), isJunk: false, inboxDismissedAt: null } as any, now)).toBe(false)
  })

  it('it stays off the Inbox worklist', async () => {
    await mount(<InboxScreen people={[person({ snoozeUntil: daysAhead(5) })]} engagements={[]}
      locFilter="all" closeLostReasons={[]} setToast={() => {}} />)
    expect(document.querySelectorAll('.bee-inbox-row')).toHaveLength(0)
  })

  it('the Timeline is now the ONLY hand-operated exit, and it survives', () => {
    // Removing the Preferences row was only safe because this exists. If it
    // ever goes, the 3 snoozed leads become unwakeable by hand.
    const tl = readFileSync(join(process.cwd(), 'components/hive/shared/Timeline.jsx'), 'utf8')
    expect(tl).toContain('snoozed_until: null')      // the un-snooze PATCH
    expect(tl).toContain("action: 'unsnooze'")       // surfaced as a control
    expect(tl).toMatch(/Snoozed until/)              // the item it hangs off
  })

  it('and the column and its reader are untouched', () => {
    const pred = readFileSync(join(process.cwd(), 'components/hive/shared/inboxSoftRemoval.js'), 'utf8')
    expect(pred).toContain('snoozeUntil')
  })
})

// ── 2) Dismiss on the card ────────────────────────────────────────
describe('Dismiss is on the client card', () => {
  it('renders, in its approved group, with its description', async () => {
    await openCard()
    const item = byTestId('menu-dismiss')
    expect(item).toBeTruthy()
    expect(item!.querySelector('[data-menu-label]')!.textContent!.trim()).toBe(DISPOSITIONS.dismiss.label)
    expect(item!.textContent).toContain(DISPOSITIONS.dismiss.description)
    expect(bodyText()).toContain(DISPOSITION_GROUPS[0].heading) // "Take it off your list"
  })

  it('asks first, in the same words, and writes nothing yet', async () => {
    await openCard()
    await click(byTestId('menu-dismiss'))
    expect(byTestId('menu-confirm-dismiss')).toBeTruthy()
    expect(bodyText()).toContain(DISPOSITIONS.dismiss.description)
    expect(writes.filter(w => w.method === 'PATCH')).toHaveLength(0)
  })

  it('confirming writes the SAME field the Inbox one writes', async () => {
    await openCard()
    await click(byTestId('menu-dismiss'))
    await click(byTestId('menu-confirm-dismiss-yes'))
    const patch = writes.find(w => w.method === 'PATCH' && w.body && 'inbox_dismissed_at' in w.body)
    expect(patch).toBeTruthy()
    expect(patch.body.inbox_dismissed_at).toEqual(expect.any(String))
  })

  it('and logs the same attributed audit touchpoint', async () => {
    // Without actor:'session' the row records WHEN but never WHO — the gap
    // that left 84 historical dismissals unattributable.
    await openCard()
    await click(byTestId('menu-dismiss'))
    await click(byTestId('menu-confirm-dismiss-yes'))
    const tp = writes.find(w => /\/api\/touchpoints/.test(w.u))
    expect(tp).toBeTruthy()
    expect(tp.body.actor).toBe('session')
    expect(tp.body.kind).toBe('system')
  })

  it('cancelling writes nothing', async () => {
    await openCard()
    await click(byTestId('menu-dismiss'))
    await click(byTestId('menu-confirm-dismiss-no'))
    expect(writes.filter(w => w.method === 'PATCH')).toHaveLength(0)
  })

  it('the wording is the shared one, not a second copy for the card', () => {
    // "Your worklist" means the Inbox wherever the card was opened from —
    // inbox_dismissed_at is a property of the LEAD, not of the screen — so
    // the approved copy needed no card-specific version.
    const src = readFileSync(join(process.cwd(), 'components/hive/ClientProfile.jsx'), 'utf8')
    expect(src).toContain('DISPOSITIONS.dismiss.label')
    expect(src).toContain('DISPOSITIONS.dismiss.description')
    expect(src).toContain("confirmPrompt('dismiss'")
    expect(confirmPrompt('dismiss', 'Sarah')).toContain(DISPOSITIONS.dismiss.description)
  })

  it('it is hidden on a read-only card, like every other write item', async () => {
    await openCard({ readOnly: true })
    expect(byTestId('menu-dismiss')).toBeFalsy()
  })
})

// ── the Inbox is unchanged ────────────────────────────────────────
describe('the Inbox menu is unchanged', () => {
  it('still offers the same four in the same order', async () => {
    await openInbox()
    const ids = [...document.querySelectorAll('[data-bee-row-menu] [data-testid^="menu-"]')]
      .map(e => e.getAttribute('data-testid'))
    expect(ids).toEqual(['menu-dismiss', 'menu-network', 'menu-close', 'menu-junk'])
  })

  it('and still confirms dismiss the same way', async () => {
    await openInbox()
    await click(byTestId('menu-dismiss'))
    expect(byTestId('menu-confirm-dismiss')).toBeTruthy()
  })
})

// ── 3) the button is GONE — superseded 2026-09-16 ────────────────
// This block used to pin that "New engagement" STAYED, recording why I
// stopped on the stage-based rule. A third look settled it a different way:
// of 125 hand-founded engagements in 120 days, 47 stayed completely empty and
// can never move, and the other 78 would have been created by Send to Jobber
// anyway. Kevin removed the button. The evidence and the layout consequence
// are pinned in beta-remove-new-engagement; the two tests that lived here
// asserted the opposite and would now be actively misleading.
