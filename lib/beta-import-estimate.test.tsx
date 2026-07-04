// @vitest-environment happy-dom
// Pre-flight import time estimate on the Jobber import prompts.
// Pins three things:
//   1. Range math + copy (lib/import-estimate): 1600 → "10–20 minutes",
//      430 → "3–7 minutes", <200 → "a few minutes", unknown → static
//      fallback. Brackets err generous — over-delivering beats a broken-
//      feeling overrun.
//   2. Count unavailable (client_count null OR the whole /api/import/active
//      fetch failing) → the static line renders and Start Import still
//      works. A failed count must never block importing.
//   3. Both pre-start surfaces show the line: onboarding ImportStepContent
//      idle branch, Settings ClientImportCard idle + skipped states.
// Real DOM (mount effects fetch /api/import/active), hence happy-dom +
// createRoot, same pattern as beta-overlay-close.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ClientImportCard calls useRouter().refresh() on completion; outside a
// Next app-router tree the real hook throws at render.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

import { importEstimateLine, importEstimateRange, SEC_PER_CLIENT } from '@/lib/import-estimate'
import { ImportStepContent, ClientImportCard, CurrentUserContext } from '@/components/BeeHub'

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

beforeEach(() => {
  fetchMock.mockReset()
  ;(globalThis as any).fetch = fetchMock
})

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

const buttonByText = (host: Element, text: string) =>
  [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text)

const onboarding = () => (
  <CurrentUserContext.Provider value={{ locationId: 'loc-1' } as any}>
    <ImportStepContent markDone={() => {}} setActiveStepOpen={() => {}} />
  </CurrentUserContext.Provider>
)

// ── 1. range math + copy ────────────────────────────────────────────
describe('importEstimateLine / importEstimateRange', () => {
  it('1600 clients → about 10–20 minutes (floor 0.8×, ceil 1.5×, nice rungs)', () => {
    expect(importEstimateRange(1600)).toEqual({ floor: 10, ceil: 20 })
    expect(importEstimateLine(1600)).toBe(
      'You have about 1,600 clients — importing takes about 10–20 minutes. You can do this now or come back to it later.'
    )
  })

  it('430 clients → about 3–7 minutes', () => {
    expect(importEstimateRange(430)).toEqual({ floor: 3, ceil: 7 })
    expect(importEstimateLine(430)).toContain('about 430 clients')
    expect(importEstimateLine(430)).toContain('about 3–7 minutes')
  })

  it('real-count cliff guard: 1,616 stays "10–20", not "10–30"', () => {
    // 1616 × 0.5s = 13.47min; ×1.5 = 20.2 — a hair over the 20 rung must
    // snap down, not jump to 30. Count display also rounds to "1,600".
    expect(importEstimateRange(1616)).toEqual({ floor: 10, ceil: 20 })
    expect(importEstimateLine(1616)).toContain('about 1,600 clients')
  })

  it('under ~200 clients → "a few minutes", no numeric range', () => {
    const line = importEstimateLine(150)
    expect(line).toContain('about 150 clients')
    expect(line).toContain('importing takes a few minutes')
    expect(line).not.toMatch(/\d+–\d+ minutes/)
  })

  it('unknown count → static fallback, for every unusable input', () => {
    const fallback = 'Importing usually takes 5–20 minutes, depending on how many clients you have.'
    for (const bad of [null, undefined, 0, -5, NaN]) {
      expect(importEstimateLine(bad as any)).toBe(fallback)
    }
  })

  it('estimates never run under: ceil ≥ the raw point estimate', () => {
    // The point of the padded range — an import finishing early is good,
    // one running past the ceiling feels broken.
    for (const n of [200, 430, 800, 1600, 1616, 3000, 5000]) {
      const minutes = (n * SEC_PER_CLIENT) / 60
      const { floor, ceil } = importEstimateRange(n)
      expect(ceil).toBeGreaterThanOrEqual(Math.floor(minutes))
      expect(floor).toBeLessThan(ceil)
    }
  })
})

// ── 2 + 3. surfaces: onboarding ─────────────────────────────────────
describe('ImportStepContent (onboarding) pre-start estimate', () => {
  it('shows count + range from /api/import/active client_count', async () => {
    routeFetch({ '/api/import/active': { job: null, client_count: 1616 } })
    const { host, unmount } = await mount(onboarding())
    expect(host.textContent).toContain('You have about 1,600 clients')
    expect(host.textContent).toContain('about 10–20 minutes')
    expect(host.textContent).toContain('now or come back to it later')
    expect(buttonByText(host, 'Start Import')).toBeTruthy()
    await unmount()
  })

  it('client_count null → static fallback, Start Import still functional', async () => {
    routeFetch({
      '/api/import/active': { job: null, client_count: null },
      '/api/import/jobber-clients': { job_id: 'job-1', started: true },
      '/api/import/status/': { status: 'running', phase: 'starting', processed_records: 0, total_records: 0 },
    })
    const { host, unmount } = await mount(onboarding())
    expect(host.textContent).toContain('Importing usually takes 5–20 minutes')

    const start = buttonByText(host, 'Start Import')
    expect(start).toBeTruthy()
    await click(start!)
    // Import kicked off despite the missing count: POST fired, no throw,
    // UI moved into the running state.
    const posted = fetchMock.mock.calls.some(([u]) => String(u).includes('/api/import/jobber-clients'))
    expect(posted).toBe(true)
    expect(buttonByText(host, 'Start Import')).toBeFalsy()
    await unmount()
  })

  it('the whole /api/import/active fetch failing → fallback line, prompt intact', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const { host, unmount } = await mount(onboarding())
    expect(host.textContent).toContain('Importing usually takes 5–20 minutes')
    expect(buttonByText(host, 'Start Import')).toBeTruthy()
    await unmount()
  })
})

// ── 2 + 3. surfaces: Settings card ──────────────────────────────────
describe('ClientImportCard (Settings) pre-start estimate', () => {
  const card = () => (
    <ClientImportCard isJobberConnected locationId="loc-1" initialImportCompletedAt={null as any} />
  )

  it('idle subtitle carries count + range; skipped state keeps the line', async () => {
    routeFetch({ '/api/import/active': { job: null, client_count: 430 } })
    const { host, unmount } = await mount(card())
    expect(host.textContent).toContain('You have about 430 clients')
    expect(host.textContent).toContain('about 3–7 minutes')

    // Collapse to the skipped state — the now-or-later line stays put.
    await click(buttonByText(host, 'Skip')!)
    expect(host.textContent).toContain('tap to import when ready')
    expect(host.textContent).toContain('about 3–7 minutes')
    expect(buttonByText(host, 'Import Now')).toBeTruthy()
    await unmount()
  })

  it('client_count null → static fallback in the idle subtitle', async () => {
    routeFetch({ '/api/import/active': { job: null, client_count: null } })
    const { host, unmount } = await mount(card())
    expect(host.textContent).toContain('Importing usually takes 5–20 minutes')
    expect(host.textContent).toContain('Import Clients from Jobber')
    await unmount()
  })
})
