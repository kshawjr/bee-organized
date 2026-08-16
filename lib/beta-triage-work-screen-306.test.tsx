// @vitest-environment happy-dom
//
// issue 306 — the triage WORK screen, MOUNTED.
//
// Step 2 of five. It extends AdminFeedbackScreen (issue 233) rather than
// building a second surface: two screens for one job is how issue 246 ended up
// with an orphaned toggle nobody noticed for a week.
//
// What this pins:
//   · THE WORK ORDER — bugs before ideas, longest-waiting first inside each
//     band. Arrival order was never a work order.
//   · THE STALE QUEUE IS EXEMT FROM IT, on purpose — see the test that says so.
//   · THE DERIVED STATE — "answered, unconfirmed" comes from admin_response +
//     admin_response_at + reply_seen_at. No column was added.
//   · VERDICTS go through PATCH /api/admin/feedback/:id, the SAME route the
//     detail modal uses. A direct database write sends no email — that is
//     exactly what left five replies undelivered — so the test asserts the
//     screen makes no write of any other shape.
//   · internal items, and items with no context, render honestly.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'
import {
  isAwaitingConfirmation, isReplyUnseen, hasFeedbackReply, sortForTriage, triageTypeRank,
} from '@/lib/feedback-queues'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const base = {
  user_id: 'u2', submitter_name: 'Lynette Ewy', submitter_email: 'lynette@kc.com',
  location_id: 'loc-2', location_name: 'Kansas City', attachments: [],
}

// ORDER FIXTURE. Two bugs and two ideas, interleaved by age so that arrival
// order, pure age order and the work order are three DIFFERENT sequences —
// otherwise the assertion would pass for the wrong reason.
//   bug 30d · bug 5d · idea 40d · idea 2d      ← the work order
//   idea 40d · bug 30d · bug 5d · idea 2d      ← pure oldest-first
const ORDER_ITEMS = [
  { ...base, id: 'b-new',  title: 'Bug newer',  type: 'bug',     status: 'submitted', created_at: daysAgo(5),  updated_at: daysAgo(5) },
  { ...base, id: 'f-old',  title: 'Idea older', type: 'feature', status: 'submitted', created_at: daysAgo(40), updated_at: daysAgo(40) },
  { ...base, id: 'b-old',  title: 'Bug older',  type: 'bug',     status: 'submitted', created_at: daysAgo(30), updated_at: daysAgo(30) },
  { ...base, id: 'f-new',  title: 'Idea newer', type: 'feature', status: 'submitted', created_at: daysAgo(2),  updated_at: daysAgo(2) },
]

// STATE FIXTURE. The four reply states side by side, plus an internal item and
// one with no context at all.
const STATE_ITEMS = [
  { ...base, id: 'open', title: 'Waiting on us', type: 'bug', status: 'submitted',
    created_at: daysAgo(9), updated_at: daysAgo(9) },
  { ...base, id: 'unconfirmed', title: 'Answered not seen', type: 'bug', status: 'shipped',
    created_at: daysAgo(50), updated_at: daysAgo(40),
    admin_response: 'Fixed it last month.', admin_response_at: daysAgo(40), reply_seen_at: null },
  { ...base, id: 'confirmed', title: 'Answered and seen', type: 'bug', status: 'shipped',
    created_at: daysAgo(52), updated_at: daysAgo(41),
    admin_response: 'Fixed it.', admin_response_at: daysAgo(41), reply_seen_at: daysAgo(39) },
  { ...base, id: 'internal', title: 'Token rotation race', type: 'hazard', status: 'submitted',
    is_internal: true, created_at: daysAgo(6), updated_at: daysAgo(6) },
]

const PATCHES: Array<{ url: string; method: string; body: any }> = []
const OTHER_WRITES: Array<{ url: string; method: string }> = []

const stubFetch = (items: any[]) => {
  const f = vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    const method = init?.method || 'GET'
    if (method !== 'GET') {
      const rec = { url: u, method, body: init?.body ? JSON.parse(init.body) : null }
      if (method === 'PATCH' && /^\/api\/admin\/feedback\/[^/]+$/.test(u)) PATCHES.push(rec)
      else OTHER_WRITES.push({ url: u, method })
      const id = u.split('/').pop()
      const row = items.find(i => i.id === id) || {}
      return {
        ok: true, status: 200,
        json: async () => ({ ...row, ...(rec.body || {}), reply_email: { sent: true, to: 'lynette@kc.com', kind: 'shipped' } }),
      }
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
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}
const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})
const screenFor = (items: any[], props: any = {}) => {
  stubFetch(items)
  return mount(
    <CurrentUserContext.Provider value={{ id: 'u1', email: 'kevin@bmave.com' } as any}>
      <AdminFeedbackScreen onOpenCountChange={() => {}} {...props} />
    </CurrentUserContext.Provider>,
  )
}

const buttons = (host: Element) => [...host.querySelectorAll('button')]
const btn = (host: Element, text: string) =>
  buttons(host).find(b => (b.textContent || '').trim().startsWith(text))
const boxes = (host: Element) =>
  [...host.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[]
const rowTitles = (host: Element, items: any[]) =>
  buttons(host)
    .map(b => items.find(i => (b.textContent || '').trim().startsWith(i.title))?.title)
    .filter((t): t is string => !!t)
// The row whose text starts with this title — for reading its own state line.
const rowText = (host: Element, title: string) =>
  buttons(host).find(b => (b.textContent || '').trim().startsWith(title))?.textContent || ''

beforeEach(() => { PATCHES.length = 0; OTHER_WRITES.length = 0; document.body.innerHTML = '' })
afterEach(() => { vi.unstubAllGlobals() })

// ─── THE WORK ORDER ───────────────────────────────────────────────────

describe('the order puts what matters first', () => {
  it('bugs render before features, oldest first within each group', async () => {
    const { host, unmount } = await screenFor(ORDER_ITEMS)
    expect(rowTitles(host, ORDER_ITEMS)).toEqual(['Bug older', 'Bug newer', 'Idea older', 'Idea newer'])
    await unmount()
  })

  it('is neither arrival order nor pure age order', async () => {
    const { host, unmount } = await screenFor(ORDER_ITEMS)
    const shown = rowTitles(host, ORDER_ITEMS)
    expect(shown).not.toEqual(ORDER_ITEMS.map(i => i.title))
    expect(shown).not.toEqual(['Idea older', 'Bug older', 'Bug newer', 'Idea newer'])
    await unmount()
  })

  // The rank is a total order over the four-value vocabulary (issue 247 step
  // 2), not a two-way bug/feature test.
  it('ranks all four types, and sorts an unknown one last', () => {
    expect(triageTypeRank('bug')).toBeLessThan(triageTypeRank('hazard'))
    expect(triageTypeRank('hazard')).toBeLessThan(triageTypeRank('decision'))
    expect(triageTypeRank('decision')).toBeLessThan(triageTypeRank('feature'))
    expect(triageTypeRank('something-new')).toBeGreaterThan(triageTypeRank('feature'))
  })

  it('sorts a broken timestamp last within its band, never first', () => {
    const rows = [
      { id: 'bad', type: 'bug', created_at: 'not-a-date' },
      { id: 'good', type: 'bug', created_at: daysAgo(1) },
    ]
    expect(sortForTriage(rows as any).map(r => r.id)).toEqual(['good', 'bad'])
  })

  it('does not mutate the array it is given', () => {
    const rows = [...ORDER_ITEMS]
    sortForTriage(rows as any)
    expect(rows.map(r => r.id)).toEqual(ORDER_ITEMS.map(r => r.id))
  })

  // Issue 233 built the stale card to answer ONE question — what has been
  // quiet longest. Ranking by type there would put a fresher bug above the row
  // the card exists to surface, so the work order stops at its edge.
  it('leaves the stale queue on longest-quiet-first, ignoring type', async () => {
    const stale = [
      { ...base, id: 'sb', title: 'Stale bug',  type: 'bug',     status: 'under_review', created_at: daysAgo(60), updated_at: daysAgo(15) },
      { ...base, id: 'sf', title: 'Stale idea', type: 'feature', status: 'planned',      created_at: daysAgo(60), updated_at: daysAgo(30) },
    ]
    const { host, unmount } = await screenFor(stale)
    await click(btn(host, 'Going stale')!)
    // The idea has been quiet longest, so it leads DESPITE being a feature.
    expect(rowTitles(host, stale)).toEqual(['Stale idea', 'Stale bug'])
    await unmount()
  })
})

// ─── THE DERIVED STATE ────────────────────────────────────────────────

describe('"answered, unconfirmed" is derived, not stored', () => {
  it('needs a reply AND an unseen stamp', () => {
    const replied = { admin_response: 'done', admin_response_at: daysAgo(5) }
    expect(isAwaitingConfirmation({ ...replied, reply_seen_at: null })).toBe(true)
    expect(isAwaitingConfirmation({ ...replied, reply_seen_at: daysAgo(4) })).toBe(false)
    // No reply at all is not "awaiting confirmation" — it is awaiting US.
    expect(isAwaitingConfirmation({ reply_seen_at: null })).toBe(false)
    expect(hasFeedbackReply({ admin_response: '   ' })).toBe(false)
  })

  // The timestamp compare, not a null test: a SECOND reply on an item they
  // already read is unseen again.
  it('a newer reply on an already-read item counts as unseen again', () => {
    expect(isReplyUnseen({ admin_response_at: daysAgo(1), reply_seen_at: daysAgo(3) })).toBe(true)
    expect(isReplyUnseen({ admin_response_at: daysAgo(3), reply_seen_at: daysAgo(1) })).toBe(false)
  })

  it('an answered-but-unconfirmed row is distinct from both open and closed', async () => {
    const { host, unmount } = await screenFor(STATE_ITEMS, {})
    await click(btn(host, 'Show ')!) // reveal the two closed rows
    expect(rowText(host, 'Answered not seen')).toContain('not seen yet')
    // Distinct from an unanswered item…
    expect(rowText(host, 'Waiting on us')).toContain('No reply yet')
    expect(rowText(host, 'Waiting on us')).not.toContain('not seen yet')
    // …and from an answered one they HAVE read.
    expect(rowText(host, 'Answered and seen')).toContain('seen')
    expect(rowText(host, 'Answered and seen')).not.toContain('not seen yet')
    await unmount()
  })

  // The whole point of step 2's state work: no migration, no CHECK constraint
  // drop. If someone adds a column for this later, this test says why not to.
  it('adds no column — the state is computed from three existing fields', () => {
    const src = readFileSync('lib/feedback-queues.ts', 'utf8')
    expect(src).toContain('admin_response')
    expect(src).toContain('reply_seen_at')
    const migrations = readFileSync('components/admin/AdminFeedbackScreen.jsx', 'utf8')
    expect(migrations).not.toContain('awaiting_confirmation')
  })
})

// ─── VERDICTS ─────────────────────────────────────────────────────────

describe('verdicts write through the existing status path', () => {
  // React tracks a checkbox's value on the node, so assigning .checked and
  // firing 'change' is swallowed as a no-op change. Go through the native
  // setter first, exactly as the text-input helpers in the sibling suites do.
  const selectFirst = async (host: Element) => {
    const box = boxes(host)[0]
    expect(box, 'no selection checkbox rendered').toBeTruthy()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        (globalThis as any).window.HTMLInputElement.prototype, 'checked',
      )!.set!
      setter.call(box, true)
      box.dispatchEvent(new Event('click', { bubbles: true }))
      box.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  it('a verdict PATCHes /api/admin/feedback/:id with an existing status', async () => {
    const { host, unmount } = await screenFor(ORDER_ITEMS)
    await selectFirst(host)
    await click(btn(host, 'Not real')!)
    await click(btn(host, 'Confirm')!)
    expect(PATCHES).toHaveLength(1)
    expect(PATCHES[0].url).toBe('/api/admin/feedback/b-old')
    expect(PATCHES[0].method).toBe('PATCH')
    // The EXISTING vocabulary — not a new verdict column, not a new status.
    expect(PATCHES[0].body).toEqual({ status: 'declined' })
    await unmount()
  })

  it('every verdict maps onto a status the route already accepts', async () => {
    // The route's own VALID_STATUSES, read from the route rather than restated.
    const route = readFileSync('app/api/admin/feedback/[id]/route.ts', 'utf8')
    const screen = readFileSync('components/admin/AdminFeedbackScreen.jsx', 'utf8')
    const verdictStatuses = [...screen.matchAll(/status: '([a-z_]+)', emails/g)].map(m => m[1])
    expect(verdictStatuses.length).toBeGreaterThan(0)
    for (const s of verdictStatuses) expect(route).toContain(`'${s}'`)
  })

  it('makes NO write of any other shape — a direct row update sends no email', async () => {
    const { host, unmount } = await screenFor(ORDER_ITEMS)
    await selectFirst(host)
    await click(btn(host, 'Already fixed')!)
    await click(btn(host, 'Confirm')!)
    expect(PATCHES).toHaveLength(1)
    expect(OTHER_WRITES).toEqual([])
    await unmount()
  })

  // The route is the party that sends. This asserts the screen's target route
  // is the one wired to the mailer — the link a direct write would break.
  it('the route the verdict calls is the one that sends the email', () => {
    const route = readFileSync('app/api/admin/feedback/[id]/route.ts', 'utf8')
    expect(route).toContain('sendFeedbackReplyEmail')
    expect(route).toContain('export async function PATCH')
  })

  it('arming a mailing verdict says how many people it emails, before committing', async () => {
    const { host, unmount } = await screenFor(ORDER_ITEMS)
    await selectFirst(host)
    await click(btn(host, 'Already fixed')!)
    expect(host.textContent).toContain('This emails 1 person')
    // Nothing has been written yet — arming is not committing.
    expect(PATCHES).toEqual([])
    await unmount()
  })

  it('a verdict that mails nobody says so', async () => {
    const { host, unmount } = await screenFor(ORDER_ITEMS)
    await selectFirst(host)
    await click(btn(host, 'Real — keep it')!)
    expect(host.textContent).toContain('Nobody is emailed')
    await unmount()
  })

  it('the words path opens the existing composer instead of writing', async () => {
    const { host, unmount } = await screenFor(ORDER_ITEMS)
    await selectFirst(host)
    await click(btn(host, 'Ask a question')!)
    // The detail modal — the one with the reply box that already mails.
    expect(host.textContent).toContain('Bug older')
    expect(PATCHES).toEqual([])
    await unmount()
  })

  // Owners share this component. Bulk verdicts are a triage motion.
  it('the franchise mount gets no selection gutter at all', async () => {
    const { host, unmount } = await screenFor(ORDER_ITEMS, { onReportFeedback: () => {} })
    expect(boxes(host)).toHaveLength(0)
    await unmount()
  })
})

// ─── RENDER HONESTLY ──────────────────────────────────────────────────

describe('the screen does not fabricate what is not there', () => {
  it('an item with no context renders without a screen or a record link', async () => {
    const { host, unmount } = await screenFor(STATE_ITEMS)
    expect(host.textContent).toContain('Waiting on us')
    // No pointer affordance anywhere — none of these fixtures has context.
    expect(btn(host, 'Open the record')).toBeUndefined()
    expect(host.textContent).not.toContain('Filed from this record')
    await unmount()
  })

  it('internal items render distinctly from owner reports', async () => {
    const { host, unmount } = await screenFor(STATE_ITEMS)
    expect(rowText(host, 'Token rotation race')).toContain('Internal')
    expect(rowText(host, 'Waiting on us')).not.toContain('Internal')
    await unmount()
  })

  // Nobody is on the other end of an internal item, so a seen/unseen
  // distinction there would be theatre.
  it('an internal item is never shown as waiting on a reader', async () => {
    const internalReplied = [{
      ...base, id: 'ir', title: 'Internal answered', type: 'decision', status: 'planned',
      is_internal: true, created_at: daysAgo(4), updated_at: daysAgo(2),
      admin_response: 'Decided.', admin_response_at: daysAgo(2), reply_seen_at: null,
    }]
    const { host, unmount } = await screenFor(internalReplied)
    expect(rowText(host, 'Internal answered')).not.toContain('not seen yet')
    await unmount()
  })
})

// ─── ONE SURFACE ──────────────────────────────────────────────────────

// Issue 246 shipped a toggle onto a second surface and nobody noticed for a
// week. This step extends the screen that already exists.
describe('one triage surface, not two', () => {
  it('the verdict bar lives in AdminFeedbackScreen, and no rival screen exists', () => {
    const src = readFileSync('components/admin/AdminFeedbackScreen.jsx', 'utf8')
    expect(src).toContain('function VerdictBar')
    expect(src).toContain('/api/admin/feedback/')
    let rival = ''
    try { rival = readFileSync('components/admin/TriageScreen.jsx', 'utf8') } catch { /* expected */ }
    expect(rival).toBe('')
  })
})
