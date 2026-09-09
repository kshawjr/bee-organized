// @vitest-environment happy-dom
// ─────────────────────────────────────────────────────────────
// useStoredState hydration — Ankur (Palm Beach), "the A-Z sort is not
// permanent". Filed twice, from two pages, because the sort survived only
// when he happened to reload while sitting on the board.
//
// The hook flipped its `hydrated` REF at the end of the hydrate effect.
// Effects run in declaration order within ONE commit, so the write-through
// effect saw the flag already true while `value` was still the FIRST
// render's default — and wrote that default to localStorage BEFORE the
// hydrated value landed. The re-render put the real value back, so it
// self-healed and looked fine. It does not self-heal when the consumer
// unmounts in between, and HiveShell guarantees that: `lens` starts at
// 'engagements' and hydrates post-mount, so any load landing on Client
// List or Inbox mounts EngagementBoard, clobbers bee_hive_board_sort to
// the default, and unmounts it.
//
// Tested AT THE HOOK so every consumer is covered — bee_hive_board_sort,
// bee_hive_inbox_sort, bee_hive_list_filters, bee_hive_clients_collapsed,
// bee_network_saved_views — plus one end-to-end pass through the real
// HiveShell, which is what actually proves Ankur's bug is dead.
//
// The assertion that catches this is the SEQUENCE of writes, not the final
// value: the final value was always right.
// ─────────────────────────────────────────────────────────────
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import HiveShell from '@/components/hive/HiveShell'
// @ts-ignore — .js hook, no types
import { useStoredState } from '@/components/hive/shared/useStoredControls'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

// happy-dom v20 ships no localStorage. Stub one that RECORDS the order of
// writes — the ordering is the whole defect.
const lsStore = new Map<string, string>()
let writes: Array<[string, string]> = []
let removals: string[] = []
const lsMock = {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { writes.push([k, String(v)]); lsStore.set(k, String(v)) },
  removeItem: (k: string) => { removals.push(k); lsStore.delete(k) },
  clear: () => { lsStore.clear() },
}

beforeEach(() => {
  vi.stubGlobal('localStorage', lsMock)
  lsStore.clear(); writes = []; removals = []
})
afterEach(() => { vi.unstubAllGlobals(); lsStore.clear() })

const mount = async (ui: React.ReactElement) => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return {
    host,
    rerender: async (n: React.ReactElement) => { await act(async () => { root.render(n) }) },
    unmount: async () => { await act(async () => root.unmount()); host.remove() },
  }
}

const writesTo = (key: string) => writes.filter(([k]) => k === key).map(([, v]) => v)

const SORT_KEY = 'bee_hive_board_sort'
const SORT_DEFAULT = { key: 'newest' }

function Sort({ storeKey = SORT_KEY }: { storeKey?: string }) {
  const [v] = useStoredState(storeKey, SORT_DEFAULT)
  return <span data-testid="sort">{(v as any).key}</span>
}
const sortText = (host: Element) => host.querySelector('[data-testid=sort]')?.textContent

// ── 1) the write sequence on mount ──────────────────────────────
describe('mount with a stored value', () => {
  it('writes ONLY the stored value — never the default first', async () => {
    lsStore.set(SORT_KEY, JSON.stringify({ key: 'client' }))
    writes = []
    const { host, unmount } = await mount(<Sort />)

    // The defect wrote ['{"key":"newest"}', '{"key":"client"}'] here.
    expect(writesTo(SORT_KEY)).not.toContain(JSON.stringify(SORT_DEFAULT))
    expect(writesTo(SORT_KEY).every(v => v === JSON.stringify({ key: 'client' }))).toBe(true)
    expect(sortText(host)).toBe('client')
    await unmount()
  })

  it('renders the stored value, not the default', async () => {
    lsStore.set(SORT_KEY, JSON.stringify({ key: 'value_desc' }))
    const { host, unmount } = await mount(<Sort />)
    expect(sortText(host)).toBe('value_desc')
    await unmount()
  })
})

// ── 2) THE REGRESSION TEST — fails on the shipped code ──────────
describe('mount then unmount before the hydrated value lands', () => {
  // Mirrors HiveShell exactly: the lens starts at 'engagements' (mounting
  // the board) and hydrates from localStorage post-mount, unmounting it.
  function LensShell() {
    const [lens, setLens] = useState('engagements')
    useEffect(() => { setLens(localStorage.getItem('lens') || 'engagements') }, [])
    return lens === 'engagements' ? <Sort /> : <div>client list</div>
  }

  it('leaves the stored sort intact when the consumer is unmounted by lens hydration', async () => {
    lsStore.set(SORT_KEY, JSON.stringify({ key: 'client' }))
    lsStore.set('lens', 'clients')
    const { unmount } = await mount(<LensShell />)
    // The defect left {"key":"newest"} here, permanently.
    expect(lsStore.get(SORT_KEY)).toBe(JSON.stringify({ key: 'client' }))
    await unmount()
  })

  it('leaves the stored sort intact on a bare mount/unmount in one commit', async () => {
    lsStore.set(SORT_KEY, JSON.stringify({ key: 'oldest' }))
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<Sort />); root.unmount() })
    expect(lsStore.get(SORT_KEY)).toBe(JSON.stringify({ key: 'oldest' }))
    host.remove()
  })
})

// ── 3) no stored value ──────────────────────────────────────────
describe('no stored value', () => {
  it('renders the default and writes nothing but the default', async () => {
    const { host, unmount } = await mount(<Sort />)
    expect(sortText(host)).toBe('newest')
    // Pre-existing behaviour, deliberately preserved: the hook seeds the
    // key with its defaults. What matters is that it is the ONLY write and
    // that nothing else was touched.
    expect(writesTo(SORT_KEY)).toEqual([JSON.stringify(SORT_DEFAULT)])
    expect(writes.map(([k]) => k)).toEqual([SORT_KEY])
    expect(removals).toEqual([])
    await unmount()
  })
})

// ── 4) garbage stored values ────────────────────────────────────
describe('a stored value that is no longer usable', () => {
  const garbage: Array<[string, string]> = [
    ['unparseable json', '{not json at all'],
    ['a bare string', '"client"'],
    ['a number', '42'],
    ['null', 'null'],
    ['an array', '[1,2,3]'],
    ['an empty string', ''],
  ]

  for (const [label, raw] of garbage) {
    it(`falls back to the default without throwing — ${label}`, async () => {
      lsStore.set(SORT_KEY, raw)
      const { host, unmount } = await mount(<Sort />)
      expect(sortText(host)).toBe('newest')
      await unmount()
    })
  }

  it('a partial object keeps the missing defaults', async () => {
    lsStore.set(SORT_KEY, JSON.stringify({ unrelated: true }))
    const { host, unmount } = await mount(<Sort />)
    expect(sortText(host)).toBe('newest')
    await unmount()
  })
})

// ── 5) the collapsed-groups state still works ───────────────────
describe('collapsed-groups state (shares the bee_hive_clients_ prefix)', () => {
  const COLLAPSED_KEY = 'bee_hive_clients_collapsed'

  function Bands() {
    const [map, setMap] = useStoredState(COLLAPSED_KEY, {})
    return (
      <button data-testid="band" onClick={() => setMap((p: any) => ({ ...p, New: !p.New }))}>
        {JSON.stringify(map)}
      </button>
    )
  }

  it('hydrates an expanded band and does not clobber it on mount', async () => {
    lsStore.set(COLLAPSED_KEY, JSON.stringify({ New: true }))
    writes = []
    const { host, unmount } = await mount(<Bands />)
    expect(host.querySelector('[data-testid=band]')?.textContent).toBe(JSON.stringify({ New: true }))
    expect(writesTo(COLLAPSED_KEY)).not.toContain('{}')
    expect(JSON.parse(lsStore.get(COLLAPSED_KEY) || '{}')).toMatchObject({ New: true })
    await unmount()
  })

  it('a toggle still persists', async () => {
    const { host, unmount } = await mount(<Bands />)
    const btn = host.querySelector('[data-testid=band]') as HTMLElement
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(JSON.parse(lsStore.get(COLLAPSED_KEY) || '{}')).toMatchObject({ New: true })
    await unmount()
  })

  it('sort and collapsed memory do not touch each other despite the shared prefix', async () => {
    lsStore.set(SORT_KEY, JSON.stringify({ key: 'client' }))
    lsStore.set(COLLAPSED_KEY, JSON.stringify({ Nurturing: true }))
    const { unmount } = await mount(<><Sort /><Bands /></>)
    expect(lsStore.get(SORT_KEY)).toBe(JSON.stringify({ key: 'client' }))
    expect(JSON.parse(lsStore.get(COLLAPSED_KEY) || '{}')).toMatchObject({ Nurturing: true })
    await unmount()
  })
})

// ── 6) a user's own choice still writes through ─────────────────
describe('write-through after hydration', () => {
  function Pick() {
    const [v, setV] = useStoredState(SORT_KEY, SORT_DEFAULT)
    return <button data-testid="pick" onClick={() => setV({ key: 'client' })}>{(v as any).key}</button>
  }

  it('choosing a sort stores it', async () => {
    const { host, unmount } = await mount(<Pick />)
    const btn = host.querySelector('[data-testid=pick]') as HTMLElement
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(lsStore.get(SORT_KEY)).toBe(JSON.stringify({ key: 'client' }))
    await unmount()
  })

  it('a fresh mount then renders that choice, not the default', async () => {
    const first = await mount(<Pick />)
    const btn = first.host.querySelector('[data-testid=pick]') as HTMLElement
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await first.unmount()

    const second = await mount(<Sort />)
    expect(sortText(second.host)).toBe('client')
    await second.unmount()
  })
})

// ── 7) the dynamic-key path (bee_hive_inbox_filters:<loc>) ──────
describe('a dynamic key — the Inbox filter scope', () => {
  function Scoped({ loc }: { loc: string }) {
    const [v] = useStoredState(`bee_hive_inbox_filters:${loc}`, { stage: 'all' })
    return <span data-testid="sort">{(v as any).stage}</span>
  }

  it('does not write the previous scope value under the new scope key', async () => {
    lsStore.set('bee_hive_inbox_filters:loc-a', JSON.stringify({ stage: 'new' }))
    const { host, rerender, unmount } = await mount(<Scoped loc="loc-a" />)
    expect(sortText(host)).toBe('new')

    writes = []
    await rerender(<Scoped loc="loc-b" />)
    // loc-b stored nothing, so it must read as the default — and loc-a's
    // 'new' must never have been written under loc-b's key.
    expect(sortText(host)).toBe('all')
    expect(writesTo('bee_hive_inbox_filters:loc-b')).not.toContain(JSON.stringify({ stage: 'new' }))
    expect(lsStore.get('bee_hive_inbox_filters:loc-a')).toBe(JSON.stringify({ stage: 'new' }))
    await unmount()
  })
})

// ── 8) END-TO-END through the real HiveShell — Ankur's case ─────
describe("through the real HiveShell — Ankur's bug", () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString()
  const eng = (over: any = {}) => ({
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    client_id: 'c1', client_name: 'Pat Tester', location_uuid: 'loc-uuid-1',
    title: 'Garage organization', stage: 'Request', created_at: daysAgo(3),
    stage_entered_at: daysAgo(3), nurture_started_at: null,
    total_invoiced: 0, total_paid: 0, balance_owing: 0, repeat_count: 1,
    quotes: [], jobs: [], invoices: [], ...over,
  })
  const ENGAGEMENTS = [
    eng({ id: 'req-1', stage: 'Request', client_name: 'Ada Request' }),
    eng({ id: 'job-1', stage: 'Job in Progress', client_name: 'Cy Job' }),
  ]
  const PEOPLE = [{
    id: 'new-1', name: 'Nora New', email: 'n@x.com', phone: '555',
    locationId: 'loc-uuid-1', created: daysAgo(2), paidAmount: 0, paused: false,
    jobberRef: null, source: 'webform', outreachTimeline: [],
  }]
  const LOCATIONS = [{ id: 'loc-uuid-1', name: 'Portland' }]

  const shell = () => (
    <HiveShell engagements={ENGAGEMENTS as any} people={PEOPLE as any} locations={LOCATIONS as any} />
  )

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ rows: [], total: 0 }) })))
  })

  it('keeps Client A–Z when the remembered lens is Client List', async () => {
    lsStore.set('bee_hive_beta_lens', 'clients')
    lsStore.set(SORT_KEY, JSON.stringify({ key: 'client' }))
    const { unmount } = await mount(shell())
    expect(lsStore.get(SORT_KEY)).toBe(JSON.stringify({ key: 'client' }))
    await unmount()
  })

  it('keeps Client A–Z when the remembered lens is Inbox', async () => {
    lsStore.set('bee_hive_beta_lens', 'inbox')
    lsStore.set(SORT_KEY, JSON.stringify({ key: 'client' }))
    const { unmount } = await mount(shell())
    expect(lsStore.get(SORT_KEY)).toBe(JSON.stringify({ key: 'client' }))
    await unmount()
  })

  it('keeps Client A–Z when the remembered lens IS the board (was already passing)', async () => {
    lsStore.set('bee_hive_beta_lens', 'engagements')
    lsStore.set(SORT_KEY, JSON.stringify({ key: 'client' }))
    const { unmount } = await mount(shell())
    expect(lsStore.get(SORT_KEY)).toBe(JSON.stringify({ key: 'client' }))
    await unmount()
  })

  it('keeps the remembered Inbox sort when the lens lands elsewhere', async () => {
    lsStore.set('bee_hive_beta_lens', 'clients')
    lsStore.set('bee_hive_inbox_sort', JSON.stringify({ key: 'name' }))
    const { unmount } = await mount(shell())
    expect(lsStore.get('bee_hive_inbox_sort')).toBe(JSON.stringify({ key: 'name' }))
    await unmount()
  })

  it('keeps the remembered engagement list filters when the lens lands elsewhere', async () => {
    lsStore.set('bee_hive_beta_lens', 'inbox')
    lsStore.set('bee_hive_list_filters', JSON.stringify({ stage: 'Estimate' }))
    const { unmount } = await mount(shell())
    expect(JSON.parse(lsStore.get('bee_hive_list_filters') || '{}')).toMatchObject({ stage: 'Estimate' })
    await unmount()
  })
})
