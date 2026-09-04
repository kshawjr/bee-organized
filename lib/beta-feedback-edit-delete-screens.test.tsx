// @vitest-environment happy-dom
//
// WHAT THE OWNER SEES, AND WHAT THE TEAM SEES.
//
// Owner side (Help › My requests): Edit and Delete are on YOUR OWN card and
// nobody else's; Edit disappears the moment the team replies, and the reply box
// is what stands in its place; the confirmation says the irreversible part.
//
// Team side (triage): a report the owner withdrew mid-conversation does not
// fail with "please try again" — that would be a lie, since trying again can
// never work. It says what happened and that no reply went out.
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
  id: 'x', title: 'Sort not permanent', description: 'The A-Z sort resets on refresh.',
  type: 'bug', status: 'submitted', user_id: 'u1', submitter_name: 'Ankur Patel',
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

function stubFetch(routes: Record<string, any>) {
  const f = vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    for (const [key, payload] of Object.entries(routes)) {
      if (u.startsWith(key)) {
        const p = typeof payload === 'function' ? (payload as any)(init) : payload
        if (p && p.__status && p.__status >= 400) {
          return { ok: false, status: p.__status, json: async () => p.body } as any
        }
        return { ok: true, status: 200, json: async () => p } as any
      }
    }
    return { ok: true, status: 200, json: async () => ({}) } as any
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

const buttons = (host: HTMLElement) => Array.from(host.querySelectorAll('button')) as HTMLButtonElement[]
const byText = (host: HTMLElement, text: string) =>
  buttons(host).find(b => (b.textContent || '').trim() === text) || null
const click = async (el: Element | null) => { await act(async () => { (el as HTMLElement)?.click() }) }

afterEach(() => { vi.restoreAllMocks() })

// ─── the owner's own card ─────────────────────────────────────────────

describe('Edit and Delete on Help › My requests', () => {
  it('offers both on your own unanswered report', async () => {
    stubFetch({ '/api/admin/feedback': { items: [item({})] } })
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen />))
    expect(byText(host, 'Edit')).toBeTruthy()
    expect(byText(host, 'Delete')).toBeTruthy()
    await unmount()
  })

  it('offers NEITHER on a colleague’s report at the same location', async () => {
    // A location may have more than one submitter. Reading their card is fine;
    // touching it is not — and the screen must not offer what the route refuses.
    stubFetch({ '/api/admin/feedback': { items: [item({ user_id: 'someone-else' })] } })
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen />))
    expect(byText(host, 'Edit')).toBeNull()
    expect(byText(host, 'Delete')).toBeNull()
    await unmount()
  })

  it('swaps Edit for the reply box the moment the team replies', async () => {
    // The lock is not announced — the thing to do instead simply appears.
    stubFetch({
      '/api/feedback/seen': { marked: 1, supported: true },
      '/api/admin/feedback': { items: [item({
        admin_response: 'We found the cause and a fix is queued.',
        admin_response_at: daysAgo(3), replies: [teamReply()],
      })] },
    })
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen />))
    expect(byText(host, 'Edit')).toBeNull()
    expect(byText(host, 'Reply to the team')).toBeTruthy()
    // Delete survives a reply — it has no such gate.
    expect(byText(host, 'Delete')).toBeTruthy()
    await unmount()
  })

  it('saves an edit and shows the stored words, without a refetch', async () => {
    const f = stubFetch({
      '/api/admin/feedback': { items: [item({})] },
      '/api/feedback/x': { ...item({}), title: 'Sort does not stick', description: 'It resets every refresh.' },
    })
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen />))
    await click(byText(host, 'Edit'))

    const input = host.querySelector('input#fb-title-x') as HTMLInputElement
    const area = host.querySelector('textarea#fb-desc-x') as HTMLTextAreaElement
    expect(input.value).toBe('Sort not permanent')
    await act(async () => {
      const setV = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setV.call(input, 'Sort does not stick')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const setA = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setA.call(area, 'It resets every refresh.')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(byText(host, 'Save changes'))

    const call = f.mock.calls.find(c => String(c[0]) === '/api/feedback/x')
    expect((call![1] as any).method).toBe('PATCH')
    expect(JSON.parse((call![1] as any).body)).toEqual({
      title: 'Sort does not stick', description: 'It resets every refresh.',
    })
    // The card is back, showing what the server stored — and the list was NOT
    // refetched, so nothing scrolls away.
    expect(host.textContent).toContain('Sort does not stick')
    expect(f.mock.calls.filter(c => String(c[0]).startsWith('/api/admin/feedback'))).toHaveLength(1)
    await unmount()
  })

  it('says the lock in words when a reply lands while the form is open', async () => {
    const f = stubFetch({
      '/api/admin/feedback': { items: [item({})] },
      '/api/feedback/x': { __status: 409, body: { error: 'edit_locked_after_reply' } },
    })
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen />))
    await click(byText(host, 'Edit'))
    const input = host.querySelector('input#fb-title-x') as HTMLInputElement
    await act(async () => {
      const setV = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setV.call(input, 'A changed title')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(byText(host, 'Save changes'))
    expect(host.textContent).toContain('The team replied while you were editing')
    // The typing is still in the box — the one failure that must not lose it.
    expect((host.querySelector('input#fb-title-x') as HTMLInputElement).value).toBe('A changed title')
    expect(f).toBeTruthy()
    await unmount()
  })
})

describe('the delete confirmation', () => {
  it('asks with the irreversible part, and Keep it backs out unharmed', async () => {
    const f = stubFetch({ '/api/admin/feedback': { items: [item({ attachments: [{ path: 'u1/a-shot.png', name: 'shot.png' }] })] } })
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen />))
    await click(byText(host, 'Delete'))
    expect(host.textContent).toContain('This deletes your report for good — we can’t get it back')
    expect(host.textContent).toContain('and the file you sent goes with it')
    expect(byText(host, 'Yes, delete it')).toBeTruthy()

    await click(byText(host, 'Keep it'))
    expect(host.textContent).not.toContain('This deletes your report for good')
    expect(host.textContent).toContain('Sort not permanent')
    expect(f.mock.calls.some(c => (c[1] as any)?.method === 'DELETE')).toBe(false)
    await unmount()
  })

  it('drops the card and the count when the delete goes through', async () => {
    const f = stubFetch({
      '/api/admin/feedback': { items: [item({}), item({ id: 'y', title: 'Another thing' })] },
      '/api/feedback/x': { deleted: true, id: 'x' },
    })
    const { host, unmount } = await mount(asUser('u1', <OwnerFeedbackScreen />))
    expect(host.textContent).toContain('2 things')

    await click(buttons(host).filter(b => (b.textContent || '').trim() === 'Delete')[0])
    await click(byText(host, 'Yes, delete it'))

    const call = f.mock.calls.find(c => String(c[0]) === '/api/feedback/x')
    expect((call![1] as any).method).toBe('DELETE')
    expect(host.textContent).not.toContain('Sort not permanent')
    expect(host.textContent).toContain('Another thing')
    // The tab counts and the subtitle are derived from the list, so they fall
    // on their own — nothing keeps a second tally.
    expect(host.textContent).toContain('1 thing ·')
    await unmount()
  })
})

// ─── the team's side ──────────────────────────────────────────────────

describe('triage, when the report was withdrawn mid-conversation', () => {
  it('says the report is gone and that no reply was sent — not "try again"', async () => {
    const f = stubFetch({
      '/api/admin/feedback/analysis': { analyses: [], clusters: [], drafts: [] },
      '/api/admin/feedback/x': { __status: 404, body: { error: 'not_found' } },
      '/api/admin/feedback': { items: [item({})] },
    })
    const { host, unmount } = await mount(asUser('admin-1', <AdminFeedbackScreen />))

    // Open the report, type an answer, save it — into a row that is no longer
    // there because its owner deleted it a moment ago. The row button carries
    // the title among pills and dates, so it is matched by CONTENT.
    const row = buttons(host).find(b => (b.textContent || '').includes('Sort not permanent'))
    expect(row).toBeTruthy()
    await click(row!)
    const area = host.querySelector('textarea') as HTMLTextAreaElement
    // No `if (area)` guard: a modal that failed to open must FAIL this test,
    // not skip its assertions and report green.
    expect(area).toBeTruthy()
    {
      await act(async () => {
        const setA = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
        setA.call(area, 'Here is what we found.')
        area.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await click(byText(host, 'Save') || byText(host, 'Save and send'))
      expect(host.textContent).toContain('This report is gone')
      expect(host.textContent).toContain('no reply was sent')
      expect(host.textContent).not.toContain('Could not save — please try again')
    }
    expect(f).toBeTruthy()
    await unmount()
  })
})
