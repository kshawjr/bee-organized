// @vitest-environment happy-dom
//
// Feedback screen type filter — MOUNT tests, not source pins.
//
// Issue 126 made TYPE a single-choice segmented control with live counts.
// Issue 233 retired the status chip row. THE QUEUES REDESIGN turned the type
// control into underlined TABS (the record cards' tab anatomy, underline in
// the type's colour) and retired the "Just mine" axis — the elevated triage
// screen is worked by the team, not by a submitter looking for their own
// rows. What survives HERE is everything that was never about status: the
// type tabs, their faceted counts, and the empty state.
//
// Nothing here is persisted — a stored filter is the issue 123 strand-
// someone-behind-an-old-view trap — so these mount fresh.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'

// Five items, two users, three real statuses.
//   type:   bug   ×3 (i1, i2, i5)   feature ×2 (i3, i4)
//   status: shipped ×2 (i1, i4)     under_review ×2 (i2, i5)   planned ×1 (i3)
// THE DEFAULT VIEW HIDES THE TWO SHIPPED ONES, so the counts assert on the
// OPEN three: i2 (bug), i3 (feature), i5 (bug).
const ITEMS = [
  { id: 'i1', title: 'Login button broken', type: 'bug',     status: 'shipped',      user_id: 'u1', submitter_name: 'Amy Owner',  submitter_email: 'amy@biz.com', created_at: '2026-07-01T00:00:00Z', attachments: [] },
  { id: 'i2', title: 'Report page is slow',  type: 'bug',     status: 'under_review', user_id: 'u2', submitter_name: 'Bob Manager', submitter_email: 'bob@biz.com', created_at: '2026-07-02T00:00:00Z', attachments: [] },
  { id: 'i3', title: 'Dark mode please',     type: 'feature', status: 'planned',      user_id: 'u1', submitter_name: 'Amy Owner',  submitter_email: 'amy@biz.com', created_at: '2026-07-03T00:00:00Z', attachments: [] },
  { id: 'i4', title: 'Export to CSV',        type: 'feature', status: 'shipped',      user_id: 'u2', submitter_name: 'Bob Manager', submitter_email: 'bob@biz.com', created_at: '2026-07-04T00:00:00Z', attachments: [] },
  { id: 'i5', title: 'Typo on invoice',      type: 'bug',     status: 'under_review', user_id: 'u1', submitter_name: 'Amy Owner',  submitter_email: 'amy@biz.com', created_at: '2026-07-05T00:00:00Z', attachments: [] },
]

const stubFetch = (items = ITEMS) =>
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items }) })))

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

// The current viewer is u1 (Amy). Franchise mount → pass onReportFeedback.
const screen = () => (
  <CurrentUserContext.Provider value={{ id: 'u1', email: 'amy@biz.com' } as any}>
    <AdminFeedbackScreen onReportFeedback={() => {}} />
  </CurrentUserContext.Provider>
)

// A type tab is role="tab" with aria-label "<label> tab"; its text is the
// label followed by the count.
const tab = (host: Element, label: string) => host.querySelector(`[aria-label="${label} tab"]`) as HTMLButtonElement | null
const tabCount = (host: Element, label: string) => {
  const m = (tab(host, label)?.textContent || '').match(/(\d+)\s*$/)
  return m ? Number(m[1]) : null
}
const byText = (host: Element, prefix: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim().startsWith(prefix))
const rowTitles = (host: Element) =>
  [...host.querySelectorAll('button')]
    .map(b => ITEMS.find(i => (b.textContent || '').trim().startsWith(i.title))?.title)
    .filter((t): t is string => !!t)

beforeEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('counts match what each tab would actually show', () => {
  it('type counts are the real per-type totals for the OPEN items (Bugs 2, Ideas 1, Everything 3)', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    expect(tabCount(host, 'Everything')).toBe(3)
    expect(tabCount(host, 'Bugs')).toBe(2)   // i2, i5 — i1 is shipped
    expect(tabCount(host, 'Ideas')).toBe(1)  // i3 — i4 is shipped
    expect(tabCount(host, 'Questions')).toBe(0)
    await unmount()
  })

  it('the type counts re-face when closed items are revealed', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    await click(byText(host, 'Show 2 closed')!)
    expect(tabCount(host, 'Everything')).toBe(5)
    expect(tabCount(host, 'Bugs')).toBe(3)
    expect(tabCount(host, 'Ideas')).toBe(2)
    await unmount()
  })
})

describe('selecting a type shows only that type', () => {
  it('Bugs → only the open bug rows; Ideas → only the open feature row', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    expect(rowTitles(host).length).toBe(3)
    await click(tab(host, 'Bugs')!)
    expect(rowTitles(host).sort()).toEqual(['Report page is slow', 'Typo on invoice'].sort())
    expect(tab(host, 'Bugs')!.getAttribute('aria-selected')).toBe('true')
    await click(tab(host, 'Ideas')!)
    expect(rowTitles(host).sort()).toEqual(['Dark mode please'])
    await unmount()
  })
})

describe('status vocabulary stays in plain words wherever it appears', () => {
  it('rows read Looking at it / Planned as plain text, never the raw db values', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    const text = host.textContent || ''
    expect(text).toContain('Looking at it') // under_review ×2
    expect(text).toContain('Planned')       // planned ×1
    expect(text).not.toContain('under_review')
    expect(text).not.toContain('in_progress')
    await unmount()
  })
})

describe('the "Just mine" axis is gone', () => {
  it('no Everyone / Just mine control renders; the type tabs still do', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    expect(byText(host, 'Just mine')).toBeUndefined()
    expect(byText(host, 'Everyone')).toBeUndefined()
    expect(tab(host, 'Bugs')).toBeTruthy()
    await unmount()
  })
})

describe('a zero-result combination says so clearly', () => {
  it('Bugs + a search that matches no one → zero rows and an explicit message', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    await click(tab(host, 'Bugs')!)
    expect(rowTitles(host).length).toBe(2)

    const search = host.querySelector('input[aria-label="Search feedback"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'nobody-matches-zzz')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(rowTitles(host).length).toBe(0)
    expect(host.textContent || '').toContain('No feedback matches these filters')
    await unmount()
  })
})
