// @vitest-environment happy-dom
//
// issue 236 — THE OWNER SCREEN OPENS ON WHAT IS STILL OPEN.
//
// Issue 235's default tab was "Everything", so the Palm Beach owner's first
// screen was thirty-one cards with nineteen already-fixed ones mixed through
// them, and the handful still owed an answer had to be found among them. Issue
// 233 fixed the same fault on the triage side by hiding closed items; this is
// that fix arriving from the other direction.
//
// Done stays a tab — nineteen fixed things are the evidence that reporting
// works, which is what makes someone report again. It just is not the first
// thing in the way.
//
// The case worth most of this file: an owner whose items are ALL finished.
// Defaulting them onto an empty "Nothing open" card would be a worse screen
// than the crowding being fixed, so they land on Done instead.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import OwnerFeedbackScreen, { defaultTabFor } from '@/components/feedback/OwnerFeedbackScreen'
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
const tab = (host: HTMLElement, prefix: string) =>
  buttons(host).find(b => (b.textContent || '').trim().startsWith(prefix))
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

  it('lands on Open, and says how many — no "Everything" tab any more', async () => {
    const { host, unmount } = await mountScreen(MIXED)
    const open = tab(host, 'Open')!
    expect(open).toBeTruthy()
    expect(open.textContent).toContain('· 2')
    expect(open.getAttribute('aria-pressed')).toBe('true')
    expect(buttons(host).some(b => (b.textContent || '').includes('Everything'))).toBe(false)
    await unmount()
  })
})

describe('Done is still reachable', () => {
  it('is a tab, carrying its count, and it reaches both shipped and declined', async () => {
    const { host, unmount } = await mountScreen(MIXED)
    const done = tab(host, 'Done')!
    expect(done.textContent).toContain('· 3')
    await click(done)
    expect(host.textContent).toContain('Fixed thing one')
    expect(host.textContent).toContain('Declined thing')
    // …and the open ones step aside in turn — these are tabs, not a filter that
    // only ever adds.
    expect(host.textContent).not.toContain('Still waiting on this')
    await unmount()
  })

  it('nothing is hidden behind a show/hide-closed toggle instead', async () => {
    const { host, unmount } = await mountScreen(MIXED)
    expect(buttons(host).some(b => /(show|hide)\s+\d*\s*closed/i.test(b.textContent || ''))).toBe(false)
    await unmount()
  })
})

// THE EMPTY-TAB CASE. Ten of the twenty-one owners have never filed anything
// and most of the rest have filed once or twice, so "every item I ever sent is
// finished" is a live shape, not a hypothetical.
describe('an owner whose items are ALL finished', () => {
  it('lands on Done and sees them — never an empty Open tab', async () => {
    const { host, unmount } = await mountScreen(ALL_DONE)
    expect(tab(host, 'Done')!.getAttribute('aria-pressed')).toBe('true')
    expect(tab(host, 'Open')!.getAttribute('aria-pressed')).toBe('false')
    expect(host.textContent).toContain('The one thing I ever reported')
    expect(host.textContent).not.toContain('Nothing open')
    await unmount()
  })

  it('can still choose Open, and gets an explanation rather than a blank', async () => {
    const { host, unmount } = await mountScreen(ALL_DONE)
    await click(tab(host, 'Open')!)
    expect(host.textContent).toContain('Nothing open')
    expect(host.textContent).toContain('has been dealt with')
    // A chosen tab STAYS chosen — the default must not pull them back to Done.
    expect(tab(host, 'Open')!.getAttribute('aria-pressed')).toBe('true')
    await unmount()
  })
})

describe('an owner with nothing at all is unchanged', () => {
  it('still gets the invitation to report, and no tab row to land on', async () => {
    const { host, unmount } = await mountScreen([])
    expect(host.textContent).toContain('Nothing here yet')
    expect(host.textContent).toContain('We read every one and write back')
    expect(tab(host, 'Done')).toBeFalsy()
    expect(tab(host, 'Open')).toBeFalsy()
    await unmount()
  })
})

describe('the rule itself', () => {
  it('open unless there is nothing open and something finished', () => {
    expect(defaultTabFor({ open: 4, done: 19 })).toBe('open')
    expect(defaultTabFor({ open: 0, done: 3 })).toBe('done')
    // Nothing at all is NOT the Done case — that screen has no tabs and gets
    // the invitation empty state instead.
    expect(defaultTabFor({ open: 0, done: 0 })).toBe('open')
  })
})
