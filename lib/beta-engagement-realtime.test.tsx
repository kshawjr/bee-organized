// @vitest-environment happy-dom
//
// Board engagement REALTIME (Tier 1) — the Supabase postgres_changes trigger
// layered on top of the same merge the focus sweep uses
// (engagementRevalidate.js, unit-tested in beta-engagement-revalidate). Stage
// moves land server-side with no client event; this makes them land LIVE.
// Pins:
//   · a realtime UPDATE moves the card to the new column with no reload, via
//     the existing reconcile (?ids= refetch, not a parallel merge)
//   · the refetch is ENRICHED — name/value survive the move, proving the
//     payload was used as a signal and not fed in raw
//   · realtime and focus produce an IDENTICAL board for the same server row
//   · a burst of events for one id collapses to a single refetch
//   · the in-flight guard stops refetches stacking, and re-arms (an event
//     landing mid-fetch is never dropped)
//   · a pending drag-close (rowPatches) is NOT clobbered by a concurrent
//     realtime refetch that still reports the row open
//   · locFilter scopes the channel; 'all' subscribes unfiltered (RLS scopes)
//   · a locFilter change tears the old channel down and opens exactly one new
//   · the channel is removed on unmount
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
// Desktop width so the board renders every column (data-board-col) and is
// draggable — useIsMobile reads this seam (see useIsMobile.js).
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

// ── supabase realtime harness ─────────────────────────────────────
// vi.hoisted: vi.mock's factory runs during the HiveShell import below, which
// is BEFORE a plain module-scope const would initialize.
const { channels, removed, cfg } = vi.hoisted(() => ({
  channels: [] as any[],
  removed: [] as any[],
  // createBrowserClient throws for real when the NEXT_PUBLIC_SUPABASE_* vars
  // are absent — this reproduces that.
  cfg: { throwOnCreate: false },
}))

vi.mock('@/lib/supabase', () => ({
  createClient: () => {
    if (cfg.throwOnCreate) {
      throw new Error("@supabase/ssr: Your project's URL and API key are required to create a Supabase client!")
    }
    return {
    channel: (name: string) => {
      const ch: any = { name, config: null, handler: null, subscribed: false }
      ch.on = (_event: string, config: any, handler: any) => {
        ch.config = config
        ch.handler = handler
        return ch
      }
      ch.subscribe = () => { ch.subscribed = true; return ch }
      channels.push(ch)
      return ch
    },
      removeChannel: (ch: any) => { removed.push(ch) },
    }
  },
}))

// The drag-close renders CloseEngagementConfirm (the real one PATCHes). Stub
// it to a button firing onClosed with the preselected terminal stage — here
// we only need it to produce the rowPatch a realtime refetch must not clobber.
vi.mock('@/components/hive/shared/CloseEngagementConfirm', () => ({
  default: (props: any) =>
    React.createElement('button', {
      'data-testid': 'commit-close',
      onClick: () => props.onClosed(props.initialCloseAs),
    }, 'commit'),
}))

import HiveShell from '@/components/hive/HiveShell'

// Mirrors HiveShell's REALTIME_COALESCE_MS.
const COALESCE_MS = 250

const ENG = (over: any = {}) => ({
  id: 'e1', client_id: 'c1', client_name: 'Acme Co', stage: 'Request',
  title: 'Kitchen declutter', created_at: '2026-07-01T00:00:00Z',
  location_uuid: 'loc-1', repeat_count: 1,
  quotes: [], jobs: [], invoices: [], assessments: [], service_requests: [],
  ...over,
})

// The enriched row the server returns for the moved engagement: a sent quote
// puts it in Estimate and gives the card a value to render.
const MOVED = () => ENG({
  stage: 'Estimate',
  quotes: [{ id: 'q1', status: 'sent', total: 900, sent_at: '2026-07-05T00:00:00Z', approved_at: null }],
})

// ── fetch harness ─────────────────────────────────────────────────
let serverRows: any[] = []
let idsCalls: string[] = []
let openCalls: string[] = []
let idsResolvers: Array<() => void> = []
let holdIds = false // when true, ?ids= fetches hang until released

function installFetch() {
  idsCalls = []
  openCalls = []
  idsResolvers = []
  holdIds = false
  ;(globalThis as any).fetch = vi.fn((url: any) => {
    const u = String(url)
    if (u.includes('/api/lookups')) {
      return Promise.resolve({ ok: true, json: async () => ({ lookups: [] }) })
    }
    if (u.includes('/api/engagements') && u.includes('ids=')) {
      idsCalls.push(u)
      const payload = { ok: true, json: async () => ({ rows: serverRows, total: serverRows.length }) }
      if (holdIds) return new Promise(res => { idsResolvers.push(() => res(payload)) })
      return Promise.resolve(payload)
    }
    if (u.includes('/api/engagements') && u.includes('open=1')) {
      openCalls.push(u)
      return Promise.resolve({ ok: true, json: async () => ({ rows: serverRows, total: serverRows.length }) })
    }
    return Promise.resolve({ ok: true, json: async () => ({}) })
  })
}

const flush = async () => { await act(async () => { await Promise.resolve() }) }

// Real timers: let the coalesce window actually elapse, then settle the
// refetch it kicks off.
const settleRealtime = async () => {
  await act(async () => { await new Promise(r => setTimeout(r, COALESCE_MS + 60)) })
  await flush()
  await flush()
}

// Fire a postgres_changes UPDATE at the live channel, as Supabase would.
const emit = async (id: string, ch: any = channels[channels.length - 1]) => {
  await act(async () => { ch.handler({ eventType: 'UPDATE', new: { id } }) })
}

let container: HTMLDivElement
let root: Root

async function mountShell(engagements: any[], props: any = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(React.createElement(HiveShell, { engagements, ...props }))
  })
  await flush()
}

beforeEach(() => {
  installFetch()
  channels.length = 0
  removed.length = 0
  cfg.throwOnCreate = false
})
afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  ;(root as any) = null
  container?.remove()
  vi.restoreAllMocks()
})

const colText = (stageKey: string) =>
  container.querySelector(`[data-board-col="${stageKey}"]`)?.textContent || ''

describe('realtime stage move lands without reload', () => {
  it('an UPDATE event moves the card from Request to Estimate', async () => {
    serverRows = [MOVED()]
    await mountShell([ENG({ stage: 'Request' })])

    expect(colText('Request')).toContain('Acme Co')
    expect(colText('Estimate')).not.toContain('Acme Co')

    await emit('e1')
    await settleRealtime()

    expect(colText('Estimate')).toContain('Acme Co')
    expect(colText('Request')).not.toContain('Acme Co')
  })

  it('refetches the moved id in board shape rather than feeding the payload', async () => {
    serverRows = [MOVED()]
    await mountShell([ENG({ stage: 'Request' })])
    await emit('e1')
    await settleRealtime()

    // The event carried ONLY { id } — a raw feed would have blanked the
    // client name and the quote-derived value. Both surviving proves the
    // enriched refetch ran.
    expect(idsCalls.length).toBe(1)
    expect(idsCalls[0]).toContain('ids=e1')
    expect(colText('Estimate')).toContain('Acme Co')
    expect(colText('Estimate')).toContain('900')
  })

  it('produces the same board as the focus sweep for the same server row', async () => {
    // Equivalence pin: realtime is a new TRIGGER on the existing reconcile,
    // not a second merge. Same server truth ⇒ same rendered column.
    serverRows = [MOVED()]
    await mountShell([ENG({ stage: 'Request' })])
    await emit('e1')
    await settleRealtime()
    const viaRealtime = colText('Estimate')

    await act(async () => { root.unmount() })
    container.remove()

    await mountShell([ENG({ stage: 'Request' })])
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await flush()
    await flush()
    const viaFocus = colText('Estimate')

    expect(viaRealtime).toBe(viaFocus)
    expect(viaFocus).toContain('Acme Co')
  })
})

describe('coalescing + guards', () => {
  it('a burst of events for one id collapses to ONE refetch', async () => {
    serverRows = [MOVED()]
    await mountShell([ENG({ stage: 'Request' })])

    // One server action commonly writes stage, totals and closed_at — three
    // events, one card.
    await emit('e1')
    await emit('e1')
    await emit('e1')
    await settleRealtime()

    expect(idsCalls.length).toBe(1)
  })

  it('coalesces distinct ids into a single batched refetch', async () => {
    serverRows = [MOVED()]
    await mountShell([ENG({ stage: 'Request' }), ENG({ id: 'e2', client_id: 'c2', stage: 'Request' })])
    await emit('e1')
    await emit('e2')
    await settleRealtime()

    expect(idsCalls.length).toBe(1)
    expect(idsCalls[0]).toContain('e1')
    expect(idsCalls[0]).toContain('e2')
  })

  it('in-flight guard blocks a stacked refetch, then re-arms (no dropped event)', async () => {
    serverRows = [MOVED()]
    holdIds = true
    await mountShell([ENG({ stage: 'Request' })])

    await emit('e1')
    await settleRealtime()
    expect(idsCalls.length).toBe(1) // hanging

    // A second event lands mid-fetch: it must NOT stack a fetch...
    await emit('e1')
    await settleRealtime()
    expect(idsCalls.length).toBe(1)

    // ...and must NOT be dropped — releasing the first lets the re-armed
    // timer fetch it. (Unlike a stale focus event, nothing else would tell
    // us about this move.)
    holdIds = false
    await act(async () => { idsResolvers.forEach(r => r()); await Promise.resolve() })
    await settleRealtime()
    expect(idsCalls.length).toBe(2)
  })
})

describe('optimistic state survives a concurrent refetch', () => {
  it('a pending drag-close is not clobbered by a realtime refetch reporting it open', async () => {
    // The server hasn't observed the close yet — the refetch still says
    // Request. rowPatches must win (merge precedence: base < server < patch).
    serverRows = [ENG({ stage: 'Request' })]
    await mountShell([ENG({ stage: 'Request' })])

    const card = container.querySelector('[draggable="true"]') as HTMLElement
    expect(card).toBeTruthy()
    await act(async () => { card.dispatchEvent(new Event('dragstart', { bubbles: true })) })
    await flush()
    const lostZone = container.querySelector('[aria-label="Close as lost"]') as HTMLElement
    expect(lostZone).toBeTruthy()
    await act(async () => {
      lostZone.dispatchEvent(new Event('dragenter', { bubbles: true }))
      lostZone.dispatchEvent(new Event('drop', { bubbles: true }))
    })
    await flush()
    const commit = container.querySelector('[data-testid="commit-close"]') as HTMLElement
    expect(commit).toBeTruthy()
    await act(async () => { commit.click() })
    await flush()

    // Card left the open board on the local close.
    expect(colText('Request')).not.toContain('Acme Co')

    // A concurrent realtime refetch lands with the stale open row.
    await emit('e1')
    await settleRealtime()
    expect(idsCalls.length).toBe(1)

    // Still closed — the terminal patch outranks the stale server row.
    expect(colText('Request')).not.toContain('Acme Co')
  })
})

describe('channel scoping + lifecycle', () => {
  it('scopes the channel to a real locFilter uuid', async () => {
    serverRows = []
    await mountShell([ENG()], { locFilter: 'loc-1' })
    expect(channels.length).toBe(1)
    expect(channels[0].subscribed).toBe(true)
    expect(channels[0].config.table).toBe('engagements')
    expect(channels[0].config.event).toBe('UPDATE')
    expect(channels[0].config.filter).toBe('location_uuid=eq.loc-1')
  })

  it("subscribes UNFILTERED when locFilter is 'all' (RLS scopes delivery)", async () => {
    serverRows = []
    await mountShell([ENG()], { locFilter: 'all' })
    expect(channels.length).toBe(1)
    expect(channels[0].config.filter).toBeUndefined()
  })

  it('a locFilter change tears down the old channel and opens exactly one new', async () => {
    serverRows = []
    await mountShell([ENG()], { locFilter: 'loc-1' })
    const first = channels[0]

    await act(async () => {
      root.render(React.createElement(HiveShell, { engagements: [ENG()], locFilter: 'loc-2' }))
    })
    await flush()

    expect(removed).toContain(first)
    expect(channels.length).toBe(2) // no duplicate subscription
    expect(channels[1].config.filter).toBe('location_uuid=eq.loc-2')
  })

  it('removes the channel on unmount', async () => {
    serverRows = []
    await mountShell([ENG()], { locFilter: 'loc-1' })
    const ch = channels[0]
    await act(async () => { root.unmount() })
    ;(root as any) = null
    expect(removed).toContain(ch)
  })

  it('renders the board anyway when the supabase client cannot be created', async () => {
    // Realtime is an enhancement, never a dependency: createClient() throws on
    // missing NEXT_PUBLIC_SUPABASE_* and this hook runs in a passive effect
    // during commit, so an unguarded throw takes the BOARD down — losing the
    // whole page to buy live moves. It must degrade to the focus trigger.
    // (Every other HiveShell suite mounts without those vars and leans on
    // this; do not remove the try/catch that makes it true.)
    cfg.throwOnCreate = true
    serverRows = [MOVED()]
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await mountShell([ENG({ stage: 'Request' })], { locFilter: 'loc-1' })

    expect(channels.length).toBe(0)
    expect(colText('Request')).toContain('Acme Co') // board is alive
    expect(err).toHaveBeenCalled()                  // and it said so

    // The focus backstop still works with realtime off.
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await flush()
    await flush()
    expect(openCalls.length).toBe(1)
    expect(colText('Estimate')).toContain('Acme Co')
  })
})
