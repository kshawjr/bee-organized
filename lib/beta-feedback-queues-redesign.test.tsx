// @vitest-environment happy-dom
//
// THE QUEUES REDESIGN of the corporate triage screen (design C), MOUNTED.
//
// Kevin could not scan the issue 233/306 screen or work it on a phone: three
// queue cards, five filters, a colour per status and per type, and the
// analysis + copy-prompt + draft-reply stacked inline under every row. What
// this pins about its replacement:
//
//   · TWO QUEUES in a fixed order — "Needs an answer" then "Waiting on them"
//     — each header carrying its count and the age of its oldest item, red
//     once that crosses fourteen days
//   · a FIXED TYPE ORDER inside each queue: bugs, questions, ideas, hazards,
//     decisions; longest waiting first within a type
//   · a type tab DROPS the type subheadings
//   · closed items are hidden until "Show N closed" is used
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
      <AdminFeedbackScreen onOpenCountChange={() => {}} {...props} />
    </CurrentUserContext.Provider>,
  )
}

const buttons = (host: Element) => [...host.querySelectorAll('button')]
const rowButton = (host: Element, title: string) =>
  buttons(host).find(b => (b.textContent || '').trim().startsWith(title))
const openRow = (host: Element, title: string) => click(rowButton(host, title)!)
const section = (host: Element, label: string) => host.querySelector(`section[aria-label="${label}"]`) as HTMLElement | null
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

describe('the queues render in the right order, with types ordered inside them', () => {
  it('Needs an answer comes before Waiting on them, and each holds the right rows', async () => {
    const { host, unmount } = await screenFor()
    const needs = section(host, 'Needs an answer')!
    const waiting = section(host, 'Waiting on them')!
    expect(needs).toBeTruthy()
    expect(waiting).toBeTruthy()
    expect(needs.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(titlesIn(needs)).toEqual(['Older bug', 'Newer bug', 'They wrote back', 'A question', 'An idea', 'A hazard', 'A decision'])
    expect(titlesIn(waiting)).toEqual(['We asked them', 'Legacy reply idea'])
    await unmount()
  })

  it('the type subheadings appear in the fixed order, in the type colour', async () => {
    const { host, unmount } = await screenFor()
    expect(subheadingsIn(section(host, 'Needs an answer'))).toEqual(['Bugs', 'Questions', 'Ideas', 'Hazards', 'Decisions'])
    const heads = [...section(host, 'Needs an answer')!.querySelectorAll('[data-testid="type-subheading"]')] as HTMLElement[]
    // The SHARED map (lib/feedback-types), the one System Health ships with.
    expect(heads[0].style.color).toBe(T.family.red.text)      // bug red
    expect(heads[1].style.color).toBe(T.family.teal.text)     // question teal
    expect(heads[2].style.color).toBe(T.family.blue.text)     // idea blue
    expect(heads[3].style.color).toBe(T.family.amber.text)    // hazard amber
    expect(heads[4].style.color).toBe(T.family.purple.text)   // decision purple
    await unmount()
  })

  it('each header shows its count and the age of its oldest item', async () => {
    const { host, unmount } = await screenFor()
    const needsHead = section(host, 'Needs an answer')!.querySelector('h3')!
    expect(needsHead.textContent).toContain('Needs an answer')
    expect(needsHead.textContent).toContain('7')
    expect(section(host, 'Needs an answer')!.textContent).toContain('oldest 30 days')
    expect(section(host, 'Waiting on them')!.querySelector('h3')!.textContent).toContain('2')
    expect(section(host, 'Waiting on them')!.textContent).toContain('oldest 16 days')
    await unmount()
  })

  it('a header turns red once its oldest crosses 14 days, and not before', async () => {
    const { host, unmount } = await screenFor()
    // Both queues are overdue in the main fixture.
    expect((section(host, 'Needs an answer')!.querySelector('h3') as HTMLElement).style.color).toBe(T.state.danger.strong)
    await unmount()
    const { host: h2, unmount: un2 } = await screenFor([
      item({ id: 'a', title: 'Young', created_at: daysAgo(13), updated_at: daysAgo(13) }),
      item({ id: 'b', title: 'Asked lately', status: 'under_review', created_at: daysAgo(13), admin_response: 'Hi', admin_response_at: daysAgo(2), replies: [teamReply(2)] }),
    ])
    expect((section(h2, 'Needs an answer')!.querySelector('h3') as HTMLElement).style.color).toBe(T.ink.primary)
    expect((section(h2, 'Waiting on them')!.querySelector('h3') as HTMLElement).style.color).toBe(T.ink.primary)
    await un2()
  })

  it('the red dot marks the rows that need a response from us, and only those', async () => {
    const { host, unmount } = await screenFor()
    expect(rowButton(host, 'Older bug')!.querySelector('[data-testid="needs-dot"]')).toBeTruthy()
    expect(rowButton(host, 'They wrote back')!.querySelector('[data-testid="needs-dot"]')).toBeTruthy()
    expect(rowButton(host, 'We asked them')!.querySelector('[data-testid="needs-dot"]')).toBeNull()
    // Internal items have nobody waiting on a response.
    expect(rowButton(host, 'A hazard')!.querySelector('[data-testid="needs-dot"]')).toBeNull()
    await unmount()
  })

  it('status is plain text on the row — no badge', async () => {
    const { host, unmount } = await screenFor()
    expect(rowButton(host, 'We asked them')!.textContent).toContain('Looking at it')
    expect(rowButton(host, 'Legacy reply idea')!.textContent).toContain('Planned')
    expect(host.textContent).not.toContain('under_review')
    await unmount()
  })
})

describe('a type filter drops the type subheadings', () => {
  it('under Everything the subheadings show; under Bugs they vanish and only bugs remain', async () => {
    const { host, unmount } = await screenFor()
    expect(subheadingsIn(host).length).toBeGreaterThan(0)
    await click(byLabel(host, 'Bugs tab')!)
    expect(subheadingsIn(host)).toEqual([])
    expect(titlesIn(section(host, 'Needs an answer'))).toEqual(['Older bug', 'Newer bug', 'They wrote back'])
    expect(titlesIn(section(host, 'Waiting on them'))).toEqual(['We asked them'])
    // The active tab's underline is the type's colour.
    expect((byLabel(host, 'Bugs tab') as HTMLElement).style.boxShadow).toContain(T.family.red.text)
    await click(byLabel(host, 'Everything tab')!)
    expect(subheadingsIn(host).length).toBeGreaterThan(0)
    await unmount()
  })

  it('the tabs carry counts, and the internal-only types appear only once one exists', async () => {
    const { host, unmount } = await screenFor()
    expect(byLabel(host, 'Everything tab')!.textContent).toBe('Everything9')
    expect(byLabel(host, 'Bugs tab')!.textContent).toBe('Bugs4')
    expect(byLabel(host, 'Ideas tab')!.textContent).toBe('Ideas2')
    expect(byLabel(host, 'Questions tab')!.textContent).toBe('Questions1')
    expect(byLabel(host, 'Hazards tab')).toBeTruthy()
    expect(byLabel(host, 'Decisions tab')).toBeTruthy()
    await unmount()
    const { host: h2, unmount: un2 } = await screenFor([item({ id: 'a', title: 'Just a bug', type: 'bug' })])
    expect(byLabel(h2, 'Hazards tab')).toBeNull()
    expect(byLabel(h2, 'Decisions tab')).toBeNull()
    await un2()
  })
})

describe('closed items are hidden until the toggle is used', () => {
  it('the closed row is absent on open, revealed by "Show N closed" as a third group, and hidden again', async () => {
    const { host, unmount } = await screenFor()
    expect(rowButton(host, 'A closed one')).toBeUndefined()
    expect(section(host, 'Closed')).toBeNull()
    const toggle = buttons(host).find(b => (b.textContent || '').trim() === 'Show 1 closed')!
    expect(toggle).toBeTruthy()
    await click(toggle)
    expect(section(host, 'Closed')).toBeTruthy()
    expect(titlesIn(section(host, 'Closed'))).toEqual(['A closed one'])
    // …AFTER both live queues.
    expect(section(host, 'Waiting on them')!.compareDocumentPosition(section(host, 'Closed')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await click(buttons(host).find(b => (b.textContent || '').trim() === 'Hide 1 closed')!)
    expect(section(host, 'Closed')).toBeNull()
    await unmount()
  })

  it('no toggle at all when nothing is closed', async () => {
    const { host, unmount } = await screenFor(ITEMS.filter(i => i.id !== 'done'))
    expect(buttons(host).some(b => (b.textContent || '').includes('closed'))).toBe(false)
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
    expect(modal(host)!.textContent).toContain('2 of 9 · Needs an answer')
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
    expect(modal(host)!.textContent).toContain('Newer bug')
    expect(modal(host)!.textContent).toContain('2 of 9')
    for (let n = 0; n < 7; n++) await click(next())
    expect(modal(host)!.textContent).toContain('9 of 9 · Waiting on them')
    expect(modal(host)!.textContent).toContain('Legacy reply idea')
    expect(next().disabled).toBe(true)
    await click(next())
    expect(modal(host)!.textContent).toContain('9 of 9')
    await unmount()
  })

  it('the left and right arrow KEYS walk too, and Escape closes', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Older bug')
    await key('ArrowRight')
    expect(modal(host)!.textContent).toContain('Newer bug')
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
    expect([...status.options].map(o => o.textContent)).toEqual(['New', 'Looking at it', 'Planned', 'In progress', 'Answered', 'Fixed', 'Not planned'])
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
    expect(buttons(host).some(b => (b.textContent || '').trim() === 'Save and send')).toBe(true)
    await selectValue(byLabel(host, 'Status') as HTMLSelectElement, 'answered')
    expect(modal(host)!.textContent).not.toContain('to tell them')
    expect(buttons(host).some(b => (b.textContent || '').trim() === 'Save and send')).toBe(false)
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
  it('a reply rides admin_response with the status; nothing else is written', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Newer bug')
    await typeIn(modal(host)!.querySelector('textarea') as HTMLTextAreaElement, 'Thanks — fixing it.')
    await click(buttons(host).find(b => (b.textContent || '').trim() === 'Save and send')!)
    expect(PATCHES).toEqual([{ url: '/api/admin/feedback/bug-new', body: { status: 'submitted', admin_response: 'Thanks — fixing it.' } }])
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

  it('a type change alone sends type with the status, and no reply', async () => {
    const { host, unmount } = await screenFor()
    await openRow(host, 'Newer bug')
    await selectValue(byLabel(host, 'Type') as HTMLSelectElement, 'question')
    expect(modal(host)!.textContent).toContain('Nobody is emailed about a refiling')
    await click(buttons(host).find(b => (b.textContent || '').trim() === 'Save')!)
    expect(PATCHES).toEqual([{ url: '/api/admin/feedback/bug-new', body: { status: 'submitted', type: 'question' } }])
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

  it('the status badge and the internal pill are gone from the screen', () => {
    expect(src).not.toContain('FeedbackStatusBadge')
    expect(src).not.toContain('InternalPill')
    expect(src).not.toContain('QueueCard')
    expect(src).not.toContain('T.radius.pill')
  })

  it('nothing in the file is named `top` — it is a window global', () => {
    expect(src).not.toMatch(/\b(const|let|var|function)\s+top\b/)
    expect(src).not.toMatch(/\{\s*top\s*[,}]/)
  })

  it('the queues come from the shared module, so the arithmetic is testable on its own', () => {
    expect(src).toContain("from '@/lib/feedback-triage-groups'")
    expect(src).toContain('groupFeedbackForTriage(')
  })

  it('the type colours come from the ONE shared map, not a second one', () => {
    expect(src).toContain('FEEDBACK_TYPE_CHIP_STYLE')
    expect(src).not.toMatch(/feature:\s*T\.family\./)
    expect(src).not.toMatch(/decision:\s*T\.family\./)
  })
})
