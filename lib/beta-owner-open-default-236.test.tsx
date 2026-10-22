// @vitest-environment happy-dom
//
// issue 236 — THE OWNER SCREEN OPENS ON WHAT IS STILL OPEN.
//
// Issue 235's default view was "Everything", so the Palm Beach owner's first
// screen was thirty-one cards with nineteen already-fixed ones mixed through
// them. Issue 236 fixed it with an Open tab; the help-desk redesign removed the
// tabs (Open double-counted Answered and Waiting) and kept the promise: the
// open items are the list, and the finished ones fold behind ONE link that
// says how many — still one click away, because nineteen fixed things are the
// evidence that reporting works.
//
// The case worth most of this file: an owner whose items are ALL finished.
// Opening them onto a bare "Show 2 closed" link would be a worse screen than
// the crowding being fixed, so their finished items start unfolded.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import OwnerFeedbackScreen from '@/components/feedback/OwnerFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()

const item = (over: any) => ({
  id: 'x', title: 'A report', description: 'Something happened.', type: 'bug',
  status: 'submitted', user_id: 'u1', submitter_name: 'Ankur Patel', location_id: 'loc-1',
  created_at: daysAgo(10), updated_at: daysAgo(10),
  admin_response: null, admin_response_at: null, reply_seen_at: null, attachments: [],
  ...over,
})

// A miniature of the real Palm Beach shape: mostly done, a few still live.
const MIXED = [
  item({ id: 'd1', title: 'Fixed thing one', status: 'shipped', created_at: daysAgo(20), admin_response: 'Sorted.', admin_response_at: daysAgo(19), reply_seen_at: daysAgo(18) }),
  item({ id: 'd2', title: 'Fixed thing two', status: 'shipped', created_at: daysAgo(18) }),
  item({ id: 'd3', title: 'Declined thing', status: 'declined', created_at: daysAgo(30) }),
  item({ id: 'o1', title: 'Still waiting on this', status: 'submitted', created_at: daysAgo(5) }),
  item({ id: 'o2', title: 'Answered but not finished', status: 'planned', created_at: daysAgo(9), admin_response: 'On the list.', admin_response_at: daysAgo(3), reply_seen_at: daysAgo(2) }),
]

const ALL_DONE = [
  item({ id: 'd1', title: 'The one thing I ever reported', status: 'shipped', created_at: daysAgo(40), admin_response: 'Fixed it.', admin_response_at: daysAgo(35), reply_seen_at: daysAgo(34) }),
  item({ id: 'd2', title: 'And this one', status: 'declined', created_at: daysAgo(50) }),
]

function stubFetch(items: any[]) {
  const f = vi.fn(async (url: any) => {
    if (String(url).startsWith('/api/feedback/seen')) {
      return { ok: true, json: async () => ({ marked: 1, supported: true }) } as any
    }
    return { ok: true, json: async () => ({ items }) } as any
  })
  ;(globalThis as any).fetch = f
  return f
}

async function mountScreen(items: any[]) {
  stubFetch(items)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <CurrentUserContext.Provider value={{ id: 'u1', email: 'ankur@pb.com' } as any}>
        <OwnerFeedbackScreen onReportSomething={() => {}} />
      </CurrentUserContext.Provider>,
    )
  })
  await act(async () => { await Promise.resolve() })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')] as HTMLButtonElement[]
const fold = (host: HTMLElement) => host.querySelector('[data-feedback-closed-toggle]') as HTMLButtonElement | null
const click = async (el: any) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }

afterEach(() => { vi.restoreAllMocks() })

describe('the default view is what is still open', () => {
  it('shows the open items and NOT the finished ones', async () => {
    const { host, unmount } = await mountScreen(MIXED)
    expect(host.textContent).toContain('Still waiting on this')
    expect(host.textContent).toContain('Answered but not finished')
    // The three decided ones are not in the way.
    expect(host.textContent).not.toContain('Fixed thing one')
    expect(host.textContent).not.toContain('Fixed thing two')
    expect(host.textContent).not.toContain('Declined thing')
    await unmount()
  })

  it('says how many are still with the team — and has no tabs, Everything or otherwise', async () => {
    const { host, unmount } = await mountScreen(MIXED)
    expect(host.textContent).toContain('5 sent · 2 still with the team')
    expect(host.querySelector('[aria-pressed], [role="tab"]')).toBeNull()
    expect(buttons(host).some(b => (b.textContent || '').includes('Everything'))).toBe(false)
    await unmount()
  })
})

describe('the finished ones are still reachable', () => {
  it('one link, carrying the count, reaches both shipped and declined', async () => {
    const { host, unmount } = await mountScreen(MIXED)
    expect(fold(host)!.textContent).toMatch(/^Show 3 closed/)
    await click(fold(host))
    expect(host.textContent).toContain('Fixed thing one')
    expect(host.textContent).toContain('Declined thing')
    // The open ones stay where they were — unfolding adds, it does not swap.
    expect(host.textContent).toContain('Still waiting on this')
    await unmount()
  })
})

// THE EMPTY-LIST CASE. Ten of the twenty-one owners have never filed anything
// and most of the rest have filed once or twice, so "every item I ever sent is
// finished" is a live shape, not a hypothetical.
describe('an owner whose items are ALL finished', () => {
  it('sees them straight away — never a bare link over an empty list', async () => {
    const { host, unmount } = await mountScreen(ALL_DONE)
    expect(host.textContent).toContain('The one thing I ever reported')
    expect(host.textContent).toContain('And this one')
    expect(fold(host)!.getAttribute('aria-expanded')).toBe('true')
    await unmount()
  })

  it('gets an explanation of the empty open list rather than a blank', async () => {
    const { host, unmount } = await mountScreen(ALL_DONE)
    expect(host.textContent).toContain('Nothing open')
    expect(host.textContent).toContain('has been dealt with')
    await unmount()
  })

  it('can still fold them away, and the choice sticks', async () => {
    const { host, unmount } = await mountScreen(ALL_DONE)
    await click(fold(host))
    expect(host.textContent).not.toContain('The one thing I ever reported')
    expect(fold(host)!.getAttribute('aria-expanded')).toBe('false')
    await unmount()
  })
})

describe('an owner with nothing at all is unchanged', () => {
  it('still gets the invitation to report, and no closed link to land on', async () => {
    const { host, unmount } = await mountScreen([])
    expect(host.textContent).toContain('Nothing here yet')
    expect(host.textContent).toContain('We read every one and write back')
    expect(fold(host)).toBeNull()
    await unmount()
  })
})
