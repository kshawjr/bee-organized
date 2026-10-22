// @vitest-environment happy-dom
//
// THE QUEUES REDESIGN of the corporate triage screen (design C), MOUNTED.
//
// Kevin could not scan the issue 233/306 screen or work it on a phone: three
// queue cards, five filters, a colour per status and per type, and the
// analysis + copy-prompt + draft-reply stacked inline under every row. What
// this pinned about its replacement — and, since THE TILES REDESIGN replaced
// the queues and the type tabs, what it pins now:
//
//   · SIX SECTIONS in tile order (Fix, Answer, Decide, Build, Still deciding,
//     Stuck), longest waiting first inside each; the queues' pure layer
//     (lib/feedback-triage-groups) is still pinned below — the cluster modal
//     reads it
//   · a tile is a filter; age (amber past 10, red past 21) is on the row
//   · closed items are reached through the Open / Closed filter
//   · the modal opens, walks with the arrows (buttons AND keys), closes on
//     Escape, and ignores the arrow keys while someone is typing
//   · NO PILLS: no status badge, no internal pill, no coloured chip anywhere
//     in the screen's source; inputs at 16px; nothing named `top`
//   · the CORPORATE-ONLY block renders for the elevated mount and not for an
//     owner mount — and the owner mount never even asks for the analysis.
//     (The route-level half of that guard is in
//     lib/beta-feedback-queues-redesign-routes.test.ts.)
//   · the reply box's line says what emails and what does not, truthfully,
//     including the one status that DOES email on its own (Fixed, issue 236)
//   · a save is ONE PATCH to the existing route, with the existing body shape
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import { T } from '@/components/hive/shared/tokens'
import {
  groupFeedbackForTriage, triageQueueOf, triageWaitingDays, sortLongestWaitingFirst,
  TRIAGE_GROUP_TYPE_ORDER, TRIAGE_OVERDUE_DAYS,
} from '@/lib/feedback-triage-groups'

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const base = {
  user_id: 'u2', submitter_name: 'Lynette Ewy', submitter_email: 'lynette@kc.com',
  location_id: 'loc-2', location_name: 'Kansas City', attachments: [], replies: [],
  admin_response: null, admin_response_at: null, reply_seen_at: null,
}
const item = (over: any) => ({ description: 'Some words.', status: 'submitted', ...base, ...over })

const teamReply = (n: number, id = 'r-team') => ({ id, author_id: 'admin-1', author_role: 'team', body: 'Can you send a screenshot?', created_at: daysAgo(n) })
const ownerReply = (n: number, id = 'r-owner') => ({ id, author_id: 'u2', author_role: 'owner', body: 'Here it is.', created_at: daysAgo(n) })

// ─── THE ORDER FIXTURE ────────────────────────────────────────────────
// Every type once in "Needs an answer", filed in the WRONG order on purpose,
// plus two bugs so "longest waiting first" is testable inside a type. Two
// replied items land in "Waiting on them"; one owner-wrote-back item must
// come BACK to "Needs an answer"; one closed item hides.
const ITEMS = [
  item({ id: 'dec', title: 'A decision', type: 'decision', is_internal: true, created_at: daysAgo(9), updated_at: daysAgo(9) }),
  item({ id: 'idea', title: 'An idea', type: 'feature', created_at: daysAgo(20), updated_at: daysAgo(20) }),
  item({ id: 'bug-new', title: 'Newer bug', type: 'bug', created_at: daysAgo(2), updated_at: daysAgo(2) }),
  item({ id: 'haz', title: 'A hazard', type: 'hazard', is_internal: true, created_at: daysAgo(4), updated_at: daysAgo(4) }),
  item({ id: 'q', title: 'A question', type: 'question', created_at: daysAgo(6), updated_at: daysAgo(6) }),
  item({ id: 'bug-old', title: 'Older bug', type: 'bug', created_at: daysAgo(30), updated_at: daysAgo(30) }),
  // We asked, they have not come back → Waiting on them (3 days).
  item({ id: 'asked', title: 'We asked them', type: 'bug', status: 'under_review', created_at: daysAgo(40), updated_at: daysAgo(3),
    admin_response: 'Can you send a screenshot?', admin_response_at: daysAgo(3), replies: [teamReply(3)] }),
  // We asked, they answered → back in Needs an answer (waiting 1 day, not 40).
  item({ id: 'back', title: 'They wrote back', type: 'bug', status: 'under_review', created_at: daysAgo(40), updated_at: daysAgo(1),
    admin_response: 'Can you send a screenshot?', admin_response_at: daysAgo(5), replies: [teamReply(5), ownerReply(1)] }),
  // A legacy single reply with no thread row → Waiting on them since the reply.
  item({ id: 'legacy', title: 'Legacy reply idea', type: 'feature', status: 'planned', created_at: daysAgo(50), updated_at: daysAgo(16),
    admin_response: 'On the list.', admin_response_at: daysAgo(16) }),
  item({ id: 'done', title: 'A closed one', type: 'bug', status: 'shipped', created_at: daysAgo(60), updated_at: daysAgo(30),
    admin_response: 'Fixed.', admin_response_at: daysAgo(30) }),
]

const PATCHES: Array<{ url: string; body: any }> = []
const OTHER_WRITES: string[] = []
let analysisAsked = 0

const stubFetch = (items: any[] = ITEMS) => {
  const f = vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    const method = init?.method || 'GET'
    if (u.includes('/api/admin/feedback/analysis')) {
      analysisAsked++
      return { ok: true, status: 200, json: async () => ({ analyses: [{ itemId: 'bug-old', probe: null, confidence: 'none', what: '', files: [], fleet: null, size: null, question: 'This one needs a follow-up question.' }], clusters: [], drafts: [] }) }
    }
    if (method !== 'GET') {
      if (method === 'PATCH') PATCHES.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
      else OTHER_WRITES.push(`${method} ${u}`)
      const id = u.split('/').pop()
      const row = items.find(i => i.id === id) || {}
      return { ok: true, status: 200, json: async () => ({ ...row, ...(JSON.parse(init?.body || '{}')), reply_email: null }) }
    }
    return { ok: true, status: 200, json: async () => ({ items }) }
  })
  vi.stubGlobal('fetch', f)
  return f
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => {})
  await act(async () => {})
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const key = (k: string, target: EventTarget = document) => act(async () => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
})
const screenFor = (items: any[] = ITEMS, props: any = {}) => {
  stubFetch(items)
  return mount(
    <CurrentUserContext.Provider value={{ id: 'u1', email: 'kevin@bmave.com' } as any}>
      <AdminFeedbackScreen onBadgeCountChange={() => {}} {...props} />
    </CurrentUserContext.Provider>,
  )
}

const buttons = (host: Element) => [...host.querySelectorAll('button')]
const rowButton = (host: Element, title: string) =>
  buttons(host).find(b => (b.textContent || '').trim().startsWith(title))
const openRow = (host: Element, title: string) => click(rowButton(host, title)!)
const section = (host: Element, label: string) => host.querySelector(`section[aria-label="${label}"]`) as HTMLElement | null
const tileSection = (host: Element, key: string) => host.querySelector(`[data-section="${key}"]`) as HTMLElement | null
const tile = (host: Element, key: string) => host.querySelector(`[data-tile="${key}"]`) as HTMLButtonElement | null
const sendButton = (host: Element) => buttons(host).find(b => /^Save and email /.test((b.textContent || '').trim()))
const titlesIn = (el: Element | null, items: any[] = ITEMS) =>
  [...(el?.querySelectorAll('button') || [])]
    .map(b => items.find(i => (b.textContent || '').trim().startsWith(i.title))?.title)
    .filter((t): t is string => !!t)
const subheadingsIn = (el: Element | null) =>
  [...(el?.querySelectorAll('[data-testid="type-subheading"]') || [])].map(p => (p.textContent || '').trim())
const modal = (host: Element) => host.querySelector('[role="dialog"]') as HTMLElement | null
const byLabel = (host: Element, label: string) => host.querySelector(`[aria-label="${label}"]`) as HTMLElement | null
const selectValue = (sel: HTMLSelectElement, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  setter.call(sel, value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
})
const typeIn = (ta: HTMLTextAreaElement, text: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
})

beforeEach(() => { document.body.innerHTML = ''; PATCHES.length = 0; OTHER_WRITES.length = 0; analysisAsked = 0 })
afterEach(() => { vi.unstubAllGlobals() })

// ─── THE PURE LAYER ───────────────────────────────────────────────────

describe('lib/feedback-triage-groups — whose turn is it', () => {
  it('an unanswered item, and one the owner answered last, both need an answer', () => {
    expect(triageQueueOf(ITEMS.find(i => i.id === 'bug-old')!)).toBe('needs')
    expect(triageQueueOf(ITEMS.find(i => i.id === 'back')!)).toBe('needs')
  })
  it('an item the team spoke on last is waiting on them — legacy single reply included', () => {
    expect(triageQueueOf(ITEMS.find(i => i.id === 'asked')!)).toBe('waiting')
    expect(triageQueueOf(ITEMS.find(i => i.id === 'legacy')!)).toBe('waiting')
  })
  it('an internal item is never waiting on them — nobody is on the other end', () => {
    expect(triageQueueOf(item({ id: 'i', type: 'hazard', is_internal: true, admin_response: 'noted', admin_response_at: daysAgo(2) }))).toBe('needs')
  })
  it('closed is closed, whatever the thread says', () => {
    expect(triageQueueOf(ITEMS.find(i => i.id === 'done')!)).toBe('closed')
    expect(triageQueueOf(item({ status: 'answered' }))).toBe('closed')
    expect(triageQueueOf(item({ status: 'declined' }))).toBe('closed')
  })
  it('the wait is measured from the last word, not the filing date', () => {
    expect(triageWaitingDays(ITEMS.find(i => i.id === 'back')!)).toBe(1)   // they replied yesterday
    expect(triageWaitingDays(ITEMS.find(i => i.id === 'asked')!)).toBe(3)  // we asked three days ago
    expect(triageWaitingDays(ITEMS.find(i => i.id === 'bug-old')!)).toBe(30) // nobody has spoken
  })
  it('the type order is fixed: bugs, questions, ideas, hazards, decisions', () => {
    expect([...TRIAGE_GROUP_TYPE_ORDER]).toEqual(['bug', 'question', 'feature', 'hazard', 'decision'])
    const g = groupFeedbackForTriage(ITEMS)
    expect(g.needs.sections.map(s => s.type)).toEqual(['bug', 'question', 'feature', 'hazard', 'decision'])
    expect(g.needs.items.map(i => i.id)).toEqual(['bug-old', 'bug-new', 'back', 'q', 'idea', 'haz', 'dec'])
    expect(g.waiting.items.map(i => i.id)).toEqual(['asked', 'legacy'])
    expect(g.closed.items.map(i => i.id)).toEqual(['done'])
  })
  it('headers know their oldest and when that is overdue', () => {
    const g = groupFeedbackForTriage(ITEMS)
    expect(g.needs.oldestDays).toBe(30)
    expect(g.needs.overdue).toBe(true)
    expect(g.waiting.oldestDays).toBe(16)
    expect(g.waiting.overdue).toBe(true)
    expect(TRIAGE_OVERDUE_DAYS).toBe(14)
    const fresh = groupFeedbackForTriage([item({ id: 'a', created_at: daysAgo(13) })])
    expect(fresh.needs.overdue).toBe(false)
    expect(groupFeedbackForTriage([]).needs.oldestDays).toBeNull()
  })
  it('a broken timestamp sorts last, never first, and the sort does not mutate', () => {
    const rows = [item({ id: 'bad', created_at: 'nope' }), item({ id: 'good', created_at: daysAgo(1) })]
    expect(sortLongestWaitingFirst(rows).map(r => r.id)).toEqual(['good', 'bad'])
    expect(rows.map(r => r.id)).toEqual(['bad', 'good'])
  })
  it('an unknown type sorts after every known one, under "other"', () => {
    const g = groupFeedbackForTriage([item({ id: 'x', type: 'chore' }), item({ id: 'b', type: 'bug' })])
    expect(g.needs.sections.map(s => s.type)).toEqual(['bug', 'other'])
  })
})

// ─── THE LIST ─────────────────────────────────────────────────────────

// Where the fixture lands under the tiles:
//   Fix       Older bug (30d) · A hazard (4d) · Newer bug (2d)
//   Answer    A question (6d)
//   Decide    An idea (20d) · A decision (9d)
//   Build     Legacy reply idea (50d)
//   Still deciding  We asked them (40d) · They wrote back (40d)
//   Stuck     —                      closed: A closed one
describe('the sections render in tile order, longest waiting first inside each', () => {
  it('each section holds the right rows, in order', async () => {
    const { host, unmount } = await screenFor()
    expect(titlesIn(tileSection(host, 'fix'))).toEqual(['Older bug', 'A hazard', 'Newer bug'])
    expect(titlesIn(tileSection(host, 'answer'))).toEqual(['A question'])
    expect(titlesIn(tileSection(host, 'decide'))).toEqual(['An idea', 'A decision'])
    expect(titlesIn(tileSection(host, 'build'))).toEqual(['Legacy reply idea'])
    expect(titlesIn(tileSection(host, 'deciding'))).toEqual(['We asked them', 'They wrote back'])
    expect(tileSection(host, 'stuck')).toBeNull() // empty sections are not drawn
    const order = [...host.querySelectorAll('[data-section]')].map(e => e.getAttribute('data-section'))
    expect(order).toEqual(['fix', 'answer', 'decide', 'build', 'deciding'])
    await unmount()
  })

  it('no type subheadings any more — the section is the tile', async () => {
    const { host, unmount } = await screenFor()
    expect(subheadingsIn(host)).toEqual([])
    await unmount()
  })

  it('each tile shows its count and the age of its oldest item', async () => {
    const { host, unmount } = await screenFor()
    expect(tile(host, 'fix')!.querySelector('[data-tile-count]')!.textContent).toBe('3')
    expect(tile(host, 'fix')!.querySelector('[data-tile-oldest]')!.textContent).toBe('oldest 30 days old')
    expect(tile(host, 'build')!.querySelector('[data-tile-oldest]')!.textContent).toBe('oldest 50 days old')
    expect(tile(host, 'stuck')!.querySelector('[data-tile-oldest]')!.textContent).toBe('nothing here')
    await unmount()
  })

  it('age is coloured on the row — red past 21, amber past 10 — and no heading is ever red', async () => {
    const { host, unmount } = await screenFor()
    const tone = (id: string) => host.querySelector(`[data-row="${id}"] [data-age-tone]`)!.getAttribute('data-age-tone')
    expect(tone('bug-old')).toBe('red')     // 30 days
    expect(tone('idea')).toBe('amber')      // 20 days
    expect(tone('q')).toBe('plain')         // 6 days
    for (const h of [...host.querySelectorAll('[data-section] h3')] as HTMLElement[]) {
      expect(h.style.color).not.toBe(T.state.danger.strong)
    }
    await unmount()
  })

  it('the red dot is gone; the owner-wrote-back row says so in words', async () => {
    const { host, unmount } = await screenFor()
    expect(host.querySelector('[data-testid="needs-dot"]')).toBeNull()
    expect(rowButton(host, 'They wrote back')!.textContent).toContain('They replied')
    expect(rowButton(host, 'We asked them')!.textContent).not.toContain('They replied')
    await unmount()
  })

  it('status has shape — a chip — in the replied group only, in the shared words', async () => {
    const { host, unmount } = await screenFor()
    expect(host.querySelector('[data-row="asked"] [data-status-chip]')!.textContent).toBe('Looking at it')
    expect(host.querySelector('[data-row="legacy"] [data-status-chip]')!.textContent).toBe('On the list')
    expect(host.querySelector('[data-row="bug-old"] [data-status-chip]')).toBeNull()
    expect(host.textContent).not.toContain('under_review')
    await unmount()
  })
})

describe('a tile is the filter', () => {
  it('Fix shows only the Fix rows; pressing it again shows everything', async () => {
    const { host, unmount } = await screenFor()
    await click(tile(host, 'fix')!)
    expect([...host.querySelectorAll('[data-section]')].map(e => e.getAttribute('data-section'))).toEqual(['fix'])
    expect(titlesIn(host)).toEqual(['Older bug', 'A hazard', 'Newer bug'])
    await click(tile(host, 'fix')!)
    expect(titlesIn(host).length).toBe(9)
    await unmount()
  })

  it('the six tiles count every open item exactly once', async () => {
    const { host, unmount } = await screenFor()
    const counts = ['fix', 'answer', 'decide', 'build', 'deciding', 'stuck'].map(k => Number(tile(host, k)!.querySelector('[data-tile-count]')!.textContent))
    expect(counts).toEqual([3, 1, 2, 1, 2, 0])
    expect(counts.reduce((a, b) => a + b, 0)).toBe(9)
    expect(host.querySelector('[role="tab"]')).toBeNull()
    await unmount()
  })
})

describe('closed items are hidden until the filter asks for them', () => {
  const setScope = (host: Element, v: string) => selectValue(host.querySelector('select[aria-label="Open or closed"]') as HTMLSelectElement, v)
  it('the closed row is absent on open, shown under its own word for Closed or Everything, and hidden again', async () => {
    const { host, unmount } = await screenFor()
    expect(rowButton(host, 'A closed one')).toBeUndefined()
    await setScope(host, 'all')
    expect(titlesIn(tileSection(host, 'closed-shipped'))).toEqual(['A closed one'])
    // …AFTER the open sections.
    expect(tileSection(host, 'deciding')!.compareDocumentPosition(tileSection(host, 'closed-shipped')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await setScope(host, 'open')
    expect(rowButton(host, 'A closed one')).toBeUndefined()
    await unmount()
  })

  it('no closed link at all — the filter is the only way in', async () => {
    const { host, unmount } = await screenFor()
    expect(buttons(host).some(b => /closed/i.test(b.textContent || ''))).toBe(false)
    await unmount()
  })
})

// ─── THE MODAL ────────────────────────────────────────────────────────

describe('the modal opens, walks with the arrows, and closes on escape', () => {
  it('opens on a row click, centred dialog, and counts its place in the visible list', async () => {
    const { host, unmount } = await screenFor()
    expect(modal(host)).toBeNull()
    await openRow(host, 'Newer bug')
    expect(modal(host)).toBeTruthy()
    expect(modal(host)!.textContent).toContain('3 of 9 · Fix')
    expect(modal(host)!.textContent).toContain('What they said')
    await unmount()
  })

  it('the arrow buttons walk the list in render order and stop at both ends', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Older bug')
    const prev = () => byLabel(host, 'Previous item') as HTMLButtonElement
    const next = () => byLabel(host, 'Next item') as HTMLButtonElement
    expect(prev().disabled).toBe(true)
    await click(next())
    expect(modal(host)!.textContent).toContain('A hazard')
    expect(modal(host)!.textContent).toContain('2 of 9')
    for (let n = 0; n < 7; n++) await click(next())
    expect(modal(host)!.textContent).toContain('9 of 9 · Still deciding')
    expect(modal(host)!.textContent).toContain('They wrote back')
    expect(next().disabled).toBe(true)
    await click(next())
    expect(modal(host)!.textContent).toContain('9 of 9')
    await unmount()
  })

  it('the left and right arrow KEYS walk too, and Escape closes', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Older bug')
    await key('ArrowRight')
    expect(modal(host)!.textContent).toContain('A hazard')
    await key('ArrowLeft')
    expect(modal(host)!.textContent).toContain('Older bug')
    await key('Escape')
    expect(modal(host)).toBeNull()
    await unmount()
  })

  it('the arrow keys are ignored while typing in the reply box', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Older bug')
    const ta = modal(host)!.querySelector('textarea') as HTMLTextAreaElement
    await key('ArrowRight', ta)
    expect(modal(host)!.textContent).toContain('Older bug')
    expect(modal(host)!.textContent).toContain('1 of 9')
    await unmount()
  })

  it('the close button and a click on the scrim both close it', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Older bug')
    await click(byLabel(host, 'Close')!)
    expect(modal(host)).toBeNull()
    await unmount()
  })

  it('type and status are dropdowns in plain words; a long title wraps rather than clips', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Newer bug')
    const status = byLabel(host, 'Status') as HTMLSelectElement
    expect([...status.options].map(o => o.textContent)).toEqual(['With the team', 'Looking at it', 'On the list', 'Building it now', 'Answered', 'Fixed', 'Not planned'])
    const type = byLabel(host, 'Type') as HTMLSelectElement
    expect([...type.options].map(o => o.textContent)).toEqual(['Bug', 'Idea', 'Question'])
    const h2 = modal(host)!.querySelector('h2') as HTMLElement
    expect(h2.style.overflowWrap).toBe('anywhere')
    expect(h2.style.whiteSpace).not.toBe('nowrap')
    await unmount()
  })

  it('inputs inside the modal are 16px so a phone does not zoom on focus', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Newer bug')
    const ta = modal(host)!.querySelector('textarea') as HTMLTextAreaElement
    expect(ta.style.fontSize).toBe('16px')
    expect((byLabel(host, 'Status') as HTMLElement).style.fontSize).toBe('16px')
    await unmount()
  })
})

// ─── THE SEND LINE — truthful in every state ──────────────────────────

describe('the line under the reply box says what emails and what does not', () => {
  it('a reply emails; type or status alone does not — except Fixed, which does (issue 236)', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Newer bug')
    expect(modal(host)!.textContent).toContain('Sending a reply emails lynette@kc.com. Changing the type or status alone sends nothing — except Fixed, which tells them by email.')
    await unmount()
  })

  it('choosing Fixed with the box empty says the email goes; a middle status says nothing goes', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Newer bug')
    await selectValue(byLabel(host, 'Status') as HTMLSelectElement, 'shipped')
    expect(modal(host)!.textContent).toContain('Saving marks this Fixed and emails lynette@kc.com to tell them')
    expect(sendButton(host)?.textContent).toBe('Save and email Lynette')
    await selectValue(byLabel(host, 'Status') as HTMLSelectElement, 'answered')
    expect(modal(host)!.textContent).not.toContain('to tell them')
    expect(sendButton(host)).toBeUndefined()
    await unmount()
  })

  it('never promises an email on your own report', async () => {
    const { host, unmount } = await screenFor([item({ id: 'mine', title: 'My own note', user_id: 'u1' })])
    await openRow(host, 'My own note')
    expect(modal(host)!.textContent).toContain('This is your own report')
    expect(modal(host)!.textContent).not.toContain('Sending a reply emails')
    await unmount()
  })
})

// ─── THE WRITE — one PATCH, the existing shape ────────────────────────

describe('a save is one PATCH to the existing route', () => {
  // This test used to pin { status: 'submitted', admin_response } — the modal
  // echoing back the status it opened with, which is the bug that left four
  // replied items at "With the team". A reply on a submitted item now moves
  // the dropdown to Answered, and that is what is sent.
  it('a reply rides admin_response, and moves a submitted item to answered; nothing else is written', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Newer bug')
    await typeIn(modal(host)!.querySelector('textarea') as HTMLTextAreaElement, 'Thanks — fixing it.')
    await click(sendButton(host)!)
    expect(PATCHES).toEqual([{ url: '/api/admin/feedback/bug-new', body: { status: 'answered', admin_response: 'Thanks — fixing it.' } }])
    expect(OTHER_WRITES).toEqual([])
    await unmount()
  })

  it('a status change alone omits admin_response — it cannot blank or re-send a reply', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'We asked them')
    await selectValue(byLabel(host, 'Status') as HTMLSelectElement, 'answered')
    await click(buttons(host).find(b => (b.textContent || '').trim() === 'Save')!)
    expect(PATCHES).toEqual([{ url: '/api/admin/feedback/asked', body: { status: 'answered' } }])
    await unmount()
  })

  it('a type change alone sends type only — no status echoed back, and no reply', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Newer bug')
    await selectValue(byLabel(host, 'Type') as HTMLSelectElement, 'question')
    expect(modal(host)!.textContent).toContain('Nobody is emailed about a refiling')
    await click(buttons(host).find(b => (b.textContent || '').trim() === 'Save')!)
    expect(PATCHES).toEqual([{ url: '/api/admin/feedback/bug-new', body: { type: 'question' } }])
    await unmount()
  })

  it('the modal stays open after a save, so the pass continues', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Newer bug')
    await selectValue(byLabel(host, 'Status') as HTMLSelectElement, 'planned')
    await click(buttons(host).find(b => (b.textContent || '').trim() === 'Save')!)
    expect(modal(host)).toBeTruthy()
    expect(modal(host)!.textContent).toContain('Saved.')
    await unmount()
  })
})

// ─── THE CORPORATE-ONLY BLOCK ─────────────────────────────────────────

describe('the corporate block renders for the team and never for an owner', () => {
  it('the elevated mount shows it, headed so it cannot be mistaken, with the moved features inside', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Older bug')
    const block = modal(host)!.querySelector('[data-testid="corporate-block"]') as HTMLElement
    expect(block).toBeTruthy()
    expect(block.textContent).toContain('Only the team sees this')
    expect(block.textContent).toContain('The owner never sees anything in this box.')
    // The analysis (issue 307) and the copy prompt (issue 308) live here now.
    expect(block.textContent).toContain('This one needs a follow-up question.')
    expect([...block.querySelectorAll('button')].some(b => (b.textContent || '').startsWith('Copy prompt'))).toBe(true)
    expect(block.textContent).toContain('short — cause not established')
    await unmount()
  })

  it('an owner mount renders no block, and never asks the analysis route at all', async () => {
    const { host, unmount } = await screenFor(ITEMS, { onReportFeedback: () => {} })
    await openRow(host, 'Older bug')
    expect(modal(host)).toBeTruthy()
    expect(modal(host)!.querySelector('[data-testid="corporate-block"]')).toBeNull()
    expect(modal(host)!.textContent).not.toContain('Only the team sees this')
    expect([...modal(host)!.querySelectorAll('button')].some(b => (b.textContent || '').startsWith('Copy prompt'))).toBe(false)
    expect(analysisAsked).toBe(0)
    await unmount()
  })

  it('nothing corporate leaks onto the owner rows either — no analysis text on the list', async () => {
    const { host, unmount } = await screenFor()
    // Even on the elevated mount the analysis is inside the modal, not under the row.
    expect(host.textContent).not.toContain('This one needs a follow-up question.')
    await unmount()
  })
})

// ─── SOURCE PINS — the things that must not creep back ────────────────

describe('no pills, no shadowed globals', () => {
  const src = readFileSync('components/admin/AdminFeedbackScreen.jsx', 'utf8')

  // The tiles redesign brought ONE pill back on purpose: status needed shape
  // in the replied group ("plain grey text inside a run of six facts"). The
  // pill radius appears on that chip and the looks-built flag, nowhere else.
  it('the old badge and internal pill stay gone; the pill shape is only the status chip and the looks-built flag', () => {
    expect(src).not.toContain('FeedbackStatusBadge')
    expect(src).not.toContain('InternalPill')
    expect(src).not.toContain('QueueCard')
    expect(src.match(/T\.radius\.pill/g)).toHaveLength(2)
    expect(src).toMatch(/function StatusChip[\s\S]{0,600}T\.radius\.pill/)
    expect(src).toMatch(/data-looks-shipped-flag[^>]*T\.radius\.pill/)
  })

  it('nothing in the file is named `top` — it is a window global', () => {
    expect(src).not.toMatch(/\b(const|let|var|function)\s+top\b/)
    expect(src).not.toMatch(/\{\s*top\s*[,}]/)
  })

  it('the tiles come from the shared module, so the arithmetic is testable on its own', () => {
    expect(src).toContain("from '@/lib/feedback-admin-tiles'")
    expect(src).toContain('summarizeAdminTiles(')
    expect(src).toContain('adminTileOf(')
    expect(src).not.toContain('groupFeedbackForTriage(')
  })

  it('the type colours come from the ONE shared map, not a second one', () => {
    expect(src).toContain('FEEDBACK_TYPE_CHIP_STYLE')
    expect(src).not.toMatch(/feature:\s*T\.family\./)
    expect(src).not.toMatch(/decision:\s*T\.family\./)
  })
})
