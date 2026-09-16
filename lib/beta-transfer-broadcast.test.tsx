// @vitest-environment happy-dom
//
// TRANSFERRED LEAD REACHES BOTH ENDS — the card appears for the receiving
// location and leaves the origin, with no reload.
//
// WHY A BROADCAST AND NOT postgres_changes. Kevin ran a two-browser test as
// two different users: the lead left the sending screen at once (his own
// browser, acting locally) and never reached the receiving one until a reload.
// For an UPDATE, Supabase must be able to show the row to the subscriber in
// BOTH its old and new state before it delivers; the leads SELECT policy is
// location-scoped, so before the move the lead sits where the receiving user
// cannot see it. beta-leads-realtime now pins that shape directly.
//
// THAT DIAGNOSIS IS NOT PROVEN, and this build does not rest on it. The
// transfer route tells the destination directly, so the card appears whatever
// postgres_changes did or did not do. The row path is untouched, and both
// paths end in the SAME refetch and the SAME upsertRealtimePerson, which
// dedupes by id — so if the row event does arrive after all (an admin, or a
// wrong diagnosis), the lead renders once, not twice.
// Pins:
//   · a receiving-location watcher gains the card
//   · an origin-location watcher who did NOT do the transfer loses it
//   · both signals for one lead render ONE card
//   · normal→normal behaves exactly like loc_other→normal
//   · an unrelated location sees nothing
//   · the unrouted queue (transferPeople) empties, including on 'all'
//   · the server helper addresses origin, destination and 'all'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import InboxScreen from '@/components/hive/InboxScreen'
import { upsertRealtimePerson, removeRealtimePerson } from '@/components/hive/shared/leadsRealtime'
import { locationTopic, LEAD_MOVED_EVENT } from '@/lib/realtime-broadcast'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__BEE_TEST_WIDTH__ = 1200

const { channels, removed, cfg } = vi.hoisted(() => ({
  channels: [] as any[],
  removed: [] as any[],
  cfg: { throwOnCreate: false },
}))

vi.mock('@/lib/supabase', () => ({
  createClient: () => {
    if (cfg.throwOnCreate) throw new Error('no supabase env')
    return {
      channel: (name: string) => {
        const ch: any = { name, kind: null, config: null, handler: null, subscribed: false }
        ch.on = (kind: string, config: any, handler: any) => {
          ch.kind = kind; ch.config = config; ch.handler = handler; return ch
        }
        ch.subscribe = () => { ch.subscribed = true; return ch }
        channels.push(ch)
        return ch
      },
      // The channel is opened through use-realtime-channel, which awaits
      // supabase.realtime.setAuth() so the join carries the access token.
      // Without this the hook's try/catch would swallow a TypeError and these
      // suites would go on passing while every channel joined ANONYMOUSLY —
      // which is the exact failure beta-realtime-auth exists to catch.
      realtime: { setAuth: async () => {} },
      removeChannel: (ch: any) => { removed.push(ch) },
    }
  },
}))

import { useLeadsRealtime } from '@/lib/use-leads-realtime'
import { useLocationBroadcast } from '@/lib/use-location-broadcast'

const LOC_A = 'loc-uuid-a'        // a normal location
const LOC_B = 'loc-uuid-b'        // another normal location
const LOC_OTHER = 'loc-uuid-other' // the unrouted holding pen
const LOC_FAR = 'loc-uuid-far'    // nothing to do with any of it

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 86400000).toISOString()

const person = (over: any = {}) => ({
  id: 'p1', name: 'Transferred Tess', email: 't@email.com', phone: '(561) 555-0101',
  locationId: LOC_B, created: daysAgo(2), isJunk: false, snoozeUntil: null,
  inboxDismissedAt: null, jobberRef: null, paidAmount: 0, source: 'webform',
  outreachTimeline: [], ...over,
})

// ── the harness: BeeHub's wiring, transcribed ─────────────────────
// BeeHub is 38k lines and cannot be mounted. The source sweep at the bottom
// pins that the real component still wires it this way — in particular that
// the broadcast ARRIVAL reuses handleLeadsRealtime rather than growing a
// second refetch-and-merge path, which is what makes the dedupe shared.
function Harness({ locFilter, initialPeople = [] as any[], initialTransferPeople = [] as any[], onReady }: any) {
  const [people, setPeople] = React.useState(initialPeople)
  const [transferPeople, setTransferPeople] = React.useState(initialTransferPeople)

  const handleLeadsRealtime = React.useCallback(async ({ type, leadId }: any) => {
    if (type === 'DELETE') { setPeople(prev => removeRealtimePerson(prev, leadId)); return }
    const res = await fetch(`/api/leads/${leadId}`, { credentials: 'include' })
    if (!res.ok) return
    const { person: fresh } = await res.json()
    if (!fresh) return
    setPeople(prev => upsertRealtimePerson(prev, fresh, Date.now()))
  }, [])

  const handleLeadMoved = React.useCallback(({ leadId, fromLocationUuid, toLocationUuid }: any) => {
    setTransferPeople(prev => prev.some((p: any) => p.id === leadId) ? prev.filter((p: any) => p.id !== leadId) : prev)
    if (locFilter === 'all') return
    if (fromLocationUuid === locFilter) { setPeople(prev => removeRealtimePerson(prev, leadId)); return }
    if (toLocationUuid === locFilter) { handleLeadsRealtime({ type: 'UPDATE', leadId }) }
  }, [locFilter, handleLeadsRealtime])

  useLeadsRealtime(locFilter, handleLeadsRealtime)
  useLocationBroadcast(locFilter, handleLeadMoved)

  onReady?.({ people, transferPeople })
  return <InboxScreen people={people} transferPeople={transferPeople} engagements={[]} locFilter={locFilter} />
}

let container: HTMLDivElement
let root: Root
let leadFetches: string[] = []
let leadById: Record<string, any> = {}
let latest: any = null

const installFetch = () => {
  leadFetches = []
  ;(globalThis as any).fetch = vi.fn(async (url: any) => {
    const m = String(url).match(/\/api\/leads\/([^/?]+)$/)
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
    root.render(<Harness {...props} onReady={(v: any) => { latest = v }} />)
  })
  await flush()
}

// Deliver a broadcast the way Realtime would: ONLY to a channel actually
// subscribed to that topic. A test that called the handler blind would pass
// even with the topic wrong, which is the whole scoping question here.
const broadcastTo = async (topic: string, payload: any) => {
  const ch = channels.find((c: any) => c.name === topic && c.kind === 'broadcast')
  if (!ch) return // nobody here is listening to that topic
  await act(async () => { ch.handler({ event: LEAD_MOVED_EVENT, payload }) })
  await flush()
  await flush()
}

// What the transfer route sends: origin, destination, and the all-locations
// view, in one call.
const transfer = async (leadId: string, from: string, to: string) => {
  const payload = { leadId, fromLocationUuid: from, toLocationUuid: to }
  for (const t of [locationTopic(from), locationTopic(to), locationTopic('all')]) {
    await broadcastTo(t, payload)
  }
}

// The postgres_changes path, for the convergence test — as if the row event
// HAD been delivered (an admin, or the diagnosis being wrong).
const rowEvent = async (leadId: string, locationUuid: string) => {
  const ch = channels.find((c: any) => c.kind === 'postgres_changes')
  if (!ch) return
  const want = ch.config.filter
  if (want && want !== `location_uuid=eq.${locationUuid}`) return
  await act(async () => {
    ch.handler({ eventType: 'UPDATE', new: { id: leadId, location_uuid: locationUuid }, old: { id: leadId, location_uuid: locationUuid } })
  })
  await flush()
  await flush()
}

const text = () => container.textContent || ''
const rowCount = () => container.querySelectorAll('.bee-inbox-row').length
const countOf = (s: string) => text().split(s).length - 1

beforeEach(() => {
  installFetch()
  channels.length = 0
  removed.length = 0
  cfg.throwOnCreate = false
  leadById = {}
  latest = null
})

afterEach(async () => {
  if (root) await act(async () => { root.unmount() })
  ;(root as any) = null
  container?.remove()
  vi.restoreAllMocks()
})

describe('the receiving location gains the card', () => {
  it('a transfer out of loc_other makes the card appear, live', async () => {
    leadById['p1'] = person({ locationId: LOC_B })
    await mount({ locFilter: LOC_B, initialPeople: [] })
    expect(text()).not.toContain('Transferred Tess')

    await transfer('p1', LOC_OTHER, LOC_B)

    expect(text()).toContain('Transferred Tess')
    expect(text()).toContain('New · 1')
    expect(leadFetches).toEqual(['p1']) // enriched refetch, not raw payload
  })

  it('a transfer between two NORMAL locations behaves the same', async () => {
    // Kevin's test was loc_other → loc_test. loc_other is not special to this
    // failure: the origin is always a location the receiver cannot see.
    leadById['p1'] = person({ locationId: LOC_B })
    await mount({ locFilter: LOC_B, initialPeople: [] })

    await transfer('p1', LOC_A, LOC_B)

    expect(text()).toContain('Transferred Tess')
    expect(text()).toContain('New · 1')
  })

  it('subscribes to its own location topic', async () => {
    await mount({ locFilter: LOC_B, initialPeople: [] })
    const bc = channels.filter((c: any) => c.kind === 'broadcast')
    expect(bc).toHaveLength(1)
    expect(bc[0].name).toBe(`location:${LOC_B}`)
    expect(bc[0].config.event).toBe(LEAD_MOVED_EVENT)
    expect(bc[0].subscribed).toBe(true)
  })
})

describe('the origin location loses the card', () => {
  it('an origin watcher who did NOT do the transfer sees the row leave', async () => {
    await mount({ locFilter: LOC_A, initialPeople: [person({ locationId: LOC_A })] })
    expect(text()).toContain('Transferred Tess')

    await transfer('p1', LOC_A, LOC_B)

    expect(text()).not.toContain('Transferred Tess')
    expect(rowCount()).toBe(0)
  })

  it('it does NOT refetch a lead it is losing', async () => {
    // Refetching would 403 for this viewer now the lead has left — and there
    // is nothing to show anyway.
    await mount({ locFilter: LOC_A, initialPeople: [person({ locationId: LOC_A })] })

    await transfer('p1', LOC_A, LOC_B)

    expect(leadFetches).toEqual([])
  })

  it('the unrouted queue empties for a loc_other watcher', async () => {
    // transferPeople is separate state that NO realtime path ever wrote —
    // the sending-side half of this gap.
    await mount({
      locFilter: LOC_OTHER,
      initialPeople: [],
      initialTransferPeople: [person({ id: 'p1', atLocOther: true, locationId: LOC_OTHER })],
    })
    expect(latest.transferPeople).toHaveLength(1)

    await transfer('p1', LOC_OTHER, LOC_B)

    expect(latest.transferPeople).toHaveLength(0)
  })

  it("the unrouted queue empties on 'all', where corp actually works it", async () => {
    // 'all' loads no per-location records, so the transfer queue is the whole
    // of what that view shows — and it cannot enumerate every location topic,
    // which is why the server addresses `location:all` explicitly.
    await mount({
      locFilter: 'all',
      initialPeople: [],
      initialTransferPeople: [person({ id: 'p1', atLocOther: true, locationId: LOC_OTHER })],
    })
    expect(latest.transferPeople).toHaveLength(1)

    await transfer('p1', LOC_OTHER, LOC_B)

    expect(latest.transferPeople).toHaveLength(0)
  })
})

describe('ONE card, not two, when both signals arrive', () => {
  it('the broadcast and a postgres_changes event for the same lead render once', async () => {
    // If the row event does arrive after all — for an admin, or because the
    // RLS diagnosis is wrong — both paths end in the same merge.
    leadById['p1'] = person({ locationId: LOC_B })
    await mount({ locFilter: LOC_B, initialPeople: [] })

    await transfer('p1', LOC_A, LOC_B)
    await rowEvent('p1', LOC_B)

    expect(countOf('Transferred Tess')).toBe(1)
    expect(rowCount()).toBe(1)
    expect(text()).toContain('New · 1')
  })

  it('the same broadcast arriving twice renders once', async () => {
    leadById['p1'] = person({ locationId: LOC_B })
    await mount({ locFilter: LOC_B, initialPeople: [] })

    await transfer('p1', LOC_A, LOC_B)
    await transfer('p1', LOC_A, LOC_B)

    expect(rowCount()).toBe(1)
    expect(text()).toContain('New · 1')
  })

  it('a lead already on screen is replaced, not appended', async () => {
    // The transferring user's own browser, which already has the row.
    leadById['p1'] = person({ locationId: LOC_B, name: 'Transferred Tess' })
    await mount({ locFilter: LOC_B, initialPeople: [person({ locationId: LOC_B })] })
    expect(rowCount()).toBe(1)

    await transfer('p1', LOC_A, LOC_B)

    expect(rowCount()).toBe(1)
  })
})

describe('scope', () => {
  it('an unrelated location sees nothing', async () => {
    leadById['p1'] = person({ locationId: LOC_B })
    await mount({ locFilter: LOC_FAR, initialPeople: [] })

    await transfer('p1', LOC_A, LOC_B)

    expect(text()).not.toContain('Transferred Tess')
    expect(leadFetches).toEqual([])
    expect(rowCount()).toBe(0)
  })

  it('the person doing the transfer still sees what they see today', async () => {
    // Their own browser removed the row locally (the Inbox's transferredIds
    // session set). The broadcast then reaches them as an origin watcher, and
    // removeRealtimePerson is a no-op on a row already gone — no crash, no
    // resurrection, no duplicate.
    await mount({ locFilter: LOC_A, initialPeople: [] }) // already removed locally

    await transfer('p1', LOC_A, LOC_B)

    expect(rowCount()).toBe(0)
    expect(text()).not.toContain('Transferred Tess')
  })

  it('subscribes to nothing before a location vocabulary exists', async () => {
    await mount({ locFilter: null, initialPeople: [] })
    expect(channels.filter((c: any) => c.kind === 'broadcast')).toHaveLength(0)
  })

  it('tears down the broadcast channel on unmount', async () => {
    await mount({ locFilter: LOC_B, initialPeople: [] })
    const bc = channels.find((c: any) => c.kind === 'broadcast')
    await act(async () => { root.unmount() })
    ;(root as any) = null
    expect(removed).toContain(bc)
  })

  it('renders the Inbox anyway when the supabase client cannot be created', async () => {
    cfg.throwOnCreate = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await mount({ locFilter: LOC_B, initialPeople: [person({ locationId: LOC_B })] })
    expect(text()).toContain('Transferred Tess')
    expect(err).toHaveBeenCalled()
  })

  it('ignores a malformed payload', async () => {
    await mount({ locFilter: LOC_B, initialPeople: [] })
    const ch = channels.find((c: any) => c.kind === 'broadcast')
    await act(async () => {
      ch.handler({ event: LEAD_MOVED_EVENT, payload: { leadId: null, toLocationUuid: LOC_B } })
      ch.handler({ event: LEAD_MOVED_EVENT, payload: { leadId: 'p1' } }) // no destination
      ch.handler({ event: LEAD_MOVED_EVENT })
    })
    await flush()
    expect(leadFetches).toEqual([])
  })
})

// ── the server half ───────────────────────────────────────────────
describe('broadcastLeadMoved addresses both ends and the all view', () => {
  const ORIGINAL_ENV = { ...process.env }
  let posts: any[] = []

  beforeEach(() => {
    posts = []
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    ;(globalThis as any).fetch = vi.fn(async (url: any, init: any) => {
      posts.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers })
      return { ok: true, status: 202, json: async () => ({}) } as any
    })
  })
  afterEach(() => { process.env = { ...ORIGINAL_ENV } })

  it('posts one REST request naming origin, destination and all', async () => {
    const { broadcastLeadMoved } = await import('@/lib/realtime-broadcast')
    const ok = await broadcastLeadMoved({ leadId: 'p1', fromLocationUuid: LOC_OTHER, toLocationUuid: LOC_B })

    expect(ok).toBe(true)
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe('https://proj.supabase.co/realtime/v1/api/broadcast')
    expect(posts[0].headers.apikey).toBe('service-key')
    expect(posts[0].body.messages.map((m: any) => m.topic)).toEqual([
      `location:${LOC_OTHER}`, `location:${LOC_B}`, 'location:all',
    ])
    expect(posts[0].body.messages.every((m: any) => m.event === LEAD_MOVED_EVENT)).toBe(true)
  })

  it('carries IDS ONLY — the topic is public, so nothing private may ride it', async () => {
    const { broadcastLeadMoved } = await import('@/lib/realtime-broadcast')
    await broadcastLeadMoved({ leadId: 'p1', fromLocationUuid: LOC_A, toLocationUuid: LOC_B })

    const payload = posts[0].body.messages[0].payload
    expect(Object.keys(payload).sort()).toEqual(['fromLocationUuid', 'leadId', 'toLocationUuid'])
  })

  it('is BEST EFFORT — a failed or throwing send reports false, never raises', async () => {
    const { broadcastLeadMoved } = await import('@/lib/realtime-broadcast')
    ;(globalThis as any).fetch = vi.fn(async () => ({ ok: false, status: 500 }) as any)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await broadcastLeadMoved({ leadId: 'p1', fromLocationUuid: LOC_A, toLocationUuid: LOC_B })).toBe(false)

    ;(globalThis as any).fetch = vi.fn(async () => { throw new Error('network down') })
    expect(await broadcastLeadMoved({ leadId: 'p1', fromLocationUuid: LOC_A, toLocationUuid: LOC_B })).toBe(false)
    expect(err).toHaveBeenCalled()
  })

  it('a lead with no origin still reaches its destination', async () => {
    const { broadcastLeadMoved } = await import('@/lib/realtime-broadcast')
    await broadcastLeadMoved({ leadId: 'p1', fromLocationUuid: null, toLocationUuid: LOC_B })
    expect(posts[0].body.messages.map((m: any) => m.topic)).toEqual([`location:${LOC_B}`, 'location:all'])
  })
})

// ── source sweep ──────────────────────────────────────────────────
describe('the app is wired to the seams this suite tests', () => {
  const beeHub = readFileSync(join(process.cwd(), 'components/BeeHub.jsx'), 'utf8')
  const route = readFileSync(join(process.cwd(), 'app/api/leads/[id]/transfer/route.ts'), 'utf8')

  it('the transfer route broadcasts the move', () => {
    expect(route).toContain('broadcastLeadMoved({')
    expect(route).toContain('fromLocationUuid: existing.location_uuid')
    expect(route).toContain('toLocationUuid: dest.id')
  })

  it('a failed broadcast is a warning, never a failed transfer', () => {
    expect(route).toContain("warnings.push('live_broadcast_failed')")
  })

  it('BeeHub subscribes and reuses the ONE refetch-and-merge path', () => {
    expect(beeHub).toContain('useLocationBroadcast(locFilter, handleLeadMoved)')
    // Reuse, not a second path — this is what makes the dedupe shared.
    expect(beeHub).toContain("handleLeadsRealtime({ type: 'UPDATE', leadId })")
  })

  it('the postgres_changes path is untouched — both routes still exist', () => {
    expect(beeHub).toContain('useLeadsRealtime(locFilter, handleLeadsRealtime)')
    const hook = readFileSync(join(process.cwd(), 'lib/use-leads-realtime.ts'), 'utf8')
    expect(hook).toContain("event: '*'")
  })

  it('the origin half writes transferPeople, which nothing realtime did before', () => {
    expect(beeHub).toContain('setTransferPeople(prev => prev.some(p => p.id === leadId)')
  })

  it('the merge both paths share still dedupes by id', () => {
    const merge = readFileSync(join(process.cwd(), 'components/hive/shared/leadsRealtime.js'), 'utf8')
    expect(merge).toContain('const i = prev.findIndex(p => p.id === person.id)')
  })
})
