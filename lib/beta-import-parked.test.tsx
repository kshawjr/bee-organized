// @vitest-environment happy-dom
//
// Sample-now / bulk-later — the UI half of the gap state.
//
// What is pinned:
//   • SAMPLE TRIGGER — the onboarding step POSTs mode=sample only above
//     SAMPLE_MODE_MIN_CLIENTS; small or UNKNOWN counts POST plain (normal
//     import unchanged — never sample on a guess).
//   • PARKED RENDER — a parked job renders the explicit "sample imported,
//     rest overnight" panel: no progress bar, no Cancel, no frozen
//     "75 of 3,352". The owner can complete the step and move on.
//   • LEAK 3b — while parked, the poller never re-POSTs the import route
//     (an open tab must not launch the bulk run mid-day).
//   • GAP BANNER — parked → "rest arrives overnight" on Home/Clients via
//     /api/import/active (skip_count=1, no Jobber round-trip); completed
//     overnight → dismissible success, dismissal persisted per job id.
//   • SETTINGS CARD — a parked job renders the gap text, not a running
//     spinner with a Cancel.
// Same happy-dom + createRoot + substring-routed fetch pattern as
// beta-import-estimate.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

import { parkedPhase } from '@/lib/import-phase'
import { SAMPLE_MODE_MIN_CLIENTS } from '@/lib/import-estimate'
import { ImportStepContent, ClientImportCard, ImportGapBanner, CurrentUserContext } from '@/components/BeeHub'

const PARKED_JOB = {
  id: 'job-p1',
  status: 'running',
  phase: parkedPhase(75, 3352),
  processed_records: 75,
  total_records: 3352,
  resume_after: new Date(Date.now() + 6 * 3600_000).toISOString(),
}

// ── fetch mock: substring-routed dispatcher ─────────────────────────
const fetchMock = vi.fn()
const jsonRes = (body: any, ok = true, status = 200) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
const routeFetch = (routes: Record<string, any>) =>
  fetchMock.mockImplementation((url: any) => {
    const u = String(url)
    for (const key of Object.keys(routes)) {
      if (u.includes(key)) return jsonRes(routes[key])
    }
    return jsonRes({ error: 'unmocked_route' }, false, 404)
  })

// happy-dom v20 ships no localStorage — stub one (same pattern as
// network-saved-views) so the banner's dismissal persistence is assertable.
const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

beforeEach(() => {
  fetchMock.mockReset()
  ;(globalThis as any).fetch = fetchMock
  vi.stubGlobal('localStorage', lsMock)
  lsStore.clear()
})

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  await act(async () => {}) // flush the mount effect's async fetch → setState
  // Flush the poller chain (setTimeout(tick, 0) → status fetch → setState).
  await act(async () => { await new Promise((r) => setTimeout(r, 5)) })
  await act(async () => {})
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

const click = (el: Element) => act(async () => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
})

const buttonByText = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text)

const importPosts = () =>
  fetchMock.mock.calls.filter(([u, o]: any[]) => String(u).includes('jobber-clients') && o?.method === 'POST')

const onboarding = (over: { markDone?: (id: string) => void } = {}) => (
  <CurrentUserContext.Provider value={{ locationId: 'loc-1' } as any}>
    <ImportStepContent markDone={over.markDone || (() => {})} setActiveStepOpen={() => {}} />
  </CurrentUserContext.Provider>
)

describe('sample trigger — mode=sample only above the threshold', () => {
  it(`POSTs mode=sample when the book exceeds ${SAMPLE_MODE_MIN_CLIENTS}`, async () => {
    routeFetch({ 'import/active': { job: null, client_count: 3352 }, 'jobber-clients': { job_id: 'j1', started: true }, 'import/status': { id: 'j1', status: 'running', phase: 'starting' } })
    const { host, unmount } = await mount(onboarding())
    await click(buttonByText(host, 'Start Import')!)
    const posts = importPosts()
    expect(posts).toHaveLength(1)
    expect(String(posts[0][0])).toContain('mode=sample')
    await unmount()
  })

  it('NORMAL UNCHANGED: a small book POSTs plain — no mode param', async () => {
    routeFetch({ 'import/active': { job: null, client_count: 120 }, 'jobber-clients': { job_id: 'j1', started: true }, 'import/status': { id: 'j1', status: 'running', phase: 'starting' } })
    const { host, unmount } = await mount(onboarding())
    await click(buttonByText(host, 'Start Import')!)
    expect(String(importPosts()[0][0])).not.toContain('mode=')
    await unmount()
  })

  it('NORMAL UNCHANGED: an unknown count POSTs plain — never sample on a guess', async () => {
    routeFetch({ 'import/active': { job: null, client_count: null }, 'jobber-clients': { job_id: 'j1', started: true }, 'import/status': { id: 'j1', status: 'running', phase: 'starting' } })
    const { host, unmount } = await mount(onboarding())
    await click(buttonByText(host, 'Start Import')!)
    expect(String(importPosts()[0][0])).not.toContain('mode=')
    await unmount()
  })
})

describe('parked render — onboarding step (the gap state, not a frozen bar)', () => {
  const mountParked = async (markDone?: (id: string) => void) => {
    routeFetch({ 'import/active': { job: PARKED_JOB, client_count: null }, 'import/status': PARKED_JOB })
    return mount(onboarding({ markDone }))
  }

  it('renders the explicit message with both counts, no progress bar, no Cancel', async () => {
    const { host, unmount } = await mountParked()
    expect(host.textContent).toContain('Sample imported')
    expect(host.textContent).toContain('75')
    expect(host.textContent).toContain('3,277')            // remaining, not the frozen total
    expect(host.textContent).toContain('overnight')
    expect(host.textContent).toContain('Nothing is lost')
    expect(buttonByText(host, 'Cancel import')).toBeUndefined()
    expect(host.textContent).not.toContain('75 of 3,352')  // the frozen-bar reading
    expect(host.textContent).not.toContain('%')
    await unmount()
  })

  it('the owner can complete the step and continue the checklist', async () => {
    const markDone = vi.fn()
    const { host, unmount } = await mountParked(markDone)
    await click(buttonByText(host, '✓ Complete Step')!)
    expect(markDone).toHaveBeenCalledWith('import')
    await unmount()
  })

  it('LEAK 3b: no auto-continue re-POST fires while parked', async () => {
    const { unmount } = await mountParked()
    // Extra flush rounds — any scheduled poller tick would have re-POSTed.
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(importPosts()).toHaveLength(0)
    await unmount()
  })
})

describe('ImportGapBanner — Home/Clients gap surface', () => {
  it('parked → the "rest arrives overnight" banner, via skip_count=1 (no Jobber round-trip)', async () => {
    routeFetch({ 'import/active': { job: PARKED_JOB } })
    const { host, unmount } = await mount(<ImportGapBanner locationId="loc-1" />)
    expect(host.textContent).toContain('75')
    expect(host.textContent).toContain('overnight')
    expect(host.textContent).toContain('nothing is lost')
    const activeCalls = fetchMock.mock.calls.filter(([u]: any[]) => String(u).includes('import/active'))
    expect(activeCalls.length).toBeGreaterThan(0)
    expect(String(activeCalls[0][0])).toContain('skip_count=1')
    await unmount()
  })

  it('overnight completion → success banner; dismiss persists per job id', async () => {
    routeFetch({ 'import/active': { job: null, recent_deferred: { id: 'job-p1', processed_records: 3352, total_records: 3352, completed_at: new Date().toISOString() } } })
    const { host, unmount } = await mount(<ImportGapBanner locationId="loc-1" />)
    expect(host.textContent).toContain('All 3,352 clients imported overnight')
    const dismiss = host.querySelector('button[aria-label="Dismiss"]')!
    await click(dismiss)
    expect(host.textContent).not.toContain('imported overnight')
    expect(localStorage.getItem('bee.importGapBanner.dismissed.job-p1')).toBe('1')
    await unmount()
  })

  it('already-dismissed completion renders nothing', async () => {
    localStorage.setItem('bee.importGapBanner.dismissed.job-p1', '1')
    routeFetch({ 'import/active': { job: null, recent_deferred: { id: 'job-p1', processed_records: 3352 } } })
    const { host, unmount } = await mount(<ImportGapBanner locationId="loc-1" />)
    expect(host.textContent).toBe('')
    await unmount()
  })

  it('no job, no recent completion, or no locationId → renders nothing', async () => {
    routeFetch({ 'import/active': { job: null, recent_deferred: null } })
    const a = await mount(<ImportGapBanner locationId="loc-1" />)
    expect(a.host.textContent).toBe('')
    await a.unmount()
    const b = await mount(<ImportGapBanner locationId={null as any} />)
    expect(b.host.textContent).toBe('')
    expect(fetchMock.mock.calls.filter(([u]: any[]) => String(u).includes('import/active'))).toHaveLength(1)
    await b.unmount()
  })

  it('a live NON-parked import renders nothing — the import UIs own that state', async () => {
    routeFetch({ 'import/active': { job: { ...PARKED_JOB, phase: 'writing' } } })
    const { host, unmount } = await mount(<ImportGapBanner locationId="loc-1" />)
    expect(host.textContent).toBe('')
    await unmount()
  })
})

describe('Settings ClientImportCard — parked state', () => {
  it('a parked job renders the gap text, not a running spinner with Cancel', async () => {
    routeFetch({ 'import/active': { job: PARKED_JOB, client_count: null } })
    const { host, unmount } = await mount(
      <ClientImportCard isJobberConnected locationId="loc-1" initialImportCompletedAt={null} />,
    )
    expect(host.textContent).toContain('starter set')
    expect(host.textContent).toContain('overnight')
    expect(buttonByText(host, 'Cancel import')).toBeUndefined()
    expect(importPosts()).toHaveLength(0)   // no auto-continue from Settings either
    await unmount()
  })
})
