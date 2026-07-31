// @vitest-environment happy-dom
//
// AdminFeedbackScreen — extracted module (issue 128), MOUNT tests.
//
// This file used to source-pin the screen inside BeeHub.jsx because the
// component wasn't its own module. It is now
// components/admin/AdminFeedbackScreen.jsx, so the pins became real mounts —
// that was most of the point of extracting it. What stays source-matched:
//
//   A) TOKEN SWEEP — the extracted file carries NO hex/rgba literal of its
//      own (the AdminNotificationsScreen rule; comments included, so issue
//      numbers are written "issue 128", never with a hash prefix the sweep
//      would read as hex).
//   B) THE THREE MOUNT SITES in BeeHub.jsx — two elevated admin tabs plus
//      the franchise owner mount. Those stay in BeeHub, so the prop shapes
//      each site passes are pinned there, and every shape is then MOUNTED
//      here and asserted on real DOM.
//
// Behavior contract (issue 126 redesign, unchanged by the extraction):
//   - header = light headline + live "N items · M open" subtitle
//   - composer button on the FRANCHISE mount only (onReportFeedback prop)
//   - franchise mount hides the location filter + row-meta location segment;
//     the two elevated mounts show both
//   - hairline rows in one container; closed rows dim; row click opens the
//     triage detail modal whose Save PATCHes /api/admin/feedback/:id
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

import AdminFeedbackScreen from '@/components/admin/AdminFeedbackScreen'
import { CurrentUserContext } from '@/components/hive/shared/currentUserContext'

const SCREEN_SRC = readFileSync('components/admin/AdminFeedbackScreen.jsx', 'utf8')
const BEEHUB_SRC = readFileSync('components/BeeHub.jsx', 'utf8')

// ── fixtures ───────────────────────────────────────────────────────
// Two locations, two submitters, a closed (shipped) row and an attachment —
// enough surface for every mount-context assertion below.
const ITEMS = [
  { id: 'i1', title: 'Login button broken', type: 'bug',     status: 'submitted', user_id: 'u1', submitter_name: 'Amy Owner',   submitter_email: 'amy@biz.com', location_id: 'loc-1', location_name: 'Boulder',  created_at: '2026-07-01T00:00:00Z', attachments: [] },
  { id: 'i2', title: 'Export to CSV',       type: 'feature', status: 'shipped',   user_id: 'u2', submitter_name: 'Bob Manager', submitter_email: 'bob@biz.com', location_id: 'loc-2', location_name: 'Portland', created_at: '2026-07-02T00:00:00Z', attachments: [{ path: 'a/b.png', name: 'b.png', size: 100, type: 'image/png' }] },
  { id: 'i3', title: 'Typo on invoice',     type: 'bug',     status: 'submitted', user_id: 'u1', submitter_name: 'Amy Owner',   submitter_email: 'amy@biz.com', location_id: 'loc-1', location_name: 'Boulder',  created_at: '2026-07-03T00:00:00Z', attachments: [] },
]

const stubFetch = (items = ITEMS) => {
  const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ items }) }))
  vi.stubGlobal('fetch', f)
  return f
}

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => {}) // flush the mount effect's async fetch → setState
  return { host, root, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})

const withUser = (ui: React.ReactElement, user: any = { id: 'u1', email: 'amy@biz.com' }) => (
  <CurrentUserContext.Provider value={user}>{ui}</CurrentUserContext.Provider>
)

// The three REAL prop shapes (pinned against BeeHub source below).
const franchiseProps = { locationId: null as string | null, onReportFeedback: () => {} }
const elevatedProps = { onPendingCountChange: () => {} }

const rowButton = (host: Element, title: string) =>
  [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim().startsWith(title))
const locationSelect = (host: Element) =>
  [...host.querySelectorAll('select')].find(s => (s.textContent || '').includes('All locations'))

beforeEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

// ── A) the token sweep — no literal color in the extracted file ────
describe('token sweep — the extracted screen carries no color literal of its own', () => {
  const HEX = /#[0-9a-fA-F]{3,8}\b/
  const RGBA = /rgba?\(/

  it('no hex/rgba literal anywhere in the file (comments included — reword, don’t cite hexes)', () => {
    expect(HEX.test(SCREEN_SRC)).toBe(false)
    expect(RGBA.test(SCREEN_SRC)).toBe(false)
  })

  it('composes the SHARED primitives rather than re-rolling them', () => {
    expect(SCREEN_SRC).toContain("from '@/components/ui/FilterChips'")
    expect(SCREEN_SRC).toContain("from '@/components/hive/shared/tokens'")
    // The feedback chip anatomy + status maps stay single-homed in
    // feedbackShared (the surface's own StatusChip-equivalent).
    expect(SCREEN_SRC).toContain("from '@/components/feedback/feedbackShared'")
    expect(SCREEN_SRC).toMatch(/T\.ink\./)
    expect(SCREEN_SRC).toMatch(/T\.border\./)
  })
})

// ── B) the three mount sites stay wired in BeeHub ──────────────────
describe('the three BeeHub mount sites pass the shapes mounted in this file', () => {
  it('BeeHub imports the extracted module and defines no local copy', () => {
    expect(BEEHUB_SRC).toContain('import AdminFeedbackScreen from "@/components/admin/AdminFeedbackScreen"')
    expect(BEEHUB_SRC).not.toContain('function AdminFeedbackScreen(')
    expect(BEEHUB_SRC).not.toContain('function AdminFeedbackDetailModal(')
  })

  it('TWO elevated admin mounts: onPendingCountChange only — no composer, no location override', () => {
    const mounts = BEEHUB_SRC.match(/<AdminFeedbackScreen[^/]*\/>/g) || []
    const withPending = mounts.filter(m => m.includes('onPendingCountChange'))
    expect(withPending.length).toBe(2) // SuperAdminLayout tab + legacy AdminScreen tab
    for (const m of withPending) {
      expect(m).not.toContain('onReportFeedback')
      expect(m).not.toContain('locationId')
    }
  })

  it('ONE franchise mount: locationId (view-as parity) + the composer callback', () => {
    expect(BEEHUB_SRC).toContain('locationId={viewAsUser?.locationId || null}')
    expect(BEEHUB_SRC).toContain("onReportFeedback={() => setShowFeedback('submit')}")
  })
})

// ── header ─────────────────────────────────────────────────────────
describe('header — light headline + live count subtitle', () => {
  it('renders "N items · M open" from the real data (open excludes shipped/declined)', async () => {
    stubFetch()
    const { host, unmount } = await mount(withUser(<AdminFeedbackScreen {...franchiseProps} />))
    expect(host.textContent).toContain('3 items · 2 open') // i2 is shipped → closed
    await unmount()
  })
})

// ── mount context 1: franchise owner/manager ───────────────────────
describe('franchise mount (onReportFeedback + locationId)', () => {
  it('shows the composer button, and clicking it fires the callback', async () => {
    stubFetch()
    const onReport = vi.fn()
    const { host, unmount } = await mount(withUser(<AdminFeedbackScreen locationId={null} onReportFeedback={onReport} />))
    const btn = host.querySelector('button[aria-label="Report a bug or share an idea"]')!
    expect(btn).toBeTruthy()
    await click(btn)
    expect(onReport).toHaveBeenCalledTimes(1)
    await unmount()
  })

  it('HIDES the location filter and the row-meta location segment (every row is the caller’s own location)', async () => {
    stubFetch()
    const { host, unmount } = await mount(withUser(<AdminFeedbackScreen {...franchiseProps} />))
    expect(locationSelect(host)).toBeUndefined()
    const row = rowButton(host, 'Login button broken')!
    expect(row.textContent).toContain('Amy Owner')
    expect(row.textContent).not.toContain('Boulder')
    await unmount()
  })

  it('appends ?location_id= to the fetch when a view-as location is passed, plain URL when null', async () => {
    const f = stubFetch()
    const { unmount } = await mount(withUser(<AdminFeedbackScreen locationId="loc-9" onReportFeedback={() => {}} />))
    expect(String(f.mock.calls[0][0])).toBe('/api/admin/feedback?location_id=loc-9')
    await unmount()
    const f2 = stubFetch()
    const { unmount: un2 } = await mount(withUser(<AdminFeedbackScreen {...franchiseProps} />))
    expect(String(f2.mock.calls[0][0])).toBe('/api/admin/feedback')
    await un2()
  })
})

// ── mount contexts 2 + 3: the elevated admin tabs ──────────────────
// Both elevated sites pass the identical shape (pinned above), so one mount
// exercises both — the point is that the shape they pass keeps the location
// filter, keeps the row-meta location, and never grows a composer.
describe('elevated admin mounts (onPendingCountChange only)', () => {
  it('SHOWS the location filter with the locations present in the data', async () => {
    stubFetch()
    const { host, unmount } = await mount(withUser(<AdminFeedbackScreen {...elevatedProps} />))
    const sel = locationSelect(host)!
    expect(sel).toBeTruthy()
    const options = [...sel.querySelectorAll('option')].map(o => o.textContent)
    expect(options).toEqual(['All locations', 'Boulder', 'Portland'])
    await unmount()
  })

  it('row meta carries the location segment; there is NO composer button', async () => {
    stubFetch()
    const { host, unmount } = await mount(withUser(<AdminFeedbackScreen {...elevatedProps} />))
    expect(rowButton(host, 'Login button broken')!.textContent).toContain('Boulder')
    expect(host.querySelector('button[aria-label="Report a bug or share an idea"]')).toBeNull()
    await unmount()
  })

  it('selecting a location narrows the list client-side', async () => {
    stubFetch()
    const { host, unmount } = await mount(withUser(<AdminFeedbackScreen {...elevatedProps} />))
    const sel = locationSelect(host)!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
      setter.call(sel, 'loc-2')
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(rowButton(host, 'Export to CSV')).toBeTruthy()
    expect(rowButton(host, 'Login button broken')).toBeUndefined()
    await unmount()
  })

  it('reports the pending (status=submitted) count for the tab badge', async () => {
    stubFetch()
    const onPending = vi.fn()
    const { unmount } = await mount(withUser(<AdminFeedbackScreen onPendingCountChange={onPending} />))
    expect(onPending).toHaveBeenLastCalledWith(2) // i1 + i3 are 'submitted'
    await unmount()
  })
})

// ── rows + the triage detail modal ─────────────────────────────────
describe('rows and the detail modal', () => {
  it('closed rows (shipped/declined) dim to 0.72; open rows do not', async () => {
    stubFetch()
    const { host, unmount } = await mount(withUser(<AdminFeedbackScreen {...elevatedProps} />))
    expect((rowButton(host, 'Export to CSV') as HTMLElement).style.opacity).toBe('0.72')
    expect((rowButton(host, 'Login button broken') as HTMLElement).style.opacity).toBe('1')
    await unmount()
  })

  it('a row with attachments shows the paperclip count', async () => {
    stubFetch()
    const { host, unmount } = await mount(withUser(<AdminFeedbackScreen {...elevatedProps} />))
    const row = rowButton(host, 'Export to CSV')!
    expect(row.querySelector('svg')).toBeTruthy() // type tile icon + paperclip render
    expect(row.textContent).toContain('1') // attachment count
    await unmount()
  })

  it('clicking a row opens the detail modal; Save PATCHes /api/admin/feedback/:id and updates the list', async () => {
    const f = vi.fn(async (url: any, init?: any) => {
      if (init?.method === 'PATCH') {
        return { ok: true, status: 200, json: async () => ({ id: 'i1', status: 'in_progress', admin_response: 'On it' }) }
      }
      return { ok: true, status: 200, json: async () => ({ items: ITEMS }) }
    })
    vi.stubGlobal('fetch', f)
    const { host, unmount } = await mount(withUser(<AdminFeedbackScreen {...elevatedProps} />))

    await click(rowButton(host, 'Login button broken')!)
    // Modal open: description label + the plain-word status vocabulary in the select.
    expect(host.textContent).toContain('Description')
    const select = [...host.querySelectorAll('select')].find(s => (s.textContent || '').includes('Looking at it'))!
    expect(select).toBeTruthy()
    expect(select.textContent).not.toContain('under_review') // plain words, not db values

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, 'in_progress')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const save = [...host.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Save')!
    await click(save)

    const patch = f.mock.calls.find(c => c[1]?.method === 'PATCH')!
    expect(String(patch[0])).toBe('/api/admin/feedback/i1')
    expect(JSON.parse(patch[1].body)).toEqual({ status: 'in_progress', admin_response: null })
    // onSaved merged the update back into the list and closed the modal.
    expect(host.textContent).not.toContain('Description')
    expect(rowButton(host, 'Login button broken')!.textContent).toContain('In progress')
    await unmount()
  })
})
