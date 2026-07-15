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
const emit = async (eventType: string, id: string, locationUuid = 'loc-uuid-1') => {
  const ch = channels[channels.length - 1]
  const want = ch.config.filter
  if (want && want !== `location_uuid=eq.${locationUuid}`) return // not delivered
  await act(async () => {
    ch.handler({ eventType, new: { id, location_uuid: locationUuid }, old: { id, location_uuid: locationUuid } })
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
