// @vitest-environment happy-dom
//
// Saved views on the Contacts/Network tab PERSIST (Network Phase 1 bug
// fix). They were plain useState — save a view, reload, gone. Now they
// live in localStorage via the shared SSR-safe useStoredState hook
// (bee_network_saved_views: { views, activeViewId }).
//
// Mount tests (per the allOverview lesson), not source pins:
//   A) a stored view renders as a pill on a FRESH mount — the reload case
//   B) applying a view persists activeViewId (write-through)
//   C) full unmount → remount keeps the pill — the literal reload shape
//   D) deleting the view persists the removal
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// BeeHub's module graph touches next/navigation at render time.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))

import { PartnersScreen } from '@/components/BeeHub'

// happy-dom v20 ships no localStorage — stub one so useStoredState's
// hydration + write-through paths run for real (the established
// beta-closed-terminal pattern).
const lsStore = new Map<string, string>()
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

const KEY = 'bee_network_saved_views'
const STORED_VIEW = {
  views: [{ id: 'v1', name: 'Hot Realtors', filters: { stageFilter: 'Active Partner', tierFilter: '', specFilter: '', tagFilter: '' } }],
  activeViewId: null,
}

let host: HTMLDivElement
let root: Root

const mount = async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <PartnersScreen
        onNavigate={() => {}}
        partners={[]}
        setPartners={() => {}}
        companies={[]}
      />
    )
  })
}

const unmount = async () => {
  if (root) await act(async () => root.unmount())
  host?.remove()
}

const pillByText = (text: string) =>
  Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === text)

beforeEach(() => {
  vi.stubGlobal('localStorage', lsMock)
  lsStore.clear()
})
afterEach(async () => {
  await unmount()
  lsStore.clear()
  vi.unstubAllGlobals()
})

describe('saved views survive a reload', () => {
  it('A) a stored view renders on a fresh mount', async () => {
    localStorage.setItem(KEY, JSON.stringify(STORED_VIEW))
    await mount()
    expect(pillByText('Hot Realtors')).toBeTruthy()
  })

  it('B) applying a view writes activeViewId through to storage', async () => {
    localStorage.setItem(KEY, JSON.stringify(STORED_VIEW))
    await mount()
    await act(async () => { pillByText('Hot Realtors')!.click() })
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}')
    expect(stored.activeViewId).toBe('v1')
    expect(stored.views).toHaveLength(1)
  })

  it('C) unmount → fresh remount keeps the pill (the literal reload shape)', async () => {
    localStorage.setItem(KEY, JSON.stringify(STORED_VIEW))
    await mount()
    expect(pillByText('Hot Realtors')).toBeTruthy()
    await unmount()
    await mount()
    expect(pillByText('Hot Realtors')).toBeTruthy()
  })

  it('D) deleting a view persists the removal', async () => {
    localStorage.setItem(KEY, JSON.stringify({ ...STORED_VIEW, activeViewId: 'v1' }))
    await mount()
    const pill = pillByText('Hot Realtors')!
    // The delete × sits beside the name button inside the pill wrapper.
    const del = pill.parentElement!.querySelectorAll('button')[1] as HTMLButtonElement
    await act(async () => { del.click() })
    const stored = JSON.parse(localStorage.getItem(KEY) || '{}')
    expect(stored.views).toEqual([])
    expect(stored.activeViewId).toBe(null)
    await unmount()
    await mount()
    expect(pillByText('Hot Realtors')).toBeFalsy()
  })
})
