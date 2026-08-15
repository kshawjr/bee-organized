// @vitest-environment happy-dom
//
// "What you've told us" — the owner/manager feedback screen. Issue 235.
//
// The screen exists because owners were mounting the corp triage console with
// one prop changed. So most of what is asserted here is ABSENCE: no status
// control, no reply box, no queue metrics, nothing hidden behind a toggle. The
// rest is that the reply — the reason someone opens this screen — renders as
// the body of the card, in text, with the team's actual words.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import OwnerFeedbackScreen, {
  isUnreadReply, unreadSentence, agoPhrase, isDoneItem, hasReply,
} from '@/components/feedback/OwnerFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

// u1 is the viewer (the owner). u2 is a colleague at the same location — no
// production location has a second submitter today, but the screen must not
// assume one, so one is here.
const ITEMS = [
  {
    id: 'a1', title: 'Closed Lost clients showing back up in my inbox',
    description: 'I put Mary and Chelsea in Closed Lost from the estimate. They then showed up in my inbox as new leads.',
    type: 'bug', status: 'shipped', user_id: 'u1', submitter_name: 'Ankur Patel',
    location_id: 'loc-1', created_at: daysAgo(12), updated_at: daysAgo(2),
    admin_response: 'Good catch — closed clients now stay out of the inbox.',
    admin_response_at: daysAgo(2), reply_seen_at: null, attachments: [],
  },
  {
    id: 'a2', title: 'Bulk update',
    description: 'Would like a way to add several people to the Network at once.',
    type: 'feature', status: 'under_review', user_id: 'u1', submitter_name: 'Ankur Patel',
    location_id: 'loc-1', created_at: daysAgo(58), updated_at: daysAgo(19),
    admin_response: 'Good idea. Before building it we would like to understand the real pain.',
    admin_response_at: daysAgo(19), reply_seen_at: daysAgo(18), attachments: [],
  },
  {
    id: 'a3', title: 'Client showing in Request, should be in New',
    description: 'Potential repeat client, but showing up in request and not new.',
    type: 'bug', status: 'submitted', user_id: 'u1', submitter_name: 'Ankur Patel',
    location_id: 'loc-1', created_at: daysAgo(11), updated_at: daysAgo(11),
    admin_response: null, admin_response_at: null, reply_seen_at: null, attachments: [],
  },
  {
    id: 'a4', title: 'Email cut off partway down',
    description: 'The lead email stops halfway through on my phone.',
    type: 'bug', status: 'planned', user_id: 'u1', submitter_name: 'Ankur Patel',
    location_id: 'loc-1', created_at: daysAgo(58), updated_at: daysAgo(14),
    admin_response: 'Reproduced it on an iPhone — on the list to fix.',
    admin_response_at: daysAgo(14), reply_seen_at: null, attachments: [],
  },
  {
    id: 'a5', title: 'Not doing this one',
    description: 'A thing we decided against.', type: 'feature', status: 'declined',
    user_id: 'u1', submitter_name: 'Ankur Patel', location_id: 'loc-1',
    created_at: daysAgo(40), updated_at: daysAgo(30),
    admin_response: null, admin_response_at: null, reply_seen_at: null, attachments: [],
  },
  {
    id: 'b1', title: 'A colleague report',
    description: 'Filed by someone else at this location.', type: 'bug', status: 'submitted',
    user_id: 'u2', submitter_name: 'Dana Manager', location_id: 'loc-1',
    created_at: daysAgo(4), updated_at: daysAgo(4),
    admin_response: 'We are on it.', admin_response_at: daysAgo(1),
    reply_seen_at: null, attachments: [{ path: 'u2/x.png', name: 'x.png', size: 100, type: 'image/png' }],
  },
]

let seenCalls: any[] = []

function stubFetch(items = ITEMS) {
  seenCalls = []
  const f = vi.fn(async (url: any, opts: any) => {
    const u = String(url)
    if (u.startsWith('/api/feedback/seen')) {
      seenCalls.push(JSON.parse(opts.body))
      return { ok: true, json: async () => ({ marked: 1, supported: true }) } as any
    }
    return { ok: true, json: async () => ({ items }) } as any
  })
  ;(globalThis as any).fetch = f
  return f
}

async function mountScreen(items = ITEMS, onReport: any = () => {}) {
  // Seed the stub with THIS mount's rows — the empty and un-migrated cases are
  // the whole reason the argument exists.
  stubFetch(items)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={{ id: 'u1', email: 'ankur@pb.com' } as any}>
        <OwnerFeedbackScreen onReportSomething={onReport} />
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => { await Promise.resolve() })
  return {
    host,
    unmount: async () => { await act(async () => root.unmount()); host.remove() },
  }
}

const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')] as HTMLButtonElement[]
const byText = (host: HTMLElement, t: string) =>
  buttons(host).find(b => (b.textContent || '').trim() === t)
const click = async (el: any) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }

beforeEach(() => { stubFetch() })
afterEach(() => { vi.restoreAllMocks() })

// ── the absences — this is the point of the screen ────────────
describe('an owner gets no write controls at all', () => {
  it('no status control anywhere — not the triage words, not the plain ones as buttons', async () => {
    const { host, unmount } = await mountScreen()
    // The triage vocabulary is gone entirely.
    for (const w of ['under_review', 'in_progress', 'Looking at it', 'Not planned yet', 'Save and send']) {
      expect(host.textContent).not.toContain(w)
    }
    // And the plain words that DO appear are never operable controls.
    for (const w of ['Sent', 'Being looked at', 'Planned', 'Fixed']) {
      expect(byText(host, w)).toBeFalsy()
    }
    await unmount()
  })

  it('no reply box, no textarea, no form field of any kind', async () => {
    const { host, unmount } = await mountScreen()
    expect(host.querySelectorAll('textarea').length).toBe(0)
    expect(host.querySelectorAll('input').length).toBe(0)
    expect(host.querySelectorAll('select').length).toBe(0)
    await unmount()
  })

  it('never reads the viewer their own name back as a From line', async () => {
    const { host, unmount } = await mountScreen()
    expect(host.textContent).not.toContain('From:')
    expect(host.textContent).not.toContain('Reported by Ankur Patel')
    await unmount()
  })

  it('carries none of Bee Organized backlog metrics', async () => {
    const { host, unmount } = await mountScreen()
    for (const w of ['Going stale', 'Not looked at yet', 'Being worked on', 'oldest waiting',
                     'quiet 14+ days', 'Replied, still marked New', 'in hand', 'Just mine']) {
      expect(host.textContent).not.toContain(w)
    }
    await unmount()
  })

  it('the only PATCH-capable route it can reach is never called — it reads, and marks seen', async () => {
    const f = stubFetch()
    const { unmount } = await mountScreen()
    const methods = f.mock.calls.map(c => (c[1] as any)?.method).filter(Boolean)
    expect(methods.every(m => m === 'POST')).toBe(true)
    const urls = f.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.startsWith('/api/admin/feedback/'))).toBe(false)
    await unmount()
  })
})

// ── the reply is the point ────────────────────────────────────
describe('the reply renders as text, as the body of the card', () => {
  // a4 is open-and-answered, so it is on the default (Open) tab since issue
  // 236. a1's reply says the same thing about a shipped item and is asserted
  // through the Done tab below.
  it('quotes the team words with when they arrived', async () => {
    const { host, unmount } = await mountScreen()
    expect(host.textContent).toContain('Reproduced it on an iPhone — on the list to fix.')
    expect(host.textContent).toContain('The team replied, 14 days ago')
    await unmount()
  })

  it('quotes them on a finished item too', async () => {
    const { host, unmount } = await mountScreen()
    await click(buttons(host).find(b => (b.textContent || '').startsWith('Done · '))!)
    expect(host.textContent).toContain('Good catch — closed clients now stay out of the inbox.')
    expect(host.textContent).toContain('The team replied, 2 days ago')
    await unmount()
  })

  it('says so plainly when nobody has replied', async () => {
    const { host, unmount } = await mountScreen()
    expect(host.textContent).toContain('Nobody’s replied yet.')
    await unmount()
  })

  it('shows the four plain words, never the database ones', async () => {
    const { host, unmount } = await mountScreen()
    // The open vocabulary is on the landing tab…
    expect(host.textContent).toContain('Being looked at')
    expect(host.textContent).toContain('Planned')
    expect(host.textContent).toContain('Sent')
    // …and the finished word is one tab away (issue 236 moved it there).
    await click(buttons(host).find(b => (b.textContent || '').startsWith('Done · '))!)
    expect(host.textContent).toContain('Fixed')
    await unmount()
  })
})

// ── done is a tab ─────────────────────────────────────────────
describe('done is a tab, not a collapsed toggle', () => {
  it('offers Done as a tab with a count, and no Show-N-closed control', async () => {
    const { host, unmount } = await mountScreen()
    expect(buttons(host).some(b => (b.textContent || '').startsWith('Done · '))).toBe(true)
    // No show/hide-closed CONTROL. Matched on the toggle's SHAPE, not on the
    // word: "Closed Lost clients…" is the owner's own report title, and the
    // card header is itself a button, so a bare /closed/ sweep hits their words.
    expect(buttons(host).some(b => /(show|hide)\s+\d*\s*closed/i.test(b.textContent || ''))).toBe(false)
    await unmount()
  })

  it('the Done tab reaches the shipped AND the declined item', async () => {
    const { host, unmount } = await mountScreen()
    await click(buttons(host).find(b => (b.textContent || '').startsWith('Done · '))!)
    expect(host.textContent).toContain('Closed Lost clients showing back up in my inbox')
    expect(host.textContent).toContain('Not doing this one')
    // …and a declined item is NOT dressed up as Fixed.
    expect(host.textContent).toContain('Not planned')
    await unmount()
  })

  it('Waiting shows only the unanswered open one', async () => {
    const { host, unmount } = await mountScreen()
    await click(buttons(host).find(b => (b.textContent || '').startsWith('Waiting · '))!)
    expect(host.textContent).toContain('Client showing in Request')
    expect(host.textContent).not.toContain('Bulk update')
    await unmount()
  })
})

// ── the banner ────────────────────────────────────────────────
describe('the unread-replies banner', () => {
  it('counts only replies to the VIEWER own reports, and names them', async () => {
    const { host, unmount } = await mountScreen()
    // a1 (unseen) and a4 (unseen) are u1's. a2 was seen. b1 is u2's reply —
    // it must NOT be counted, it is not the viewer's mail.
    expect(host.textContent).toContain('Two new replies')
    expect(host.textContent).toContain('“Closed Lost clients showing back up in my inbox”')
    expect(host.textContent).not.toContain('“A colleague report”')
    await unmount()
  })

  it('marks exactly those items seen, and nothing else', async () => {
    const { unmount } = await mountScreen()
    expect(seenCalls.length).toBe(1)
    expect(seenCalls[0].ids.sort()).toEqual(['a1', 'a4'])
    await unmount()
  })

  it('FAILS SOFT: no banner and no write when the column is not migrated yet', async () => {
    // Rows without the key at all — what PostgREST returns pre-migration.
    const unmigrated = ITEMS.map(({ reply_seen_at, ...rest }) => rest)
    const { host, unmount } = await mountScreen(unmigrated as any)
    expect(host.textContent).not.toContain('new replies')
    expect(host.textContent).not.toContain('new reply')
    expect(seenCalls.length).toBe(0)
    // The replies themselves still render — nothing is hidden by the absence.
    // (a4's, since the default tab is Open since issue 236; a1's is on Done.)
    expect(host.textContent).toContain('Reproduced it on an iPhone — on the list to fix.')
    await unmount()
  })
})

// ── colleagues ────────────────────────────────────────────────
describe('items filed by someone else at the same location', () => {
  it('names who filed it, and does not try to render their attachment', async () => {
    const { host, unmount } = await mountScreen()
    expect(host.textContent).toContain('Reported by Dana Manager')
    // The signed-URL endpoint 403s for a colleague path, so a count, not an img.
    expect(host.textContent).toContain('1 attachment')
    expect(host.querySelectorAll('img').length).toBe(0)
    await unmount()
  })
})

// ── empty state ───────────────────────────────────────────────
describe('the empty state — most people who open this screen see it', () => {
  it('invites a report rather than reading as an error', async () => {
    const { host, unmount } = await mountScreen([])
    expect(host.textContent).toContain('Nothing here yet')
    expect(host.textContent).toContain('We read every one and write back')
    // Never the vocabulary of a failed query.
    for (const w of ['No results', 'No items', 'not found', 'No feedback matches']) {
      expect(host.textContent).not.toContain(w)
    }
    await unmount()
  })

  it('still offers the way to file one', async () => {
    const onReport = vi.fn()
    const { host, unmount } = await mountScreen([], onReport)
    await click(byText(host, 'Report something')!)
    expect(onReport).toHaveBeenCalled()
    await unmount()
  })

  it('hides the tab row when there is nothing to filter', async () => {
    const { host, unmount } = await mountScreen([])
    expect(buttons(host).some(b => (b.textContent || '').startsWith('Done'))).toBe(false)
    await unmount()
  })
})

// ── the pure helpers ──────────────────────────────────────────
describe('unread arithmetic', () => {
  const base = { id: 'x', user_id: 'u1', admin_response: 'hi', admin_response_at: daysAgo(2) }
  it('unread when never seen', () => {
    expect(isUnreadReply({ ...base, reply_seen_at: null }, 'u1')).toBe(true)
  })
  it('read when seen after the reply', () => {
    expect(isUnreadReply({ ...base, reply_seen_at: daysAgo(1) }, 'u1')).toBe(false)
  })
  it('UNREAD AGAIN when a SECOND reply lands after the last read', () => {
    // The reason this is a timestamp and not a boolean.
    expect(isUnreadReply({ ...base, admin_response_at: daysAgo(1), reply_seen_at: daysAgo(3) }, 'u1')).toBe(true)
  })
  it('never unread for someone else report', () => {
    expect(isUnreadReply({ ...base, user_id: 'u2', reply_seen_at: null }, 'u1')).toBe(false)
  })
  it('never unread with no reply', () => {
    expect(isUnreadReply({ ...base, admin_response: null, reply_seen_at: null }, 'u1')).toBe(false)
  })
})

describe('banner sentence', () => {
  it('one, two, then two-and-the-rest', () => {
    expect(unreadSentence([{ title: 'A' }])).toBe('The team got back to you about “A”.')
    expect(unreadSentence([{ title: 'A' }, { title: 'B' }])).toBe('The team got back to you about “A” and “B”.')
    expect(unreadSentence([{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }]))
      .toBe('The team got back to you about “A”, “B” and 2 more.')
  })
})

describe('age phrasing', () => {
  it('stays in days past a month rather than flipping to a date', () => {
    expect(agoPhrase(daysAgo(58))).toBe('58 days ago')
    expect(agoPhrase(daysAgo(1))).toBe('1 day ago')
  })
})

describe('done / reply predicates', () => {
  it('shipped and declined are both done', () => {
    expect(isDoneItem({ status: 'shipped' })).toBe(true)
    expect(isDoneItem({ status: 'declined' })).toBe(true)
    expect(isDoneItem({ status: 'planned' })).toBe(false)
  })
  it('whitespace is not a reply', () => {
    expect(hasReply({ admin_response: '   ' })).toBe(false)
    expect(hasReply({ admin_response: 'x' })).toBe(true)
  })
})
