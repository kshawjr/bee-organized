// @vitest-environment happy-dom
//
// After-Send engagement poll — the MOUNT-BASELINE guard (issue 155).
//
// jobberLinks lives in BeeHub and outlives this dynamically-imported shell; it
// accumulates a key per confirmed send AND may already carry keys at mount (a
// remount after an earlier send, or server-seeded links). A lead sent long ago
// whose engagement has since CLOSED has a link and NO open engagement — the
// exact shape a fresh send has — so if the "already handled" baseline started
// empty, every such lead would look like a brand-new send and poll 90s finding
// nothing. The fix baselines the handled set to the keys PRESENT AT MOUNT, so
// only keys added AFTER mount ever enqueue. Pins:
//   · a lead in jobberLinks AT MOUNT with no open engagement does NOT poll
//   · a key ADDED AFTER mount (a real send) DOES poll — the baseline doesn't
//     over-suppress
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

import HiveShell from '@/components/hive/HiveShell'

// Count the poll's open-set fetches. The focus/visibility revalidation uses
// the same ?open=1 read, so the test never dispatches those events — the only
// possible open=1 caller here is the send poll.
let openCalls: string[] = []
function installFetch() {
  openCalls = []
  ;(globalThis as any).fetch = vi.fn((url: any) => {
    const u = String(url)
    if (u.includes('/api/lookups')) {
      return Promise.resolve({ ok: true, json: async () => ({ lookups: [] }) })
    }
    if (u.includes('/api/engagements') && u.includes('open=1')) {
      openCalls.push(u)
      return Promise.resolve({ ok: true, json: async () => ({ rows: [], total: 0 }) })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

const flush = async () => { await act(async () => { await Promise.resolve() }) }

let container: HTMLDivElement
let root: Root

async function render(props: any) {
  await act(async () => { root.render(React.createElement(HiveShell, props)) })
  await flush()
}

beforeEach(() => {
  // Fake ONLY setTimeout/clearTimeout so we can fire the poll's 3s delay
  // without a real wait; React 18's scheduler uses MessageChannel, so leaving
  // everything else real keeps mount/act intact.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  installFetch()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  container?.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('mount-baseline guard', () => {
  it('a lead present in jobberLinks AT MOUNT with a closed (no open) engagement does NOT enqueue', async () => {
    // c1: sent long ago, engagement since closed → NOT in the open engagements
    // prop, but its jobberLink persists.
    await render({ engagements: [], jobberLinks: { c1: { jobber_client_id: 'jc1' } } })
    // Advance well past the first poll delay AND the whole 90s cap — a stranded
    // enqueue would have fetched by now.
    await act(async () => { await vi.advanceTimersByTimeAsync(95_000) })
    await flush()
    expect(openCalls.length).toBe(0)
  })

  it('a key ADDED AFTER mount (a real send) DOES enqueue and poll', async () => {
    // Mount with c1 already linked (baselined, must stay quiet)…
    await render({ engagements: [], jobberLinks: { c1: { jobber_client_id: 'jc1' } } })
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    await flush()
    expect(openCalls.length).toBe(0)   // c1 alone never polls

    // …then a fresh send adds c2 after mount.
    await render({ engagements: [], jobberLinks: { c1: { jobber_client_id: 'jc1' }, c2: { jobber_client_id: 'jc2' } } })
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    await flush()
    // The only new, un-baselined key is c2 → the poll fires for it.
    expect(openCalls.length).toBeGreaterThanOrEqual(1)
    expect(openCalls[0]).toContain('open=1')
  })
})
