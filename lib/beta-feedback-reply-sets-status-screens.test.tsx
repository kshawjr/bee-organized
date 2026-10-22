// @vitest-environment happy-dom
//
// REPLYING SETS THE STATUS, AND ONE WORD PER STATUS — the screen half.
//
//   · the triage modal: typing a reply on a submitted item moves the dropdown
//     to Answered and says so; a status picked by hand is never overridden,
//     not by typing and not by editing the reply afterwards; Save never echoes
//     back the status the modal opened with
//   · the bulk bar offers Answered, and it lands on every selected item
//   · every status reads the same word on the owner screen, the triage screen
//     and the shared card (the email half is in
//     lib/beta-feedback-reply-sets-status.test.ts)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { renderToStaticMarkup } from 'react-dom/server'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import OwnerFeedbackScreen from '@/components/feedback/OwnerFeedbackScreen'
import { FeedbackItemCard, FeedbackStatusBadge } from '@/components/feedback/feedbackShared'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import { FEEDBACK_STATUS_PLAIN } from '@/lib/feedback-queues'
import { FEEDBACK_TYPE_WORD, FEEDBACK_TYPE_TAB_LABEL } from '@/lib/feedback-types'
import { INTAKE_DOORS } from '@/lib/feedback-intake'

const ALL_STATUSES = ['submitted', 'under_review', 'planned', 'in_progress', 'answered', 'shipped', 'declined']
const OLD_WORDS = ['Sent', 'Being looked at', 'In progress', 'Submitted', 'Under Review', 'Shipped', 'Declined']

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
const base = {
  user_id: 'u2', submitter_name: 'Lynette Ewy', submitter_email: 'lynette@kc.com',
  location_id: 'loc-2', location_name: 'Kansas City', attachments: [], replies: [],
  admin_response: null, admin_response_at: null, reply_seen_at: null, description: 'Some words.',
}
const item = (over: any) => ({ type: 'bug', status: 'submitted', created_at: daysAgo(5), updated_at: daysAgo(5), ...base, ...over })

const ITEMS = [
  item({ id: 'fresh', title: 'Fresh bug' }),
  item({ id: 'fresh2', title: 'Second fresh bug', created_at: daysAgo(3), updated_at: daysAgo(3) }),
  item({ id: 'mine', title: 'My own note', user_id: 'u1' }),
  item({ id: 'parked', title: 'Parked bug', status: 'planned' }),
]

const PATCHES: Array<{ url: string; body: any }> = []

const stubFetch = (items: any[]) => {
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    const method = init?.method || 'GET'
    if (u.includes('/api/admin/feedback/analysis')) {
      return { ok: true, status: 200, json: async () => ({ analyses: [], clusters: [], drafts: [] }) }
    }
    if (method === 'PATCH') {
      const body = init?.body ? JSON.parse(init.body) : null
      PATCHES.push({ url: u, body })
      const row = items.find(i => i.id === u.split('/').pop()) || {}
      return { ok: true, status: 200, json: async () => ({ ...row, ...body, reply_email: null }) }
    }
    if (u.startsWith('/api/feedback/seen')) return { ok: true, status: 200, json: async () => ({ marked: 0, supported: true }) }
    return { ok: true, status: 200, json: async () => ({ items }) }
  }))
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
const viewer = (children: React.ReactNode) => (
  <CurrentUserContext.Provider value={{ id: 'u1', email: 'kevin@bmave.com' } as any}>{children}</CurrentUserContext.Provider>
)
const adminScreen = (items: any[] = ITEMS) => {
  stubFetch(items)
  return mount(viewer(<AdminFeedbackScreen onOpenCountChange={() => {}} />))
}
const ownerScreen = (items: any[]) => {
  stubFetch(items)
  return mount(viewer(<OwnerFeedbackScreen onReportSomething={() => {}} />))
}

const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const buttons = (host: Element) => [...host.querySelectorAll('button')]
const btn = (host: Element, text: string) => buttons(host).find(b => (b.textContent || '').trim().startsWith(text))
const exactBtn = (host: Element, text: string) => buttons(host).find(b => (b.textContent || '').trim() === text)
const modal = (host: Element) => host.querySelector('[role="dialog"]') as HTMLElement | null
const statusSel = (host: Element) => host.querySelector('[aria-label="Status"]') as HTMLSelectElement
const replyBox = (host: Element) => modal(host)!.querySelector('textarea') as HTMLTextAreaElement
const pick = (sel: HTMLSelectElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(sel, value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
})
const typeReply = (host: Element, text: string) => act(async () => {
  const ta = replyBox(host)
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
})
const save = async (host: Element) => {
  const b = exactBtn(host, 'Save and send') || exactBtn(host, 'Save')
  expect(b, 'no Save button').toBeTruthy()
  await click(b!)
}
const openRow = (host: Element, title: string) => click(btn(host, title)!)

beforeEach(() => { document.body.innerHTML = ''; PATCHES.length = 0 })
afterEach(() => { vi.unstubAllGlobals() })

// ─── CHANGE 1 — the modal ─────────────────────────────────────────────

describe('typing a reply moves an untouched dropdown to Answered', () => {
  it('reply on a submitted item, dropdown untouched → Answered, said out loud, and stored as answered', async () => {
    const { host, unmount } = await adminScreen()
    await openRow(host, 'Fresh bug')
    expect(statusSel(host).value).toBe('submitted')
    await typeReply(host, 'Open the client and look at the Timeline.')
    expect(statusSel(host).value).toBe('answered')
    expect(modal(host)!.querySelector('[data-status-moved]')?.textContent)
      .toContain('Status moved to Answered because you wrote a reply')
    await save(host)
    expect(PATCHES).toEqual([{
      url: '/api/admin/feedback/fresh',
      body: { status: 'answered', admin_response: 'Open the client and look at the Timeline.' },
    }])
    await unmount()
  })

  it('emptying the reply puts the dropdown back and drops the line', async () => {
    const { host, unmount } = await adminScreen()
    await openRow(host, 'Fresh bug')
    await typeReply(host, 'Words.')
    await typeReply(host, '   ')
    expect(statusSel(host).value).toBe('submitted')
    expect(modal(host)!.querySelector('[data-status-moved]')).toBeNull()
    await unmount()
  })

  it('a reply on an item already past submitted does not move it', async () => {
    const { host, unmount } = await adminScreen()
    await openRow(host, 'Parked bug')
    await typeReply(host, 'Still on the list.')
    expect(statusSel(host).value).toBe('planned')
    await unmount()
  })

  it('a note on your OWN item does not move it', async () => {
    const { host, unmount } = await adminScreen()
    await openRow(host, 'My own note')
    await typeReply(host, 'Note to self.')
    expect(statusSel(host).value).toBe('submitted')
    await unmount()
  })
})

describe('a status picked by hand always wins', () => {
  it('picked BEFORE typing: the reply never moves it', async () => {
    const { host, unmount } = await adminScreen()
    await openRow(host, 'Fresh bug')
    await pick(statusSel(host), 'planned')
    await typeReply(host, 'Queued for next week.')
    expect(statusSel(host).value).toBe('planned')
    await save(host)
    expect(PATCHES[0].body).toEqual({ status: 'planned', admin_response: 'Queued for next week.' })
    await unmount()
  })

  it('picked AFTER the reply moved it, then the reply edited: the pick still wins', async () => {
    const { host, unmount } = await adminScreen()
    await openRow(host, 'Fresh bug')
    await typeReply(host, 'Looking.')
    expect(statusSel(host).value).toBe('answered')
    await pick(statusSel(host), 'in_progress')
    expect(modal(host)!.querySelector('[data-status-moved]')).toBeNull()
    await typeReply(host, '')
    await typeReply(host, 'Building it this week.')
    expect(statusSel(host).value).toBe('in_progress')
    await save(host)
    expect(PATCHES[0].body).toEqual({ status: 'in_progress', admin_response: 'Building it this week.' })
    await unmount()
  })
})

describe('Save never echoes back the status the modal opened with', () => {
  it('a reply on a planned item sends the reply and NO status — a stale modal cannot undo someone else’s move', async () => {
    const { host, unmount } = await adminScreen()
    await openRow(host, 'Parked bug')
    await typeReply(host, 'Still on the list.')
    await save(host)
    expect(PATCHES).toEqual([{ url: '/api/admin/feedback/parked', body: { admin_response: 'Still on the list.' } }])
    await unmount()
  })
})

// ─── CHANGE 2 — the bulk verdict ──────────────────────────────────────

describe('Answered is a bulk verdict', () => {
  const check = async (box: HTMLInputElement) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')!.set!.call(box, true)
    box.dispatchEvent(new Event('click', { bubbles: true }))
    box.dispatchEvent(new Event('change', { bubbles: true }))
  })

  it('sets answered on every selected item, through the one PATCH route, and emails nobody', async () => {
    const { host, unmount } = await adminScreen()
    const boxes = [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
    expect(boxes.length).toBeGreaterThanOrEqual(3)
    for (const b of boxes.slice(0, 3)) await check(b)
    await click(exactBtn(host, 'Answered')!)
    expect(host.textContent).toContain('Nobody is emailed')
    await click(exactBtn(host, 'Confirm')!)
    expect(PATCHES).toHaveLength(3)
    for (const p of PATCHES) {
      expect(p.url).toMatch(/^\/api\/admin\/feedback\/[^/]+$/)
      expect(p.body).toEqual({ status: 'answered' })
    }
    expect(host.textContent).toContain('Marked answered: 3 items.')
    await unmount()
  })
})

// ─── CHANGE 3 — one word per status, everywhere ───────────────────────

describe('every status reads the same word on every surface', () => {
  const ONE_EACH = ALL_STATUSES.map((s, n) => item({ id: `s-${s}`, title: `Item ${s}`, status: s, created_at: daysAgo(10 + n) }))

  it('the triage dropdown is the shared map, in order', async () => {
    const { host, unmount } = await adminScreen()
    await openRow(host, 'Fresh bug')
    expect([...statusSel(host).options].map(o => [o.value, o.textContent]))
      .toEqual(ALL_STATUSES.map(s => [s, FEEDBACK_STATUS_PLAIN[s]]))
    await unmount()
  })

  it('the triage rows say each status in the shared word', async () => {
    const { host, unmount } = await adminScreen(ONE_EACH)
    const show = buttons(host).find(b => /closed/i.test(b.textContent || '') && b.hasAttribute('aria-expanded'))
    if (show) await click(show)
    for (const s of ALL_STATUSES) {
      const row = btn(host, `Item ${s}`)
      expect(row, s).toBeTruthy()
      expect(row!.textContent, s).toContain(` · ${FEEDBACK_STATUS_PLAIN[s]}`)
    }
    await unmount()
  })

  it('the owner screen says each status in the shared word — planned and in_progress no longer read alike', async () => {
    const { host, unmount } = await ownerScreen(ONE_EACH.map(i => ({ ...i, user_id: 'u1' })))
    let text = host.textContent || ''
    for (const label of ['Open', 'Answered', 'Waiting', 'Done']) {
      const tab = btn(host, `${label} · `)
      if (tab) { await click(tab); text += host.textContent || '' }
    }
    for (const s of ALL_STATUSES) expect(text, s).toContain(FEEDBACK_STATUS_PLAIN[s])
    expect(FEEDBACK_STATUS_PLAIN.planned).not.toBe(FEEDBACK_STATUS_PLAIN.in_progress)
    for (const w of ['Sent', 'Being looked at']) expect(text).not.toContain(w)
    await unmount()
  })

  it('the shared card and its badge say each status in the shared word', () => {
    for (const s of ALL_STATUSES) {
      const card = renderToStaticMarkup(<FeedbackItemCard item={item({ id: s, title: 't', status: s })} />)
      expect(card, s).toContain(`>${FEEDBACK_STATUS_PLAIN[s]}<`)
      expect(renderToStaticMarkup(<FeedbackStatusBadge status={s} />), s).toContain(`>${FEEDBACK_STATUS_PLAIN[s]}<`)
      for (const w of OLD_WORDS) expect(card, `${s}: ${w}`).not.toContain(`>${w}<`)
    }
  })
})

describe('one word for the feature type: Idea', () => {
  it('the owner’s door, the triage dropdown and the tab all say Idea(s)', async () => {
    expect(FEEDBACK_TYPE_WORD.feature).toBe('Idea')
    expect(FEEDBACK_TYPE_TAB_LABEL.feature).toBe('Ideas')
    expect(INTAKE_DOORS.find(d => d.type === 'feature')!.label).toBe('Share an idea')
    const { host, unmount } = await adminScreen()
    await openRow(host, 'Fresh bug')
    const type = host.querySelector('[aria-label="Type"]') as HTMLSelectElement
    expect([...type.options].map(o => o.textContent)).toEqual(['Bug', 'Idea', 'Question'])
    expect(host.textContent).not.toMatch(/feature/i)
    await unmount()
  })
})
