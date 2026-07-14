// @vitest-environment node
//
// Per-project-type SENDER routing — CONFIG layer (data access, domain warning,
// one-per-type, access gate).
//
// Pins: getSenderConfig shape + verified-domain warnings; assignSenderToTypes
// upserts one row per type on the (location_id, project_type) key (so a type is
// never on two senders — one-per-type); unassignTypes deletes; the split toggle
// write; and the owner+elevated-only access predicate (manager rejected).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = { queue: [] as { table: string; resp: Resp }[], calls: [] as Call[] }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'is', 'in', 'limit', 'order']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const callsFor = (t: string) => state.calls.filter(c => c.table === t)
  const opsOf = (call: { ops: [string, any[]][] }, m: string) => call.ops.filter(o => o[0] === m)
  const upsertPayloads = (t: string) => callsFor(t).flatMap(c => opsOf(c, 'upsert').map(o => o[1][0]))
  const updatePayloads = (t: string) => callsFor(t).flatMap(c => opsOf(c, 'update').map(o => o[1][0]))
  return { state, reset, enqueue, makeBuilder, callsFor, opsOf, upsertPayloads, updatePayloads }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))

import {
  emailDomain,
  senderDomainWarning,
  getSenderConfig,
  assignSenderToTypes,
  unassignTypes,
  setSplitEnabled,
} from '@/lib/project-type-senders'
import { notificationRecipientsManageableServer } from '@/lib/notification-access'

const LOC = 'loc-uuid-1'

beforeEach(() => { h.reset(); vi.clearAllMocks() })

describe('verified-domain heuristic', () => {
  it('emailDomain extracts the lowercased domain', () => {
    expect(emailDomain('A@Boulder.BeeOrganized.com')).toBe('boulder.beeorganized.com')
    expect(emailDomain('nope')).toBeNull()
    expect(emailDomain(null)).toBeNull()
  })
  it('warns when the sender domain differs from the base sender domain', () => {
    const bs = 'org@boulder.beeorganized.com'
    expect(senderDomainWarning('bree@boulder.beeorganized.com', bs)).toBe(false)
    expect(senderDomainWarning('bree@gmail.com', bs)).toBe(true)
  })
  it('does not warn when either side is unknown (no false alarms)', () => {
    expect(senderDomainWarning('bree@gmail.com', null)).toBe(false)
    expect(senderDomainWarning(null, 'org@x.com')).toBe(false)
  })
})

describe('getSenderConfig', () => {
  it('assembles toggle + base + types + assignments + people, with domain warnings', async () => {
    h.enqueue('locations', { split_senders_enabled: true, send_from_email: 'org@boulder.beeorganized.com' })
    h.enqueue('lookups', [
      { label: 'Local Move', sort_order: 10 },
      { label: 'Home Organizing', sort_order: 20 },
    ])
    h.enqueue('location_project_type_senders', [
      { id: 'a1', project_type: 'Local Move', sender_name: 'Bree', sender_email: 'bree@boulder.beeorganized.com', sender_reply_to: null, source_user_id: 'u1' },
    ])
    h.enqueue('hub_users', [
      { id: 'u1', full_name: 'Bree Mover', first_name: 'Bree', last_name: 'Mover', email: 'bree@boulder.beeorganized.com', role: 'manager', location_id: LOC },
      { id: 'u2', full_name: 'Gary Gmail', first_name: 'Gary', last_name: 'Gmail', email: 'gary@gmail.com', role: 'manager', location_id: LOC },
    ])

    const cfg = await getSenderConfig(LOC)

    expect(cfg.enabled).toBe(true)
    expect(cfg.base_sender_domain).toBe('boulder.beeorganized.com')
    expect(cfg.project_types).toEqual(['Local Move', 'Home Organizing'])
    expect(cfg.assignments).toHaveLength(1)
    expect(cfg.assignments[0]).toMatchObject({ project_type: 'Local Move', domain_warning: false })
    // Person on gmail is flagged; person on the base domain is not.
    const gary = cfg.people.find(p => p.id === 'u2')
    const bree = cfg.people.find(p => p.id === 'u1')
    expect(gary?.domain_warning).toBe(true)
    expect(bree?.domain_warning).toBe(false)
  })

  it('defaults enabled to false when the column/row is absent', async () => {
    h.enqueue('locations', null)
    h.enqueue('lookups', [])
    h.enqueue('location_project_type_senders', [])
    h.enqueue('hub_users', [])
    const cfg = await getSenderConfig(LOC)
    expect(cfg.enabled).toBe(false)
    expect(cfg.base_sender_email).toBeNull()
  })
})

describe('assignSenderToTypes — one-per-type upsert', () => {
  it('upserts ONE row per type on the (location_id, project_type) conflict key', async () => {
    h.enqueue('location_project_type_senders', null) // upsert result
    await assignSenderToTypes(
      LOC,
      { sender_name: 'Bree', sender_email: 'bree@x.com', sender_reply_to: null, source_user_id: 'u1' },
      ['Local Move', 'Long-Distance Move'],
    )
    const payloads = h.upsertPayloads('location_project_type_senders')
    expect(payloads).toHaveLength(1)
    const rows = payloads[0]
    expect(rows).toHaveLength(2)
    expect(rows.map((r: any) => r.project_type)).toEqual(['Local Move', 'Long-Distance Move'])
    // every row carries the same sender + the location.
    for (const r of rows) {
      expect(r).toMatchObject({ location_id: LOC, sender_email: 'bree@x.com', source_user_id: 'u1' })
    }
    // onConflict target enforces one-per-type.
    const call = h.callsFor('location_project_type_senders')[0]
    const upsertArgs = call.ops.find(o => o[0] === 'upsert')![1]
    expect(upsertArgs[1]).toMatchObject({ onConflict: 'location_id,project_type' })
  })

  it('no-ops on an empty type list', async () => {
    await assignSenderToTypes(LOC, { sender_name: 'x', sender_email: 'x@x.com', sender_reply_to: null, source_user_id: null }, [])
    expect(h.callsFor('location_project_type_senders')).toHaveLength(0)
  })
})

describe('unassignTypes + setSplitEnabled', () => {
  it('unassignTypes deletes the given types for the location', async () => {
    h.enqueue('location_project_type_senders', null)
    await unassignTypes(LOC, ['Local Move'])
    const call = h.callsFor('location_project_type_senders')[0]
    expect(call.ops.some(o => o[0] === 'delete')).toBe(true)
    expect(call.ops).toContainEqual(['in', ['project_type', ['Local Move']]])
  })

  it('setSplitEnabled writes the toggle', async () => {
    h.enqueue('locations', null)
    await setSplitEnabled(LOC, true)
    expect(h.updatePayloads('locations')).toEqual([{ split_senders_enabled: true }])
  })
})

describe('access gate — owner + elevated only (manager rejected)', () => {
  it('elevated may manage any location', () => {
    expect(notificationRecipientsManageableServer('super_admin', 'locX', LOC)).toBe(true)
    expect(notificationRecipientsManageableServer('admin', null, LOC)).toBe(true)
  })
  it('owner may manage only their own location', () => {
    expect(notificationRecipientsManageableServer('owner', LOC, LOC)).toBe(true)
    expect(notificationRecipientsManageableServer('owner', 'other', LOC)).toBe(false)
  })
  it('MANAGER and lite_user are rejected even at their own location', () => {
    expect(notificationRecipientsManageableServer('manager', LOC, LOC)).toBe(false)
    expect(notificationRecipientsManageableServer('lite_user', LOC, LOC)).toBe(false)
  })
})
