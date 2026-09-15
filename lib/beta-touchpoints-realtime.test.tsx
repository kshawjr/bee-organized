// @vitest-environment happy-dom
//
// TOUCHPOINTS REALTIME — someone ELSE's logged call (another bee at the same
// location, or a webhook) moves the card on your open Inbox, with no reload.
//
// THE GAP THIS CLOSES, precisely. use-leads-realtime already carries every
// change to a LEAD row, and BeeHub refetches the whole person on any of them,
// so stage moves are already live. Logging a call writes to the TOUCHPOINTS
// table and never touches the lead row — so leads realtime never fires, and
// two bees working one Inbox chase the same lead until someone reloads.
//
// THE CORRUPTION CASE, which is what most of this file is about. Timeline
// entries are APPENDS, not field overwrites. If a realtime entry and a refetch
// both land the same call, a last-wins merge counts it TWICE — two reach_outs
// — and the person sits in the wrong Inbox touch band. Nobody would notice for
// weeks. peopleTouchPatch's merge is additive-BY-ID precisely to make that
// impossible, and the remote path is routed through the SAME seam the local
// override uses so there is one opinion about how an entry joins a person.
// Pins:
//   · another user's touchpoint moves the card New → Attempting live
//   · a webhook's touchpoint does the same (no user_id, same door)
//   · the SAME touchpoint by realtime AND by refetch counts ONCE
//   · your own logged call still behaves exactly as it does today
//   · a touchpoint for a lead outside the viewer's scope never appears
//   · the nav badge and the band counts move with the card
//   · channel scoping mirrors use-leads-realtime; 'all' subscribes UNFILTERED
//   · HiveShell is wired to the seam this suite tests (source sweep)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'
import { deriveClientStatus } from '@/components/hive/shared/clientStatus'
import { mergePeopleTouches } from '@/components/hive/shared/peopleTouchPatch'
import { isInboxCountable } from '@/components/hive/shared/inboxCountable'
import { touchpointToTimelineEntry } from '@/lib/people-mapper'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

// ── supabase realtime harness ─────────────────────────────────────
// Mirrors beta-leads-realtime's: vi.hoisted because the mock factory runs
// during the hook import below.
const { channels, removed, cfg } = vi.hoisted(() => ({
  channels: [] as any[],
  removed: [] as any[],
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

import { useTouchpointsRealtime } from '@/lib/use-touchpoints-realtime'

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: 'p1',
  name: 'Sarah Mitchell',
  email: 'sarah@email.com',
  phone: '(561) 555-0199',
  locationId: 'loc-uuid-1',
  created: daysAgo(3), // < 30d, no outreach → derives New
  isJunk: false,
  snoozeUntil: null,
  inboxDismissedAt: null,
  jobberRef: null,
  paidAmount: 0,
  source: 'webform',
  outreachTimeline: [],
  ...over,
})

// A raw touchpoints row, exactly as postgres_changes delivers it: snake_case
// DB columns, no enrichment. `user_id` null is the WEBHOOK case — nobody
// logged it by hand.
const tpRow = (over: any = {}) => ({
  id: 'tp-remote-1',
  lead_id: 'p1',
  location_uuid: 'loc-uuid-1',
  kind: 'reach_out',
  method: 'call',
  label: 'Reach-out',
  status: 'done',
  occurred_at: daysAgo(1),
  user_id: 'someone-else',
  ...over,
})

const reachOuts = (p: any) => (p.outreachTimeline || []).filter((t: any) => t.type === 'reach_out')

// ── the harness ───────────────────────────────────────────────────
// HiveShell owns touchPatches, applyTouchpoint and the mergePeopleTouches
// call; it is a 1000-line component that cannot be mounted here, so its
// reducer is transcribed and the source sweep at the bottom pins that the
// real one still matches. mergePeopleTouches and touchpointToTimelineEntry
// are the REAL modules — the parts that carry the dedupe rule.
function Harness({ locFilter, initialPeople = [] as any[], serverRows = null as any, onReady }: any) {
  const [people, setPeople] = React.useState(initialPeople)
  const [touchPatches, setTouchPatches] = React.useState<any>({})
  // BeeHub's prop→state sync after router.refresh(), so the refetch race
  // below is the real one: a server snapshot replacing the array wholesale.
  React.useEffect(() => { if (Array.isArray(serverRows)) setPeople(serverRows) }, [serverRows])

  // HiveShell's applyTouchpoint, transcribed.
  const applyTouchpoint = React.useCallback((personId: string, row: any) => {
    if (!personId || !row || !row.id) return
    const entry = touchpointToTimelineEntry(row)
    setTouchPatches((prev: any) => {
      const cur = prev[personId] || []
      if (cur.some((t: any) => t.id === entry.id)) return prev
      return { ...prev, [personId]: [...cur, entry] }
    })
  }, [])

  const handleTouchpointRealtime = React.useCallback((row: any) => {
    applyTouchpoint(row.lead_id, row)
  }, [applyTouchpoint])

  useTouchpointsRealtime(locFilter, handleTouchpointRealtime)

  const patchedPeople = React.useMemo(() => mergePeopleTouches(people, touchPatches), [people, touchPatches])
  // HiveShell's inboxCount, transcribed — so "the badge moved too" is a claim
  // about the app rather than a number this test invented.
  const scopedPeople = locFilter === 'all' ? patchedPeople : patchedPeople.filter((p: any) => p.locationId === locFilter)
  const badge = scopedPeople.reduce((n: number, p: any) => n + (isInboxCountable(p, new Set(), new Set(), Date.now()) ? 1 : 0), 0)

  // Hand the merged rows out so the dedupe can be asserted exactly, not
  // inferred from rendered text.
  onReady?.({ patchedPeople, applyTouchpoint })

  return (
    <>
      <div data-testid="nav-badge">{`badge:${badge}`}</div>
      <InboxScreen people={patchedPeople} engagements={[]} locFilter={locFilter} />
    </>
  )
}

let container: HTMLDivElement
let root: Root
let latest: any = null

const flush = async () => { await act(async () => { await Promise.resolve() }) }

const mount = async (props: any) => {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(<Harness {...props} onReady={(v: any) => { latest = v }} />)
  })
  await flush()
}

// Fire a postgres_changes INSERT at the live channel, as Supabase would.
// ENFORCES the channel's filter rather than calling the handler blind:
// Supabase drops non-matching rows server-side, so a suite that ignored the
// filter would pass even with the scope wrong.
const emit = async (row: any) => {
  const ch = channels[channels.length - 1]
  const want = ch.config.filter
  if (want && want !== `location_uuid=eq.${row.location_uuid}`) return // not delivered
  await act(async () => { ch.handler({ eventType: 'INSERT', new: row }) })
  await flush()
}

const text = () => container.textContent || ''
const badgeText = () => container.querySelector('[data-testid="nav-badge"]')?.textContent || ''
const merged = (id: string) => latest.patchedPeople.find((p: any) => p.id === id)

beforeEach(() => {
  channels.length = 0
  removed.length = 0
  cfg.throwOnCreate = false
  latest = null
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  ;(root as any) = null
  container?.remove()
  vi.restoreAllMocks()
})

describe("someone else's touchpoint moves the card", () => {
  it("another user's logged call moves the row New → Attempting, live", async () => {
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })
    expect(text()).toContain('New · 1')
    expect(text()).toContain('Attempting · 0')

    await emit(tpRow())

    expect(text()).toContain('New · 0')
    expect(text()).toContain('Attempting · 1')
    // The band is the DERIVATION's output, not a realtime-specific path.
    expect(deriveClientStatus(merged('p1'), new Set(), Date.now())).toBe('Attempting')
  })

  it("a webhook's touchpoint does the same — same door, no user_id", async () => {
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })

    await emit(tpRow({ id: 'tp-hook', user_id: null, method: 'email', label: 'Drip email' }))

    expect(text()).toContain('Attempting · 1')
    expect(reachOuts(merged('p1'))).toHaveLength(1)
  })

  it('the nav badge and the band counts move together', async () => {
    // A card that moves while the badge disagrees is the #89 drift.
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })
    expect(badgeText()).toBe('badge:1') // New is countable

    await emit(tpRow())

    expect(text()).toContain('Attempting · 1')
    expect(badgeText()).toBe('badge:1') // still countable, different band
  })

  it('the arriving row is projected through the SAME mapper hydration uses', async () => {
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })

    await emit(tpRow())

    // Not the raw DB row: `type` comes from `kind`, `ts` is formatted. This is
    // what makes a remote entry indistinguishable from a hydrated one, which
    // is what lets the merge dedupe on id.
    const entry = merged('p1').outreachTimeline[0]
    expect(entry.id).toBe('tp-remote-1')
    expect(entry.type).toBe('reach_out')
    expect(entry.occurred_at).toBe(tpRow().occurred_at)
    expect(entry).toEqual(touchpointToTimelineEntry(tpRow()))
  })
})

describe('THE CORRUPTION CASE — one call must never count twice', () => {
  it('the same touchpoint by realtime AND by refetch counts ONCE', async () => {
    // The whole reason peopleTouchPatch is additive-BY-ID. Last-wins here
    // yields two reach_outs and the person lands in the wrong touch band.
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })

    await emit(tpRow())
    expect(reachOuts(merged('p1'))).toHaveLength(1)

    // Now the refetch lands, carrying that SAME touchpoint as server truth.
    const hydrated = person({ outreachTimeline: [touchpointToTimelineEntry(tpRow())] })
    await act(async () => {
      root.render(<Harness locFilter="loc-uuid-1" serverRows={[hydrated]} onReady={(v: any) => { latest = v }} />)
    })
    await flush()

    expect(reachOuts(merged('p1'))).toHaveLength(1) // ← the pin
    expect(text()).toContain('Attempting · 1')
    expect(text()).toContain('New · 0')
  })

  it('the override RETIRES once the snapshot carries the entry (same reference back)', async () => {
    // mergePeopleTouches returns `people` itself when it has nothing to add,
    // so a caught-up refetch costs zero re-renders.
    const hydrated = [person({ outreachTimeline: [touchpointToTimelineEntry(tpRow())] })]
    const patches = { p1: [touchpointToTimelineEntry(tpRow())] }
    expect(mergePeopleTouches(hydrated, patches)).toBe(hydrated)
  })

  it('a duplicate realtime burst for the same touchpoint counts once', async () => {
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })

    await emit(tpRow())
    await emit(tpRow())
    await emit(tpRow())

    expect(reachOuts(merged('p1'))).toHaveLength(1)
    expect(text()).toContain('Attempting · 1')
  })

  it('two DIFFERENT calls both count — the dedupe is by id, not a cap', async () => {
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })

    await emit(tpRow({ id: 'tp-a', occurred_at: daysAgo(2) }))
    await emit(tpRow({ id: 'tp-b', occurred_at: daysAgo(1) }))

    expect(reachOuts(merged('p1'))).toHaveLength(2)
  })

  it('merged entries stay sorted occurred_at ASCENDING, as hydration ships them', async () => {
    // "the last entry is the newest" readers depend on this, not on the
    // order events happened to arrive in.
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })

    await emit(tpRow({ id: 'tp-late', occurred_at: daysAgo(1) }))
    await emit(tpRow({ id: 'tp-early', occurred_at: daysAgo(5) }))

    const ts = merged('p1').outreachTimeline.map((t: any) => new Date(t.occurred_at).getTime())
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
  })
})

describe('your own logged call still works exactly as it did', () => {
  it('a locally logged call moves the card with no realtime involved', async () => {
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })
    expect(text()).toContain('New · 1')

    // The Inbox/card/profile hand-up seam, called directly — no event fired.
    await act(async () => { latest.applyTouchpoint('p1', tpRow({ id: 'tp-mine', user_id: 'me' })) })
    await flush()

    expect(text()).toContain('Attempting · 1')
    expect(reachOuts(merged('p1'))).toHaveLength(1)
  })

  it('a local call and its own realtime echo count ONCE', async () => {
    // You log a call; your own INSERT comes back down the socket. Both paths
    // reach the same reducer, which already refuses an id it is holding.
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })

    await act(async () => { latest.applyTouchpoint('p1', tpRow({ id: 'tp-mine' })) })
    await flush()
    await emit(tpRow({ id: 'tp-mine' }))

    expect(reachOuts(merged('p1'))).toHaveLength(1)
    expect(text()).toContain('Attempting · 1')
  })
})

describe('scope — a lead the viewer cannot see never appears', () => {
  it("a touchpoint for another location's lead is not delivered", async () => {
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })

    await emit(tpRow({ id: 'tp-far', lead_id: 'p-far', location_uuid: 'loc-uuid-9' }))

    expect(text()).toContain('New · 1') // untouched
    expect(text()).toContain('Attempting · 0')
  })

  it('a touchpoint for a lead not in the snapshot conjures no row', async () => {
    // Delivered (same location) but for a lead this viewer never loaded —
    // mergePeopleTouches only maps over rows it already has.
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })

    await emit(tpRow({ id: 'tp-ghost', lead_id: 'p-unknown' }))

    expect(latest.patchedPeople).toHaveLength(1)
    expect(text()).toContain('New · 1')
    expect(badgeText()).toBe('badge:1')
  })

  it('filters to a real locFilter uuid, as use-leads-realtime does', async () => {
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [] })
    expect(channels).toHaveLength(1)
    expect(channels[0].subscribed).toBe(true)
    expect(channels[0].config.table).toBe('touchpoints')
    expect(channels[0].config.event).toBe('INSERT')
    expect(channels[0].config.filter).toBe('location_uuid=eq.loc-uuid-1')
  })

  it("subscribes UNFILTERED on 'all' (RLS scopes delivery)", async () => {
    await mount({ locFilter: 'all', initialPeople: [] })
    expect(channels).toHaveLength(1)
    expect(channels[0].config.filter).toBeUndefined()
  })

  it('subscribes to nothing when there is no location vocabulary yet', async () => {
    await mount({ locFilter: null, initialPeople: [] })
    expect(channels).toHaveLength(0)
  })

  it('ignores a row with no id or no lead_id — nothing safe to merge', async () => {
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })

    await emit(tpRow({ id: null }))
    await emit(tpRow({ lead_id: null }))

    expect(reachOuts(merged('p1'))).toHaveLength(0)
    expect(text()).toContain('New · 1')
  })
})

describe('lifecycle', () => {
  it('a locFilter change tears down the old channel and opens exactly one new', async () => {
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [] })
    const first = channels[0]

    await act(async () => { root.render(<Harness locFilter="loc-uuid-2" onReady={(v: any) => { latest = v }} />) })
    await flush()

    expect(removed).toContain(first)
    expect(channels).toHaveLength(2)
    expect(channels[1].config.filter).toBe('location_uuid=eq.loc-uuid-2')
  })

  it('does not resubscribe on an ordinary re-render', async () => {
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })
    await act(async () => { root.render(<Harness locFilter="loc-uuid-1" initialPeople={[person()]} onReady={(v: any) => { latest = v }} />) })
    await flush()
    expect(channels).toHaveLength(1)
  })

  it('removes the channel on unmount', async () => {
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [] })
    const ch = channels[0]
    await act(async () => { root.unmount() })
    ;(root as any) = null
    expect(removed).toContain(ch)
  })

  it('renders the Inbox anyway when the supabase client cannot be created', async () => {
    // Realtime is an enhancement, never a dependency.
    cfg.throwOnCreate = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })

    expect(channels).toHaveLength(0)
    expect(text()).toContain('Sarah Mitchell')
    expect(err).toHaveBeenCalled()
  })
})

// ── source sweep ──────────────────────────────────────────────────
describe('HiveShell is wired to the seam this suite tests', () => {
  const src = readFileSync(join(process.cwd(), 'components/hive/HiveShell.jsx'), 'utf8')

  it('subscribes on the board locFilter vocabulary', () => {
    expect(src).toContain('useTouchpointsRealtime(locFilter, handleTouchpointRealtime)')
  })

  it('routes the arriving row through applyTouchpoint — the SAME merge seam', () => {
    // The whole design: NOT a second path into touchPatches or the timeline.
    expect(src).toContain('applyTouchpoint(row.lead_id, row)')
    expect(src).toContain('mergePeopleTouches(people, touchPatches)')
  })

  it('the merge it feeds is still additive-by-id, not last-wins', () => {
    const merge = readFileSync(join(process.cwd(), 'components/hive/shared/peopleTouchPatch.js'), 'utf8')
    expect(merge).toContain('!seen.has(t.id)')
  })

  it('does not rebuild leads realtime or touch the engagements reconcile', () => {
    const hook = readFileSync(join(process.cwd(), 'lib/use-touchpoints-realtime.ts'), 'utf8')
    expect(hook).not.toContain("table: 'leads'")
    expect(hook).not.toContain('reconcileServerRows')
  })
})
