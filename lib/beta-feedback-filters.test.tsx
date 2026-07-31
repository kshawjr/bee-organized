// @vitest-environment happy-dom
//
// Feedback screen filter redesign (issue 126) — MOUNT tests, not source pins.
//
// The reported problem: owners were confused by the feedback screen's filters
// and the bug/feature "pills". The pills were single-choice but styled like
// multi-select toggles, and the status filter spoke the database vocabulary
// ("under_review"). The redesign:
//   - TYPE is a single-choice segmented control (Everything / Bugs / Ideas),
//     each with a live count.
//   - STATUS reads in plain words (New / Looking at it / Planned / In
//     progress / Fixed), and only statuses present in the data are offered —
//     'declined' is unused in prod, so it never appears.
//   - "Just mine" is its OWN axis (by submitter), and it combines with the
//     rest.
//   - Counts are faceted: each chip shows exactly what it would reveal given
//     the other filters, so no one clicks into an empty list.
//   - A zero-result combination says so, never a blank area.
//
// Nothing here is persisted — that's deliberate (a stored filter is the issue
// 123 strand-someone-behind-an-old-view trap), so these tests mount fresh and
// exercise the live state.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

import { AdminFeedbackScreen, CurrentUserContext } from '@/components/BeeHub'

// Five items, authored across two users, covering three real statuses. The
// counts below are hand-derived from THIS fixture so the assertions are exact.
//   type:   bug   ×3 (i1, i2, i5)   feature ×2 (i3, i4)
//   status: shipped ×2 (i1, i4)     under_review ×2 (i2, i5)   planned ×1 (i3)
//   mine (u1): i1, i3, i5 (×3)      not mine (u2): i2, i4 (×2)
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
  await act(async () => {}) // flush the mount effect's async fetch → setState
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})

// The current viewer is u1 (Amy). Franchise mount → pass onReportFeedback.
const screen = (opts: { user?: any } = {}) => (
  <CurrentUserContext.Provider value={{ id: 'u1', email: 'amy@biz.com', ...(opts.user || {}) } as any}>
    <AdminFeedbackScreen onReportFeedback={() => {}} />
  </CurrentUserContext.Provider>
)

// A filter chip is a <button> whose text is "<label>· <count>" (FilterChips
// renders the count after a middot). Match on the label prefix.
const chip = (host: Element, label: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim().startsWith(label))
const chipCount = (host: Element, label: string) => {
  const t = (chip(host, label)?.textContent || '').trim()
  const m = t.match(/·\s*(\d+)\s*$/)
  return m ? Number(m[1]) : null
}
// Row buttons lead with the item title (then submitter · time · status).
// Map each matching button back to its bare title for a clean comparison.
const rowTitles = (host: Element) =>
  [...host.querySelectorAll('button')]
    .map(b => ITEMS.find(i => (b.textContent || '').trim().startsWith(i.title))?.title)
    .filter((t): t is string => !!t)

beforeEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('counts match what each filter would actually show', () => {
  it('type counts are the real per-type totals up front (Bugs 3, Ideas 2, Everything 5)', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    expect(chipCount(host, 'Everything')).toBe(5)
    expect(chipCount(host, 'Bugs')).toBe(3)
    expect(chipCount(host, 'Ideas')).toBe(2)
    await unmount()
  })

  it('status counts are faceted — picking Bugs re-counts each status against bugs only', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    // Unfiltered: Fixed(shipped) 2, Looking at it(under_review) 2, Planned 1.
    expect(chipCount(host, 'Fixed')).toBe(2)
    expect(chipCount(host, 'Looking at it')).toBe(2)
    expect(chipCount(host, 'Planned')).toBe(1)
    // Select Bugs → Fixed should now count bug+shipped (i1) = 1, Looking at it
    // bug+under_review (i2,i5) = 2, and Planned (only feature i3) drops out.
    await click(chip(host, 'Bugs')!)
    expect(chipCount(host, 'Fixed')).toBe(1)
    expect(chipCount(host, 'Looking at it')).toBe(2)
    expect(chip(host, 'Planned')).toBeUndefined()
    await unmount()
  })
})

describe('selecting a type shows only that type', () => {
  it('Bugs → only the three bug rows; Ideas → only the two feature rows', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    expect(rowTitles(host).length).toBe(5)
    await click(chip(host, 'Bugs')!)
    expect(rowTitles(host).sort()).toEqual(
      ['Login button broken', 'Report page is slow', 'Typo on invoice'].sort()
    )
    await click(chip(host, 'Ideas')!)
    expect(rowTitles(host).sort()).toEqual(['Dark mode please', 'Export to CSV'].sort())
    await unmount()
  })
})

describe('status labels render the plain words, not the raw db values', () => {
  it('offers Fixed / Looking at it / Planned and never the raw status strings', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    expect(chip(host, 'Fixed')).toBeTruthy()
    expect(chip(host, 'Looking at it')).toBeTruthy()
    expect(chip(host, 'Planned')).toBeTruthy()
    const text = host.textContent || ''
    expect(text).not.toContain('under_review')
    expect(text).not.toContain('shipped')
    expect(text).not.toContain('in_progress')
    await unmount()
  })

  it("does NOT offer statuses absent from the data (declined is unused → no chip)", async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    expect(chip(host, 'Not planned')).toBeUndefined() // declined
    expect(chip(host, 'New')).toBeUndefined()          // submitted
    expect(chip(host, 'In progress')).toBeUndefined()  // in_progress
    await unmount()
  })
})

describe('"Just mine" filters by submitter and combines with type + status', () => {
  it('Just mine → only u1 rows; then + Bugs → only u1 bugs', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    // Everyone/Just mine counts are faceted: Everyone 5, Just mine 3.
    expect(chipCount(host, 'Everyone')).toBe(5)
    expect(chipCount(host, 'Just mine')).toBe(3)

    await click(chip(host, 'Just mine')!)
    expect(rowTitles(host).sort()).toEqual(
      ['Login button broken', 'Dark mode please', 'Typo on invoice'].sort()
    )
    // Combine with type: mine + Bugs = i1, i5.
    await click(chip(host, 'Bugs')!)
    expect(rowTitles(host).sort()).toEqual(['Login button broken', 'Typo on invoice'].sort())
    await unmount()
  })

  it('the "Just mine" control hides when the viewer has no stable id (view-as / demo)', async () => {
    stubFetch()
    const { host, unmount } = await mount(
      <CurrentUserContext.Provider value={{ email: 'ghost@biz.com' } as any}>
        <AdminFeedbackScreen onReportFeedback={() => {}} />
      </CurrentUserContext.Provider>
    )
    expect(chip(host, 'Just mine')).toBeUndefined()
    expect(chip(host, 'Everyone')).toBeUndefined()
    // The real axes still render.
    expect(chip(host, 'Bugs')).toBeTruthy()
    await unmount()
  })
})

describe('a zero-result combination says so clearly', () => {
  // The faceted status chips deliberately can't be clicked into an empty list
  // (a zero-count status hides before you can select it). The reachable empty
  // state is a genuine combination — a type plus a search that matches nobody.
  it('Bugs + a search that matches no one → zero rows and an explicit message', async () => {
    stubFetch()
    const { host, unmount } = await mount(screen())
    await click(chip(host, 'Bugs')!)
    expect(rowTitles(host).length).toBe(3)

    const search = host.querySelector('input') as HTMLInputElement
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
