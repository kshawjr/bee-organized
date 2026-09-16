// @vitest-environment happy-dom
//
// LEADS REALTIME (Tier 2) — a brand-new lead (Jobber webhook, MAKE, website
// intake, another user) appears in the Inbox with no reload. The cross-source
// counterpart to the log-call lift: that build made a LOCAL write re-derive
// everywhere; this one makes a REMOTE insert land at all.
//
// The subscription already existed but was pinned to a single location
// resolved from currentLocation/currentUser — so an admin on 'all' watched an
// arbitrary location, or (with no location at all) nothing. It now takes the
// board's own locFilter vocabulary, matching use-engagements-realtime.
// Pins:
//   · a simulated INSERT adds a NEW Inbox row with no reload, bucketed by the
//     same deriveClientStatus every other row uses (no realtime status path)
//   · the event is a SIGNAL — the row is refetched enriched, not fed raw
//   · dedupe by id: an INSERT for a lead already in state does not double it
//   · locFilter scopes the channel; 'all' subscribes UNFILTERED (RLS scopes),
//     which is the whole bug this build closes
//   · teardown on unmount and on locFilter change — no duplicate channels
//   · createClient throwing degrades to no-realtime; the Inbox still mounts
//   · the ENGAGEMENTS reconcile still drops not-in-baseById rows — the leads
//     insert path must not have leaked into the board's stage-move seam
//   · BeeHub is wired to the seam this suite tests (source sweep)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'
import { deriveClientStatus } from '@/components/hive/shared/clientStatus'
import { upsertRealtimePerson, removeRealtimePerson } from '@/components/hive/shared/leadsRealtime'
import { reconcileServerRows } from '@/components/hive/shared/engagementRevalidate'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

// ── supabase realtime harness ─────────────────────────────────────
// Mirrors beta-engagement-realtime's: vi.hoisted because the mock factory runs
// during the hook import below.
const { channels, removed, cfg } = vi.hoisted(() => ({
  channels: [] as any[],
  removed: [] as any[],
  // createClient() throws for real when NEXT_PUBLIC_SUPABASE_* are absent.
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

import { useLeadsRealtime } from '@/lib/use-leads-realtime'

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

// A reach_out on the timeline is what moves a person New → Attempting.
const reachOut = {
  id: 'tp-1', type: 'reach_out', method: 'call', label: 'Reach-out',
  ts: daysAgo(1), occurred_at: daysAgo(1), status: 'done',
}

// ── the pure merge ────────────────────────────────────────────────
describe('upsertRealtimePerson (additive-by-id, front-inserting)', () => {
  it('adds a person it has never seen, at the front', () => {
    const existing = person({ id: 'p0', name: 'Dana Reed' })
    const next = upsertRealtimePerson([existing], person(), now)
    expect(next.map(p => p.id)).toEqual(['p1', 'p0'])
    expect(next[1]).toBe(existing) // untouched rows keep their reference
  })

  it('REPLACES a lead already in state rather than appending a second copy', () => {
    // The duplicate-event / created-locally-this-session case.
    const prev = [person({ name: 'Stale Name' })]
    const next = upsertRealtimePerson(prev, person({ name: 'Fresh Name' }), now)
    expect(next).toHaveLength(1)
    expect(next[0].name).toBe('Fresh Name')
  })

  it('is idempotent across a burst of events for the same id', () => {
    let rows: any[] = []
    for (let i = 0; i < 3; i++) rows = upsertRealtimePerson(rows, person(), now)
    expect(rows.filter(p => p.id === 'p1')).toHaveLength(1)
  })

  it('ignores a payload with no id (nothing to dedupe on)', () => {
    const prev = [person()]
    expect(upsertRealtimePerson(prev, null, now)).toBe(prev)
    expect(upsertRealtimePerson(prev, { name: 'No Id' }, now)).toBe(prev)
  })

  it('stamps the pulse from the injected clock, keeping the merge pure', () => {
    const [p] = upsertRealtimePerson([], person(), 12345)
    expect(p._realtimePulse).toBe(12345)
  })

  it('removeRealtimePerson drops the named row and no-ops on an unknown id', () => {
    const prev = [person(), person({ id: 'p2' })]
    expect(removeRealtimePerson(prev, 'p1').map(p => p.id)).toEqual(['p2'])
    expect(removeRealtimePerson(prev, 'nope')).toBe(prev) // same ref → no re-render
  })

  it('buckets an inserted person through the ordinary derivation', () => {
    // No realtime-specific status path: the row derives from its own fields.
    const [fresh] = upsertRealtimePerson([], person(), now)
    expect(deriveClientStatus(fresh, new Set(), now)).toBe('New')
    const [worked] = upsertRealtimePerson([], person({ outreachTimeline: [reachOut] }), now)
    expect(deriveClientStatus(worked, new Set(), now)).toBe('Attempting')
  })
})

// ── the engagements seam is UNCHANGED ─────────────────────────────
describe('the leads insert path did not leak into the engagements reconcile', () => {
  const ENG = (over: any = {}) => ({
    id: 'e1', client_id: 'c1', client_name: 'Acme Co', stage: 'Request',
    quotes: [], jobs: [], invoices: [], assessments: [], service_requests: [],
    ...over,
  })

  it('still DROPS a fresh row absent from baseById (new engagements stay reload-only)', () => {
    // The board's stage-move path depends on this drop. Leads got their own
    // separate merge precisely so this rule could stay untouched.
    const baseById = new Map([['e1', ENG()]])
    const prev = {}
    const next = reconcileServerRows(prev, [ENG({ id: 'e-new', client_name: 'Brand New' })], baseById)
    expect(next).toBe(prev) // nothing accepted, same reference
    expect(Object.keys(next)).not.toContain('e-new')
  })

  it('still reconciles a row it already knows (the drop is scoped, not a freeze)', () => {
    const baseById = new Map([['e1', ENG()]])
    const next: any = reconcileServerRows({}, [ENG({ stage: 'Estimate' })], baseById)
    expect(next.e1.stage).toBe('Estimate')
  })
})

// ── the hook, through the real Inbox ──────────────────────────────
// Mirrors BeeHub's wiring: it owns `people`, folds realtime events in with the
// shared merge, and hands the array to the lens. The source sweep below pins
// that BeeHub really is wired this way, so this harness cannot drift from it.
function Harness({ locFilter, initialPeople = [] as any[] }: any) {
  const [people, setPeople] = React.useState(initialPeople)
  const onChange = React.useCallback(async ({ type, leadId }: any) => {
    if (type === 'DELETE') {
      setPeople(prev => removeRealtimePerson(prev, leadId))
      return
    }
    const res = await fetch(`/api/leads/${leadId}`, { credentials: 'include' })
    if (!res.ok) return
    const { person: fresh } = await res.json()
    if (!fresh) return
    setPeople(prev => upsertRealtimePerson(prev, fresh, Date.now()))
  }, [])
  useLeadsRealtime(locFilter, onChange)
  return <InboxScreen people={people} engagements={[]} locFilter={locFilter} />
}

let container: HTMLDivElement
let root: Root
let leadFetches: string[] = []
let leadById: Record<string, any> = {}

const installFetch = () => {
  leadFetches = []
  ;(globalThis as any).fetch = vi.fn(async (url: any) => {
    const u = String(url)
    const m = u.match(/\/api\/leads\/([^/?]+)$/)
    if (m) {
      leadFetches.push(m[1])
      const p = leadById[m[1]]
      return { ok: !!p, status: p ? 200 : 404, json: async () => ({ person: p || null }) } as any
    }
    return { ok: true, status: 200, json: async () => ({}) } as any
  })
}

const flush = async () => { await act(async () => { await Promise.resolve() }) }

const mount = async (props: any) => {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(<Harness {...props} />)
  })
  await flush()
}

// Fire a postgres_changes event at the live channel, as Supabase would. The
// payload is the FLAT leads row — deliberately missing the Person enrichment,
// so a raw feed would be visibly wrong.
//
// This ENFORCES the channel's filter rather than calling the handler blind:
// Supabase drops non-matching rows server-side, so a suite that ignores the
// filter would pass even with the scope wrong — which is the entire bug here.
// `locationUuid` is the row's own location; the event reaches the handler only
// if the channel would really have delivered it.
//
// A ROW HAS TWO STATES, and this harness used to pretend it had one. The old
// version took a single `locationUuid`, checked the channel filter against it,
// and so silently assumed the new value alone decides delivery. That made a
// location CHANGE unrepresentable — the one case that matters for a transfer —
// and it is why the update-map overstated confidence in stage moves: the suite
// was green about a question it could not ask.
//
// `opts.from` now names the OLD state's location; it defaults to the new one,
// so an ordinary same-location change reads exactly as before.
//
// THE DELIVERY RULE, and what it is grounded in. Supabase's Postgres Changes
// troubleshooting guide says RLS "generally has to allow both the old and new
// row state" for an UPDATE, and our leads policy is location-scoped, so a
// scoped subscriber only sees the change when BOTH states sit at their
// location. That is modelled below. It matches the behaviour Kevin observed in
// a two-browser test — the transferred lead never arrived — but the MECHANISM
// is documented-and-consistent, not something this repo has proven live. The
// broadcast path exists precisely so the feature does not depend on which
// mechanism is really at work.
const emit = async (
  eventType: string,
  id: string,
  locationUuid = 'loc-uuid-1',
  opts: { from?: string } = {}
) => {
  const ch = channels[channels.length - 1]
  const toLoc = locationUuid                 // the row AFTER the change
  const fromLoc = opts.from ?? locationUuid  // the row BEFORE it
  const want = ch.config.filter
  if (want) {
    const matches = (loc: string) => want === `location_uuid=eq.${loc}`
    // INSERT has no old state; DELETE has no new one; UPDATE needs both.
    const delivered =
      eventType === 'INSERT' ? matches(toLoc)
      : eventType === 'DELETE' ? matches(fromLoc)
      : matches(toLoc) && matches(fromLoc)
    if (!delivered) return
  }
  await act(async () => {
    ch.handler({
      eventType,
      new: { id, location_uuid: toLoc },
      old: { id, location_uuid: fromLoc },
    })
  })
  await flush()
  await flush()
}

const text = () => container.textContent || ''

beforeEach(() => {
  installFetch()
  channels.length = 0
  removed.length = 0
  cfg.throwOnCreate = false
  leadById = {}
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  ;(root as any) = null
  container?.remove()
  vi.restoreAllMocks()
})

describe('a new lead appears in the Inbox without a reload', () => {
  it('an INSERT adds a NEW row, bucketed New by the ordinary derivation', async () => {
    leadById['p-new'] = person({ id: 'p-new', name: 'Nora Vance' })
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [] })

    // An empty Inbox shows its empty state — no section counts to read yet.
    expect(text()).toContain('New inquiries land here')
    expect(text()).not.toContain('Nora Vance')

    await emit('INSERT', 'p-new')

    // Section counts are the derivation's own output — a stronger read than
    // the chip, since they prove which bucket the row actually landed in.
    expect(text()).toContain('Nora Vance')
    expect(text()).toContain('New · 1')
    expect(text()).toContain('Attempting · 0')
  })

  it('an inserted lead with a reach-out lands in Attempting, not New', async () => {
    // Same deriveClientStatus path as every other row — no special-casing.
    leadById['p-new'] = person({ id: 'p-new', name: 'Nora Vance', outreachTimeline: [reachOut] })
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [] })

    await emit('INSERT', 'p-new')

    expect(text()).toContain('Nora Vance')
    expect(text()).toContain('Attempting · 1')
    expect(text()).toContain('New · 0')
  })

  it('refetches the lead ENRICHED rather than feeding the payload raw', async () => {
    leadById['p-new'] = person({ id: 'p-new', name: 'Nora Vance' })
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [] })

    await emit('INSERT', 'p-new')

    // The event carried ONLY { id } — a raw feed would have rendered a nameless
    // row. The name surviving proves the enriched refetch ran.
    expect(leadFetches).toEqual(['p-new'])
    expect(text()).toContain('Nora Vance')
  })

  it('does NOT duplicate a lead already in state', async () => {
    // The lead was created locally this session; the server's INSERT event for
    // it then arrives (or a duplicate event fires).
    leadById['p1'] = person()
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })
    expect(text()).toContain('New · 1')

    await emit('INSERT', 'p1')
    await emit('INSERT', 'p1')

    expect(text()).toContain('New · 1') // not 2 — the id deduped
    expect(text()).toContain('Attempting · 0')
  })
})

describe('channel scoping — the bug this build closes', () => {
  it('filters to a real locFilter uuid (a per-location owner sees only their own)', async () => {
    await mount({ locFilter: 'loc-uuid-1' })
    expect(channels).toHaveLength(1)
    expect(channels[0].subscribed).toBe(true)
    expect(channels[0].config.table).toBe('leads')
    expect(channels[0].config.filter).toBe('location_uuid=eq.loc-uuid-1')
  })

  it("subscribes UNFILTERED when locFilter is 'all' (RLS scopes delivery)", async () => {
    // The regression: 'all' used to resolve to ONE arbitrary location — so an
    // admin never saw new leads from anywhere else. RLS admits admins to every
    // row and fences owners to their own, so unfiltered is exactly right.
    await mount({ locFilter: 'all' })
    expect(channels).toHaveLength(1)
    expect(channels[0].config.filter).toBeUndefined()
  })

  it("on 'all', a new lead from ANY location appears — not just one", async () => {
    leadById['p-near'] = person({ id: 'p-near', name: 'Near Nancy', locationId: 'loc-uuid-1' })
    leadById['p-far'] = person({ id: 'p-far', name: 'Far Away', locationId: 'loc-uuid-9' })
    await mount({ locFilter: 'all', initialPeople: [] })

    await emit('INSERT', 'p-near', 'loc-uuid-1')
    await emit('INSERT', 'p-far', 'loc-uuid-9')

    // Under the old single-location resolution the far lead was never
    // delivered — this is the admin-facing symptom the build closes.
    expect(text()).toContain('Near Nancy')
    expect(text()).toContain('Far Away')
    expect(text()).toContain('New · 2')
  })

  it("a per-location owner is NOT delivered another location's insert", async () => {
    leadById['p-far'] = person({ id: 'p-far', name: 'Far Away', locationId: 'loc-uuid-9' })
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [] })

    await emit('INSERT', 'p-far', 'loc-uuid-9')

    expect(text()).not.toContain('Far Away')
    expect(leadFetches).toEqual([]) // never even refetched
  })

  it('subscribes to nothing when there is no location vocabulary yet', async () => {
    await mount({ locFilter: null })
    expect(channels).toHaveLength(0)
  })
})

describe('lifecycle', () => {
  it('a locFilter change tears down the old channel and opens exactly one new', async () => {
    await mount({ locFilter: 'loc-uuid-1' })
    const first = channels[0]

    await act(async () => { root.render(<Harness locFilter="loc-uuid-2" />) })
    await flush()

    expect(removed).toContain(first)
    expect(channels).toHaveLength(2) // no duplicate subscription
    expect(channels[1].config.filter).toBe('location_uuid=eq.loc-uuid-2')
  })

  it('does not resubscribe on an ordinary re-render', async () => {
    // The latest-ref keeps the effect keyed on locFilter alone — a handler that
    // changes identity per render must not thrash the websocket.
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })
    await act(async () => { root.render(<Harness locFilter="loc-uuid-1" initialPeople={[person()]} />) })
    await flush()
    expect(channels).toHaveLength(1)
  })

  it('removes the channel on unmount', async () => {
    await mount({ locFilter: 'loc-uuid-1' })
    const ch = channels[0]
    await act(async () => { root.unmount() })
    ;(root as any) = null
    expect(removed).toContain(ch)
  })

  it('renders the Inbox anyway when the supabase client cannot be created', async () => {
    // Realtime is an enhancement, never a dependency: createClient() throws on
    // missing NEXT_PUBLIC_SUPABASE_* and this hook runs in a passive effect
    // during commit, so an unguarded throw takes the INBOX down — losing the
    // page to buy live leads. Do not remove the try/catch that makes this true.
    cfg.throwOnCreate = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })

    expect(channels).toHaveLength(0)
    expect(text()).toContain('Sarah Mitchell') // Inbox is alive
    expect(err).toHaveBeenCalled()             // and it said so
  })
})

// ── source sweep ──────────────────────────────────────────────────
describe('BeeHub is wired to the seam this suite tests', () => {
  const src = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')

  it('subscribes on locFilter, not a resolved single location', async () => {
    expect(src).toContain('useLeadsRealtime(locFilter, handleLeadsRealtime)')
    // The old resolution is the bug — an 'all' view pinned to one location.
    expect(src).not.toContain('realtimeLocationUuid')
  })

  it('folds events in through the shared merge (so the dedupe is the tested one)', () => {
    expect(src).toContain('upsertRealtimePerson(prev, person, pulseMs)')
    expect(src).toContain('removeRealtimePerson(prev, leadId)')
  })

  it('leaves the leads merge out of the engagements reconcile module', () => {
    const revalidate = readFileSync(join(process.cwd(), 'components/hive/shared/engagementRevalidate.js'), 'utf8')
    expect(revalidate).not.toContain('upsertRealtimePerson')
    expect(revalidate).not.toContain('leadsRealtime')
  })
})

// ── the arrival is VISIBLE, COUNTED, and SCOPED ───────────────────
// The INSERT path above proves a row lands. This block pins the three things
// Kevin asked for on top of it, each of which can regress independently:
//   · the card rings briefly as it appears (his choice over a "1 new lead"
//     banner) — and rings by REUSING _realtimePulse, not a second mechanism
//   · the nav badge moves WITH the band count. A card that appears while the
//     badge still says 0 is worse than no card at all.
//   · a lead the viewer may not see never leaks in — enforced by the ONE
//     shared exclusion predicate, not a second opinion local to the insert.
import { isInboxCountable } from '@/components/hive/shared/inboxCountable'
import { isSoftRemovedFromInbox } from '@/components/hive/shared/inboxSoftRemoval'

// HiveShell owns the nav badge; InboxScreen owns the bands. They are different
// components reading the SAME `people`, which is exactly why they can drift —
// #89 was that drift. This harness holds both over one state tree, so an
// assertion that the two moved together is a real claim about the app and not
// about a number this test computed for itself: the badge line below is
// HiveShell's inboxCount, transcribed.
function BadgeHarness({ locFilter, initialPeople = [] as any[], serverRows = null as any }: any) {
  const [people, setPeople] = React.useState(initialPeople)
  // BeeHub's prop→state sync after router.refresh(). Present so the refetch
  // race below is the REAL one (a server snapshot replacing the array), not a
  // second realtime event standing in for it.
  React.useEffect(() => { if (Array.isArray(serverRows)) setPeople(serverRows) }, [serverRows])
  const onChange = React.useCallback(async ({ type, leadId }: any) => {
    if (type === 'DELETE') { setPeople(prev => removeRealtimePerson(prev, leadId)); return }
    const res = await fetch(`/api/leads/${leadId}`, { credentials: 'include' })
    if (!res.ok) return
    const { person: fresh } = await res.json()
    if (!fresh) return
    setPeople(prev => upsertRealtimePerson(prev, fresh, Date.now()))
  }, [])
  useLeadsRealtime(locFilter, onChange)
  // ── HiveShell's inboxCount, transcribed ──
  const scopedPeople = locFilter === 'all' ? people : people.filter((p: any) => p.locationId === locFilter)
  const badge = scopedPeople.reduce((n: number, p: any) => n + (isInboxCountable(p, new Set(), new Set(), Date.now()) ? 1 : 0), 0)
  return (
    <>
      <div data-testid="nav-badge">{`badge:${badge}`}</div>
      <InboxScreen people={people} engagements={[]} locFilter={locFilter} />
    </>
  )
}

const mountBadge = async (props: any) => {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(<BadgeHarness {...props} />)
  })
  await flush()
}

const badgeText = () => container.querySelector('[data-testid="nav-badge"]')?.textContent || ''
const pulsingRows = () => container.querySelectorAll('.bee-inbox-row.bee-row-pulse').length
const rowCount = () => container.querySelectorAll('.bee-inbox-row').length

describe('the card rings as it lands', () => {
  it('an inserted row carries the arrival pulse', async () => {
    leadById['p-new'] = person({ id: 'p-new', name: 'Nora Vance' })
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [] })
    expect(pulsingRows()).toBe(0)

    await emit('INSERT', 'p-new')

    expect(text()).toContain('Nora Vance')
    expect(pulsingRows()).toBe(1)
  })

  it('rows that were already there do NOT ring — only the arrival', async () => {
    // The pulse says "this one is new". If every row rang, it would say nothing.
    leadById['p-new'] = person({ id: 'p-new', name: 'Nora Vance' })
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [person({ id: 'p-old', name: 'Old Olive' })] })

    await emit('INSERT', 'p-new')

    expect(rowCount()).toBe(2)
    expect(pulsingRows()).toBe(1)
  })

  it('spends _realtimePulse rather than a second highlight of its own', async () => {
    // Pinned as a SOURCE fact: the row must read the stamp the shared merge
    // sets. A row that grew its own "isNew" flag would pass the tests above
    // while quietly becoming the second mechanism this build was told not to
    // build — and would then drift from the merge that feeds every other lens.
    const src = readFileSync(join(process.cwd(), 'components/hive/InboxScreen.jsx'), 'utf8')
    expect(src).toContain('p._realtimePulse')
    expect(src).toContain('bee-row-pulse')
  })

  it('a stale stamp does not ring on a later remount', async () => {
    // _realtimePulse rides the person until the next refetch replaces it, so
    // without a freshness window the row would ring again every time it
    // remounted — a filter change, a band move, collapsing Dismissed.
    const stale = { ...person({ id: 'p-stale', name: 'Stale Stan' }), _realtimePulse: Date.now() - 60_000 }
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [stale] })
    expect(text()).toContain('Stale Stan')
    expect(pulsingRows()).toBe(0)
  })
})

describe('the badge moves with the band', () => {
  it('an INSERT moves the band count AND the nav badge together', async () => {
    leadById['p-new'] = person({ id: 'p-new', name: 'Nora Vance' })
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [] })
    expect(badgeText()).toBe('badge:0')
    // A wholly empty Inbox renders ONE empty state, not zeroed band headings.
    expect(text()).toContain('New inquiries land here')

    await emit('INSERT', 'p-new')

    expect(text()).toContain('New · 1')
    expect(badgeText()).toBe('badge:1') // the card and the count agree (#89)
  })

  it('an Attempting arrival moves the badge too — the badge is New + Attempting', async () => {
    leadById['p-new'] = person({ id: 'p-new', name: 'Nora Vance', outreachTimeline: [reachOut] })
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [] })

    await emit('INSERT', 'p-new')

    expect(text()).toContain('Attempting · 1')
    expect(badgeText()).toBe('badge:1')
  })
})

describe('an arrival the viewer may not see never leaks in', () => {
  it('an INSERT that arrives already JUNKED does not appear and is not counted', async () => {
    leadById['p-junk'] = person({ id: 'p-junk', name: 'Junk Jenny', isJunk: true })
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [] })

    await emit('INSERT', 'p-junk')

    expect(text()).not.toContain('Junk Jenny')
    // Still wholly empty — the junked arrival created no band at all.
    expect(text()).toContain('New inquiries land here')
    expect(badgeText()).toBe('badge:0')
    expect(rowCount()).toBe(0)
  })

  it('an INSERT that arrives already DISMISSED stays off the worklist and the badge', async () => {
    // Dismissed is a BAND, not a deletion (Courtney Grady) — the row is
    // reachable under a collapsed heading, which is deliberate. What must
    // never happen is it landing in New/Attempting or inflating the badge.
    leadById['p-dism'] = person({ id: 'p-dism', name: 'Dismissed Dana', inboxDismissedAt: daysAgo(1) })
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [] })

    await emit('INSERT', 'p-dism')

    expect(text()).toContain('New · 0')
    expect(text()).toContain('Attempting · 0')
    expect(badgeText()).toBe('badge:0')
    expect(rowCount()).toBe(0) // the band is collapsed by default
    expect(text()).toContain('Dismissed · 1') // by design, not on the worklist
  })

  it('an INSERT that arrives SNOOZED does not appear', async () => {
    leadById['p-snz'] = person({ id: 'p-snz', name: 'Snoozed Sam', snoozeUntil: new Date(now + 86400000).toISOString() })
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [] })

    await emit('INSERT', 'p-snz')

    expect(text()).not.toContain('Snoozed Sam')
    expect(badgeText()).toBe('badge:0')
  })

  it("another location's lead is not delivered, so nothing to exclude downstream", async () => {
    leadById['p-far'] = person({ id: 'p-far', name: 'Far Away', locationId: 'loc-uuid-9' })
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [] })

    await emit('INSERT', 'p-far', 'loc-uuid-9')

    expect(text()).not.toContain('Far Away')
    expect(badgeText()).toBe('badge:0')
    expect(leadFetches).toEqual([])
  })

  it("on 'all', a delivered lead outside the viewer's scope is still excluded by the shared predicate", async () => {
    // The mutation target. 'all' subscribes UNFILTERED, so exclusion here is
    // the PREDICATE's job, not the channel's — this is the case where letting
    // the insert past isSoftRemovedFromInbox would put a junked lead on a
    // worklist. Both the list and the badge must refuse it.
    leadById['p-junk'] = person({ id: 'p-junk', name: 'Junk Jenny', isJunk: true, locationId: 'loc-uuid-9' })
    await mountBadge({ locFilter: 'all', initialPeople: [] })

    await emit('INSERT', 'p-junk', 'loc-uuid-9')

    expect(text()).not.toContain('Junk Jenny')
    expect(badgeText()).toBe('badge:0')
  })

  it('the Inbox asks the SHARED predicate rather than re-deciding visibility', async () => {
    // Source pin: one opinion about what is hidden, shared with the badge.
    const src = readFileSync(join(process.cwd(), 'components/hive/InboxScreen.jsx'), 'utf8')
    expect(src).toContain('isSoftRemovedFromInbox(')
    // and the predicate really does hide these — the thing the rows rely on
    expect(isSoftRemovedFromInbox(person({ isJunk: true }), now)).toBe(true)
    expect(isSoftRemovedFromInbox(person({ inboxDismissedAt: daysAgo(1) }), now)).toBe(true)
    expect(isSoftRemovedFromInbox(person(), now)).toBe(false)
  })
})

describe('an INSERT racing a refetch renders one card, not two', () => {
  it('a server snapshot that already contains the arrival does not double it', async () => {
    // The real race: the INSERT lands live, then router.refresh() delivers a
    // fresh people array that ALSO contains the lead. Wholesale replacement,
    // so the id can only appear once — pinned because an append-based merge
    // (or a merge layered on top of the refresh) would show Nora twice.
    leadById['p-new'] = person({ id: 'p-new', name: 'Nora Vance' })
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [] })

    await emit('INSERT', 'p-new')
    expect(text()).toContain('New · 1')

    await act(async () => {
      root.render(<BadgeHarness locFilter="loc-uuid-1" serverRows={[person({ id: 'p-new', name: 'Nora Vance' })]} />)
    })
    await flush()

    expect(text()).toContain('New · 1')
    expect(badgeText()).toBe('badge:1')
    expect(rowCount()).toBe(1)
  })

  it('a duplicate INSERT burst for the same lead still renders one card', async () => {
    leadById['p-new'] = person({ id: 'p-new', name: 'Nora Vance' })
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [] })

    await emit('INSERT', 'p-new')
    await emit('INSERT', 'p-new')
    await emit('INSERT', 'p-new')

    expect(rowCount()).toBe(1)
    expect(text()).toContain('New · 1')
    expect(badgeText()).toBe('badge:1')
  })
})

describe('UPDATE and DELETE behave exactly as they did before this build', () => {
  it('an UPDATE replaces a row in place rather than adding one', async () => {
    leadById['p1'] = person({ name: 'Renamed Rita' })
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [person({ name: 'Sarah Mitchell' })] })
    expect(text()).toContain('Sarah Mitchell')

    await emit('UPDATE', 'p1')

    expect(text()).toContain('Renamed Rita')
    expect(text()).not.toContain('Sarah Mitchell')
    expect(rowCount()).toBe(1)
    expect(badgeText()).toBe('badge:1')
  })

  it('an UPDATE that adds a reach-out moves the row New → Attempting', async () => {
    leadById['p1'] = person({ outreachTimeline: [reachOut] })
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [person()] })
    expect(text()).toContain('New · 1')

    await emit('UPDATE', 'p1')

    expect(text()).toContain('New · 0')
    expect(text()).toContain('Attempting · 1')
    expect(badgeText()).toBe('badge:1') // still countable, different band
  })

  it('an UPDATE that junks a lead removes it from the list and the badge', async () => {
    leadById['p1'] = person({ isJunk: true })
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [person()] })
    expect(badgeText()).toBe('badge:1')

    await emit('UPDATE', 'p1')

    expect(rowCount()).toBe(0)
    expect(badgeText()).toBe('badge:0')
  })

  it('a DELETE drops the row and the badge follows — no refetch attempted', async () => {
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [person()] })
    expect(text()).toContain('Sarah Mitchell')
    expect(badgeText()).toBe('badge:1')

    await emit('DELETE', 'p1')

    expect(text()).not.toContain('Sarah Mitchell')
    expect(badgeText()).toBe('badge:0')
    expect(leadFetches).toEqual([]) // DELETE is terminal — nothing to enrich
  })

  it('a DELETE for a lead it never had is a no-op', async () => {
    await mountBadge({ locFilter: 'loc-uuid-1', initialPeople: [person()] })
    await emit('DELETE', 'p-unknown')
    expect(text()).toContain('Sarah Mitchell')
    expect(rowCount()).toBe(1)
  })
})

// ── what the old harness could not ask ────────────────────────────
// These are the tests the single-location `emit` made unwritable. They are
// the reason the update map said stage moves work "both ways" with high
// confidence: that confidence was about the CODE path — handleLeadsRealtime
// does not branch on what changed — and never about delivery.
describe('a lead CHANGING location is not carried by postgres_changes', () => {
  it('a transfer does not reach the RECEIVING location', async () => {
    // The observed bug, now expressible. The row's new state matches this
    // watcher's filter, but its old state does not, so nothing is delivered
    // and the card never appears. This is why the transfer route broadcasts.
    leadById['p-moved'] = person({ id: 'p-moved', name: 'Transferred Tess', locationId: 'loc-uuid-2' })
    await mount({ locFilter: 'loc-uuid-2', initialPeople: [] })

    await emit('UPDATE', 'p-moved', 'loc-uuid-2', { from: 'loc-uuid-1' })

    expect(text()).not.toContain('Transferred Tess')
    expect(leadFetches).toEqual([]) // never even refetched
  })

  it('a transfer does not reach the ORIGIN location either', async () => {
    // The mirror image, and the reason a third person watching the origin
    // never saw the lead leave: the old state matches, the new one does not.
    leadById['p1'] = person()
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })
    expect(text()).toContain('Sarah Mitchell')

    await emit('UPDATE', 'p1', 'loc-uuid-2', { from: 'loc-uuid-1' })

    expect(text()).toContain('Sarah Mitchell') // still there — nothing arrived
  })

  it('an ordinary same-location UPDATE is still delivered', async () => {
    // The control. Stage moves, name edits and dismissals do not change
    // location, so both states sit at this watcher's location and the event
    // lands — which is why those have always worked.
    leadById['p1'] = person({ name: 'Renamed Rita' })
    await mount({ locFilter: 'loc-uuid-1', initialPeople: [person()] })

    await emit('UPDATE', 'p1', 'loc-uuid-1')

    expect(text()).toContain('Renamed Rita')
    expect(leadFetches).toEqual(['p1'])
  })

  it("an 'all' watcher is unaffected — an unfiltered channel has no old/new to reconcile", async () => {
    // Corporate/admin subscribe UNFILTERED, so neither candidate explanation
    // (RLS on the old row, or filter semantics) keeps a transfer from them.
    leadById['p-moved'] = person({ id: 'p-moved', name: 'Transferred Tess', locationId: 'loc-uuid-2' })
    await mount({ locFilter: 'all', initialPeople: [] })

    await emit('UPDATE', 'p-moved', 'loc-uuid-2', { from: 'loc-uuid-1' })

    expect(text()).toContain('Transferred Tess')
  })
})
