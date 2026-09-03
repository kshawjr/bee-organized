// @vitest-environment happy-dom
//
// THE CONVERSATION, ON BOTH SCREENS.
//
// Owner side ("What you've told us"): the reply is the body of the card — so
// the thread renders as the team's words and the owner's answers on one rail,
// the composer is offered ONLY to the person who filed the report, and a
// status decision is readable without asking anyone (the Fixed pill, the Done
// tab).
//
// Admin side (triage): the list stays a work order — oldest first inside the
// bugs-before-ideas bands — and the two states that need words from us are
// loud: "No reply yet" (never answered) and "They replied · needs an answer"
// (the owner wrote back and the last word is theirs).
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import OwnerFeedbackScreen from '@/components/feedback/OwnerFeedbackScreen'
import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const item = (over: any) => ({
  id: 'x', title: 'A report', description: 'Something happened.', type: 'bug',
  status: 'submitted', user_id: 'u1', submitter_name: 'Ankur Patel',
  submitter_email: 'ankur@pb.com', location_id: 'loc-1', location_name: 'Palm Beach',
  created_at: daysAgo(10), updated_at: daysAgo(10),
  admin_response: null, admin_response_at: null, reply_seen_at: null,
  attachments: [], replies: [], is_internal: false,
  ...over,
})

const teamReply = (over: any = {}) => ({
  id: 'r-team', author_id: 'admin-1', author_role: 'team',
  body: 'We found the cause and a fix is queued.', created_at: daysAgo(3), ...over,
})
const ownerReply = (over: any = {}) => ({
  id: 'r-owner', author_id: 'u1', author_role: 'owner',
  body: 'It happened again this morning.', created_at: daysAgo(1), ...over,
})

function stubFetch(routes: Record<string, any>) {
  const f = vi.fn(async (url: any) => {
    const u = String(url)
    for (const [prefix, payload] of Object.entries(routes)) {
      if (u.startsWith(prefix)) return { ok: true, json: async () => payload } as any
    }
    return { ok: true, json: async () => ({}) } as any
  })
  ;(globalThis as any).fetch = f
  return f
}

async function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(node) })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const asUser = (id: string, node: React.ReactNode) => (
  <CurrentUserContext.Provider value={{ id, email: 'x@y.com' } as any}>{node}</CurrentUserContext.Provider>
)

afterEach(() => { vi.restoreAllMocks() })

// ─── owner screen ─────────────────────────────────────────────────────

describe('the owner sees the conversation', () => {
  it('renders the team reply and the owner answer as a thread, oldest first', async () => {
    stubFetch({
      '/api/feedback/seen': { marked: 1, supported: true },
      '/api/admin/feedback': { items: [item({ admin_response: 'We found the cause and a fix is queued.', admin_response_at: daysAgo(3), replies: [teamReply(), ownerReply()] })] },
    })
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen />))
    const text = host.textContent || ''
    expect(text).toContain('The team replied')
    expect(text).toContain('We found the cause and a fix is queued.')
    expect(text).toContain('You replied')
    expect(text).toContain('It happened again this morning.')
    expect(text.indexOf('We found the cause')).toBeLessThan(text.indexOf('It happened again'))
    await unmount()
  })

  it('a legacy single reply (admin_response, no thread rows) still shows — the 47 production replies survive', async () => {
    stubFetch({
      '/api/feedback/seen': { marked: 1, supported: true },
      '/api/admin/feedback': { items: [item({ admin_response: 'Fixed on July 31.', admin_response_at: daysAgo(20) })] },
    })
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen />))
    expect(host.textContent).toContain('The team replied')
    expect(host.textContent).toContain('Fixed on July 31.')
    await unmount()
  })

  it('offers "Reply to the team" to the submitter, and NOT on a colleague’s report', async () => {
    stubFetch({
      '/api/feedback/seen': { marked: 1, supported: true },
      '/api/admin/feedback': { items: [
        item({ id: 'mine', title: 'My report', user_id: 'u1', admin_response: 'Answered.', admin_response_at: daysAgo(2), replies: [teamReply()] }),
        item({ id: 'theirs', title: 'Colleague report', user_id: 'u2', submitter_name: 'Casey Lee', admin_response: 'Also answered.', admin_response_at: daysAgo(2), replies: [teamReply({ id: 'r-t2', body: 'Also answered.' })] }),
      ] },
    })
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen />))
    const replyButtons = [...host.querySelectorAll('button')]
      .filter(b => (b.textContent || '').trim() === 'Reply to the team')
    expect(replyButtons).toHaveLength(1)
    await unmount()
  })

  it('an unanswered report cannot be replied to yet — answering is what the box is for', async () => {
    stubFetch({
      '/api/feedback/seen': { marked: 1, supported: true },
      '/api/admin/feedback': { items: [item({})] },
    })
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen />))
    expect(host.textContent).toContain('Nobody’s replied yet.')
    expect([...host.querySelectorAll('button')].some(b => (b.textContent || '').trim() === 'Reply to the team')).toBe(false)
    await unmount()
  })

  it('a decided item is readable without asking anyone — the Fixed pill on the Done tab', async () => {
    stubFetch({
      '/api/feedback/seen': { marked: 1, supported: true },
      '/api/admin/feedback': { items: [item({ status: 'shipped', admin_response: 'Done.', admin_response_at: daysAgo(1), reply_seen_at: daysAgo(0) })] },
    })
    // All items decided → the screen lands on Done (issue 236) and the status
    // reads in the owner's four words, not the database's six.
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen />))
    expect(host.textContent).toContain('Fixed')
    await unmount()
  })
})

// ─── admin screen ─────────────────────────────────────────────────────

const adminRoutes = (items: any[]) => ({
  '/api/admin/feedback/analysis': { analyses: [], clusters: [], drafts: [] },
  '/api/admin/feedback': { items },
})

describe('triage stays a work order', () => {
  it('orders oldest first within the bugs-before-ideas bands', async () => {
    stubFetch(adminRoutes([
      item({ id: 'b-new', title: 'Fresh bug', type: 'bug', created_at: daysAgo(2), updated_at: daysAgo(2) }),
      item({ id: 'f-old', title: 'Ancient idea', type: 'feature', created_at: daysAgo(60), updated_at: daysAgo(60) }),
      item({ id: 'b-old', title: 'Old bug', type: 'bug', created_at: daysAgo(40), updated_at: daysAgo(40) }),
    ]))
    const { host, unmount } = await mount(asUser('admin-1', <AdminFeedbackScreen />))
    const text = host.textContent || ''
    // Bugs lead, oldest first; the older-than-everything idea still sorts last.
    expect(text.indexOf('Old bug')).toBeLessThan(text.indexOf('Fresh bug'))
    expect(text.indexOf('Fresh bug')).toBeLessThan(text.indexOf('Ancient idea'))
    await unmount()
  })

  it('marks the unanswered and the owner-wrote-back states so neither can hide', async () => {
    stubFetch(adminRoutes([
      item({ id: 'quiet', title: 'Never answered', created_at: daysAgo(30) }),
      item({
        id: 'ball-ours', title: 'They wrote back', created_at: daysAgo(20),
        admin_response: 'We found the cause and a fix is queued.', admin_response_at: daysAgo(3),
        replies: [teamReply(), ownerReply()],
      }),
    ]))
    const { host, unmount } = await mount(asUser('admin-1', <AdminFeedbackScreen />))
    // Both sit in "Needs an answer" — the unanswered one because nobody has
    // spoken, the other because the OWNER spoke last — and the row says so.
    const needs = host.querySelector('section[aria-label="Needs an answer"]')!
    expect(needs.textContent).toContain('Never answered')
    expect(needs.textContent).toContain('They wrote back')
    expect(needs.textContent).toContain('They replied')
    expect(host.querySelector('section[aria-label="Waiting on them"]')!.textContent).toContain('Nothing here.')
    await unmount()
  })
})
