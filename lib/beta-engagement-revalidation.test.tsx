// @vitest-environment happy-dom
//
// Board engagement REVALIDATION — the component wiring on top of the pure
// merge (engagementRevalidate.js, unit-tested in beta-engagement-revalidate).
// Working-stage advances land server-side with no client event and the
// board set is fetched once at page load, so this closes the manual-reload
// gap. Pins:
//   · a focus event triggers a refetch of the open set (?open=1)
//   · a visibilitychange→visible triggers a refetch too
//   · a server-side stage move present in the refetch moves the card to the
//     new column via the merge — no reload
//   · the debounce guard collapses a burst of focus events into one fetch
//   · the in-flight guard blocks a second fetch while one is outstanding
//   · focus/visibility listeners are removed on unmount (no leak / no fetch)
//   · EngagementBoard drag-close hands the terminal stage UP via onChanged
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
// Desktop width so the board renders every column (data-board-col) and is
// draggable — useIsMobile reads this seam (see useIsMobile.js).
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

import HiveShell from '@/components/hive/HiveShell'
import EngagementBoard from '@/components/hive/EngagementBoard'
import { CLOSED_LOST } from '@/components/hive/shared/stageConfig'

// The board's drag-close renders CloseEngagementConfirm (the real one does a
// PATCH). Stub it to a single button that fires onClosed with the preselected
// terminal stage — we're pinning the hand-up, not the write path.
vi.mock('@/components/hive/shared/CloseEngagementConfirm', () => ({
  default: (props: any) =>
    React.createElement('button', {
      'data-testid': 'commit-close',
      onClick: () => props.onClosed(props.initialCloseAs),
    }, 'commit'),
}))

const ENG = (over: any = {}) => ({
  id: 'e1', client_id: 'c1', client_name: 'Acme Co', stage: 'Request',
  title: 'Kitchen declutter', created_at: '2026-07-01T00:00:00Z',
  location_uuid: 'loc-1', repeat_count: 1,
  quotes: [], jobs: [], invoices: [], assessments: [], service_requests: [],
  ...over,
})

// ── fetch harness ─────────────────────────────────────────────────
let openRows: any[] = []
let openCalls: string[] = []
let openResolvers: Array<(v: any) => void> = []
let holdOpen = false // when true, /open fetches hang until released

function installFetch() {
  openCalls = []
  openResolvers = []
  holdOpen = false
  ;(globalThis as any).fetch = vi.fn((url: any) => {
    const u = String(url)
    if (u.includes('/api/lookups')) {
      return Promise.resolve({ ok: true, json: async () => ({ lookups: [] }) })
    }
    if (u.includes('/api/engagements') && u.includes('open=1')) {
      openCalls.push(u)
      const payload = { ok: true, json: async () => ({ rows: openRows, total: openRows.length }) }
      if (holdOpen) return new Promise(res => { openResolvers.push(() => res(payload)) })
      return Promise.resolve(payload)
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

const flush = async () => { await act(async () => { await Promise.resolve() }) }

let container: HTMLDivElement
let root: Root

async function mountShell(engagements: any[]) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(React.createElement(HiveShell, { engagements }))
  })
  await flush()
}

beforeEach(() => { installFetch() })
afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  container?.remove()
  vi.restoreAllMocks()
})

const colText = (stageKey: string) =>
  container.querySelector(`[data-board-col="${stageKey}"]`)?.textContent || ''

describe('focus / visibility trigger', () => {
  it('a window focus event refetches the open set', async () => {
    openRows = [ENG()]
    await mountShell([ENG()])
    expect(openCalls.length).toBe(0)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(openCalls.length).toBe(1)
    expect(openCalls[0]).toContain('open=1')
  })

  it('a visibilitychange→visible event refetches the open set', async () => {
    openRows = [ENG()]
    await mountShell([ENG()])
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(openCalls.length).toBe(1)
  })
})

describe('server stage move lands without reload', () => {
  it('moves the card from Request to Estimate via the merge', async () => {
    openRows = [ENG({ stage: 'Estimate', quotes: [{ id: 'q1', status: 'sent', total: 900, sent_at: '2026-07-05T00:00:00Z', approved_at: null }] })]
    await mountShell([ENG({ stage: 'Request' })])

    // Before revalidation: card sits in Request.
    expect(colText('Request')).toContain('Acme Co')
    expect(colText('Estimate')).not.toContain('Acme Co')

    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await flush()
    await flush()

    // After: the server move re-columns the card, no reload.
    expect(colText('Estimate')).toContain('Acme Co')
    expect(colText('Request')).not.toContain('Acme Co')
  })
})

describe('guards', () => {
  it('debounce collapses a burst of focus events into ONE fetch', async () => {
    openRows = [ENG()]
    await mountShell([ENG()])
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
    })
    await flush()
    expect(openCalls.length).toBe(1)
  })

  it('in-flight guard blocks a second fetch while one is outstanding', async () => {
    openRows = [ENG()]
    holdOpen = true
    await mountShell([ENG()])
    // First focus starts a fetch that hangs (holdOpen).
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(openCalls.length).toBe(1)
    // Advance the clock past the debounce window so only the in-flight guard
    // can be responsible for suppressing the second fetch.
    const realNow = Date.now
    vi.spyOn(Date, 'now').mockReturnValue(realNow() + 10_000)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(openCalls.length).toBe(1) // still one — blocked while in flight
    // Release the first; a later focus is now free to fetch.
    await act(async () => { openResolvers.forEach(r => r()); await Promise.resolve() })
    await flush()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(openCalls.length).toBe(2)
  })
})

describe('cleanup', () => {
  it('removes focus/visibility listeners on unmount (no fetch after)', async () => {
    openRows = [ENG()]
    await mountShell([ENG()])
    await act(async () => { root.unmount() })
    ;(root as any) = null
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()
    expect(openCalls.length).toBe(0)
  })
})

describe('EngagementBoard drag-close hand-up', () => {
  it('confirmed drag-close fires onChanged(id, { stage: terminal })', async () => {
    const onChanged = vi.fn()
    const c = document.createElement('div')
    document.body.appendChild(c)
    let r: Root
    await act(async () => {
      r = createRoot(c)
      r.render(React.createElement(EngagementBoard, {
        engagements: [ENG({ stage: 'Request' })],
        onChanged,
      }))
    })
    await flush()

    // Start dragging the card → close drop zones appear.
    const card = c.querySelector('[draggable="true"]') as HTMLElement
    expect(card).toBeTruthy()
    await act(async () => { card.dispatchEvent(new Event('dragstart', { bubbles: true })) })
    await flush()

    // Drop on the "Close as lost" zone → pending close + confirm popup.
    const lostZone = c.querySelector('[aria-label="Close as lost"]') as HTMLElement
    expect(lostZone).toBeTruthy()
    await act(async () => {
      const ev = new Event('drop', { bubbles: true }) as any
      ev.preventDefault = () => {}
      lostZone.dispatchEvent(ev)
    })
    await flush()

    // Confirm → the stubbed CloseEngagementConfirm fires onClosed(CLOSED_LOST).
    const commit = c.querySelector('[data-testid="commit-close"]') as HTMLElement
    expect(commit).toBeTruthy()
    await act(async () => { commit.dispatchEvent(new Event('click', { bubbles: true })) })
    await flush()

    expect(onChanged).toHaveBeenCalledWith('e1', { stage: CLOSED_LOST })
    await act(async () => { r.unmount() })
    c.remove()
  })
})
