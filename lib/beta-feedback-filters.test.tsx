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

// The tiles (the admin redesign) replaced the type tabs. A tile is a button
// with data-tile="<key>" and aria-pressed; its count is [data-tile-count].
const tile = (host: Element, key: string) => host.querySelector(`[data-tile="${key}"]`) as HTMLButtonElement | null
const tileCount = (host: Element, key: string) => {
  const t = tile(host, key)?.querySelector('[data-tile-count]')?.textContent
  return t == null ? null : Number(t)
}
const byText = (host: Element, prefix: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim().startsWith(prefix))
const rowTitles = (host: Element) =>
  [...host.querySelectorAll('button')]
    .map(b => ITEMS.find(i => (b.textContent || '').trim().startsWith(i.title))?.title)
    .filter((t): t is string => !!t)

beforeEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('counts match what each tile would actually show', () => {
  it('tile counts are the real per-tile totals for the OPEN items (Fix 2, Decide 1, Answer 0)', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    // i2 + i5 are unanswered bugs; i3 an unanswered idea; i1 and i4 shipped.
    expect(tileCount(host, 'fix')).toBe(2)
    expect(tileCount(host, 'decide')).toBe(1)
    expect(tileCount(host, 'answer')).toBe(0)
    expect(['build', 'deciding', 'stuck'].map(k => tileCount(host, k))).toEqual([0, 0, 0])
    await unmount()
  })

  it('the tile counts follow the search — they count what the list would show', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    const search = host.querySelector('input[aria-label="Search feedback"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'Typo')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(tileCount(host, 'fix')).toBe(1)
    expect(tileCount(host, 'decide')).toBe(0)
    await unmount()
  })
})

describe('selecting a tile shows only that tile', () => {
  it('Fix → only the open bug rows; Decide → only the open idea row', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    expect(rowTitles(host).length).toBe(3)
    await click(tile(host, 'fix')!)
    expect(rowTitles(host).sort()).toEqual(['Report page is slow', 'Typo on invoice'].sort())
    expect(tile(host, 'fix')!.getAttribute('aria-pressed')).toBe('true')
    await click(tile(host, 'decide')!)
    expect(rowTitles(host).sort()).toEqual(['Dark mode please'])
    await unmount()
  })
})

describe('status vocabulary stays in plain words wherever it appears', () => {
  it('never the raw db values on the screen; the modal speaks the plain words', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    const text = host.textContent || ''
    expect(text).not.toContain('under_review')
    expect(text).not.toContain('in_progress')
    await click(byText(host, 'Typo on invoice')!)
    const sel = host.querySelector('select[aria-label="Status"]') as HTMLSelectElement
    expect(sel.options[sel.selectedIndex].textContent).toBe('Looking at it')
    await unmount()
  })
})

describe('the "Just mine" axis is gone', () => {
  it('no Everyone / Just mine control renders; the tiles do', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    expect(byText(host, 'Just mine')).toBeUndefined()
    expect(byText(host, 'Everyone')).toBeUndefined()
    expect(tile(host, 'fix')).toBeTruthy()
    await unmount()
  })
})

describe('a zero-result combination says so clearly', () => {
  it('Fix + a search that matches no one → zero rows and an explicit message', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    await click(tile(host, 'fix')!)
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
