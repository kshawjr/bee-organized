// @vitest-environment node
//
// Per-project-type SENDER routing — CONFIG layer (data access, domain warning,
// one-per-type, access gate).
//
// Pins: getSenderConfig shape + verified-domain warnings; setHandlerForTypes
// upserts one row per type on the (location_id, project_type) key (so a type is
// never on two senders — one-per-type) WITHOUT disturbing what the type sends
// as; setSenderIdentityForType sets the sending identity WITHOUT reassigning;
// getPickableHandler refuses a person who is not pickable here; unassignTypes
// deletes; nothing writes a split_* flag; and the owner+elevated-only access
// predicate (manager rejected).
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
  setHandlerForTypes,
  setSenderIdentityForType,
  getPickableHandler,
  unassignTypes,
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
  it('assembles base + types + assignments + people, with domain warnings', async () => {
    // issue 246 step 2 — no `enabled` in the payload: split_senders_enabled is
    // retired and "no handler row" is the off state, per type.
    h.enqueue('locations', { send_from_email: 'org@boulder.beeorganized.com' })
    h.enqueue('lookups', [
      { label: 'Local Move', sort_order: 10, attrs: { drip_category: 'move' } },
      { label: 'Home Organizing', sort_order: 20, attrs: { drip_category: 'general' } },
    ])
    h.enqueue('location_project_type_senders', [
      { id: 'a1', project_type: 'Local Move', sender_name: 'Bree', sender_email: 'bree@boulder.beeorganized.com', sender_reply_to: null, source_user_id: 'u1' },
    ])
    h.enqueue('hub_users', [
      { id: 'u1', full_name: 'Bree Mover', first_name: 'Bree', last_name: 'Mover', email: 'bree@boulder.beeorganized.com', role: 'manager', location_id: LOC },
      { id: 'u2', full_name: 'Gary Gmail', first_name: 'Gary', last_name: 'Gmail', email: 'gary@gmail.com', role: 'manager', location_id: LOC },
    ])

    const cfg = await getSenderConfig(LOC)

    expect(cfg).not.toHaveProperty('enabled')
    expect(cfg.base_sender_domain).toBe('boulder.beeorganized.com')
    expect(cfg.project_types).toEqual(['Local Move', 'Home Organizing'])
    // Grouped for the section's Organizing / Moving split, from lookups attrs.
    expect(cfg.project_type_groups).toEqual([
      { label: 'Local Move', drip_category: 'move' },
      { label: 'Home Organizing', drip_category: 'general' },
    ])
    expect(cfg.assignments).toHaveLength(1)
    expect(cfg.assignments[0]).toMatchObject({ project_type: 'Local Move', domain_warning: false })
    // Person on gmail is flagged; person on the base domain is not.
    const gary = cfg.people.find(p => p.id === 'u2')
    const bree = cfg.people.find(p => p.id === 'u1')
    expect(gary?.domain_warning).toBe(true)
    expect(bree?.domain_warning).toBe(false)
  })

  it('degrades cleanly when the location row is absent', async () => {
    h.enqueue('locations', null)
    h.enqueue('lookups', [])
    h.enqueue('location_project_type_senders', [])
    h.enqueue('hub_users', [])
    const cfg = await getSenderConfig(LOC)
    expect(cfg.base_sender_email).toBeNull()
    expect(cfg.assignments).toEqual([])
  })
})

const BREE = { source_user_id: 'u1', name: 'Bree', email: 'bree@x.com' }

describe('setHandlerForTypes — one-per-type upsert', () => {
  it('upserts ONE row per type on the (location_id, project_type) conflict key', async () => {
    // issue 246 step 2 — labels are canonicalized against lookups before the
    // write, so the stored value is exactly what lookups spells.
    h.enqueue('lookups', [
      { label: 'Local Move', sort_order: 10, attrs: { drip_category: 'move' } },
      { label: 'Long-Distance Move', sort_order: 20, attrs: { drip_category: 'move' } },
    ])
    h.enqueue('location_project_type_senders', [])   // existing-rows read
    h.enqueue('location_project_type_senders', null) // upsert result
    await setHandlerForTypes(LOC, BREE, ['Local Move', 'Long-Distance Move'])
    const payloads = h.upsertPayloads('location_project_type_senders')
    expect(payloads).toHaveLength(1)
    const rows = payloads[0]
    expect(rows).toHaveLength(2)
    expect(rows.map((r: any) => r.project_type)).toEqual(['Local Move', 'Long-Distance Move'])
    // every row carries the same handler + the location, and person mode.
    for (const r of rows) {
      expect(r).toMatchObject({
        location_id: LOC, sender_email: 'bree@x.com', source_user_id: 'u1', sender_is_custom: false,
      })
    }
    // onConflict target enforces one-per-type.
    const upsertCall = h.callsFor('location_project_type_senders').find(c => c.ops.some(o => o[0] === 'upsert'))!
    const upsertArgs = upsertCall.ops.find(o => o[0] === 'upsert')![1]
    expect(upsertArgs[1]).toMatchObject({ onConflict: 'location_id,project_type' })
  })

  it('no-ops on an empty type list', async () => {
    await setHandlerForTypes(LOC, BREE, [])
    expect(h.callsFor('location_project_type_senders')).toHaveLength(0)
  })

  it('a case-variant label is stored CANONICALLY, not as typed', async () => {
    // The write half of "canonicalize at the boundary, then match exactly".
    // Without it the DB's ..._loc_type_ci_idx would be the only thing between
    // two case-variant handler rows and a silently broken one-per-type rule.
    h.enqueue('lookups', [{ label: 'Local Move', sort_order: 10, attrs: { drip_category: 'move' } }])
    h.enqueue('location_project_type_senders', [])
    h.enqueue('location_project_type_senders', null)
    await setHandlerForTypes(LOC, BREE, ['  local MOVE '])
    expect(h.upsertPayloads('location_project_type_senders')[0][0].project_type).toBe('Local Move')
  })

  it('REJECTS an unknown project type rather than storing an unmatchable row', async () => {
    h.enqueue('lookups', [{ label: 'Local Move', sort_order: 10, attrs: { drip_category: 'move' } }])
    await expect(setHandlerForTypes(LOC, BREE, ['Nonsense Type']))
      .rejects.toThrow(/unknown project type/)
    expect(h.callsFor('location_project_type_senders')).toHaveLength(0)
  })

  it('REJECTS a handler with no person — an assignee cannot be an email address', async () => {
    await expect(setHandlerForTypes(LOC, { ...BREE, source_user_id: '' }, ['Local Move']))
      .rejects.toThrow(/must be a person/)
  })

  // ── THE SILENT WIPE (issue 296) ───────────────────────────────────────────
  // The regression this whole split exists to prevent. The old combined writer
  // rebuilt the whole row from a payload the UI never populated, so every save
  // wrote sender_reply_to: null — which is why the column had a validator, a
  // persist path and zero non-null rows in production for its entire life.
  it('re-picking a handler does NOT wipe a typed sender or its reply-to', async () => {
    h.enqueue('lookups', [{ label: 'Local Move', sort_order: 10, attrs: { drip_category: 'move' } }])
    h.enqueue('location_project_type_senders', [
      {
        project_type: 'Local Move',
        sender_name: 'Bee Organized Moving',
        sender_email: 'moving@beeorganized-kc.com',
        sender_reply_to: 'carol@beeorganized.com',
        sender_is_custom: true,
      },
    ])
    h.enqueue('location_project_type_senders', null)

    // Move the type from Carol to Bree. The From line is not part of that.
    await setHandlerForTypes(LOC, BREE, ['Local Move'])

    const row = h.upsertPayloads('location_project_type_senders')[0][0]
    expect(row).toMatchObject({
      source_user_id: 'u1',                            // the handler DID change
      sender_is_custom: true,                          // and the identity did NOT
      sender_name: 'Bee Organized Moving',
      sender_email: 'moving@beeorganized-kc.com',
      sender_reply_to: 'carol@beeorganized.com',
    })
  })

  it('re-picking a handler DOES re-snapshot a person-mode row', async () => {
    // The other half of the same rule: person mode means "send as the handler",
    // so a new handler must bring their own name and address with them.
    h.enqueue('lookups', [{ label: 'Local Move', sort_order: 10, attrs: { drip_category: 'move' } }])
    h.enqueue('location_project_type_senders', [
      {
        project_type: 'Local Move',
        sender_name: 'Carol', sender_email: 'carol@x.com',
        sender_reply_to: null, sender_is_custom: false,
      },
    ])
    h.enqueue('location_project_type_senders', null)
    await setHandlerForTypes(LOC, BREE, ['Local Move'])
    expect(h.upsertPayloads('location_project_type_senders')[0][0]).toMatchObject({
      source_user_id: 'u1', sender_name: 'Bree', sender_email: 'bree@x.com', sender_is_custom: false,
    })
  })
})

describe('setSenderIdentityForType — WHAT IT SENDS AS, and only that', () => {
  it('stores a typed name, address and reply-to without touching the handler', async () => {
    h.enqueue('lookups', [{ label: 'Local Move', sort_order: 10, attrs: { drip_category: 'move' } }])
    h.enqueue('location_project_type_senders', { id: 'row1', source_user_id: 'u1' })
    h.enqueue('location_project_type_senders', null)
    await setSenderIdentityForType(LOC, 'Local Move', {
      sender_is_custom: true,
      sender_name: 'Bee Organized Moving',
      sender_email: 'moving@beeorganized-kc.com',
      sender_reply_to: 'carol@beeorganized.com',
    })
    const patch = h.updatePayloads('location_project_type_senders')[0]
    expect(patch).toMatchObject({
      sender_is_custom: true,
      sender_name: 'Bee Organized Moving',
      sender_email: 'moving@beeorganized-kc.com',
      sender_reply_to: 'carol@beeorganized.com',
    })
    // The mirror of setHandlerForTypes' rule: this writer never reassigns.
    expect(patch).not.toHaveProperty('source_user_id')
  })

  it('going back to person mode re-reads the identity from hub_users, not the caller', async () => {
    h.enqueue('lookups', [{ label: 'Local Move', sort_order: 10, attrs: { drip_category: 'move' } }])
    h.enqueue('location_project_type_senders', { id: 'row1', source_user_id: 'u1' })
    h.enqueue('hub_users', { full_name: 'Bree Mover', first_name: 'Bree', last_name: 'Mover', email: 'bree@x.com' })
    h.enqueue('location_project_type_senders', null)
    await setSenderIdentityForType(LOC, 'Local Move', { sender_is_custom: false })
    expect(h.updatePayloads('location_project_type_senders')[0]).toMatchObject({
      sender_is_custom: false,
      sender_name: 'Bree Mover',
      sender_email: 'bree@x.com',
      // Person mode has no reply-to of its own — replies follow the location's.
      sender_reply_to: null,
    })
  })

  it('REJECTS a type with no handler row — there is nowhere to keep a sender', async () => {
    h.enqueue('lookups', [{ label: 'Local Move', sort_order: 10, attrs: { drip_category: 'move' } }])
    h.enqueue('location_project_type_senders', null) // maybeSingle → no row
    await expect(setSenderIdentityForType(LOC, 'Local Move', { sender_is_custom: false }))
      .rejects.toThrow(/no handler for/)
  })
})

describe('getPickableHandler — the identity comes from hub_users, not the request', () => {
  it('resolves a pickable person at this location', async () => {
    h.enqueue('hub_users', { id: 'u1', full_name: 'Bree Mover', email: 'bree@x.com', role: 'manager', location_id: LOC })
    await expect(getPickableHandler(LOC, 'u1')).resolves.toEqual({
      source_user_id: 'u1', name: 'Bree Mover', email: 'bree@x.com',
    })
  })
  it('refuses a person at ANOTHER location', async () => {
    h.enqueue('hub_users', { id: 'u9', full_name: 'Elsewhere', email: 'e@x.com', role: 'owner', location_id: 'other-loc' })
    await expect(getPickableHandler(LOC, 'u9')).resolves.toBeNull()
  })
  it('refuses a role the picker does not offer', async () => {
    h.enqueue('hub_users', { id: 'u3', full_name: 'Lite', email: 'l@x.com', role: 'lite_user', location_id: LOC })
    await expect(getPickableHandler(LOC, 'u3')).resolves.toBeNull()
  })
})

describe('unassignTypes', () => {
  it('unassignTypes deletes the given types for the location', async () => {
    h.enqueue('lookups', [{ label: 'Local Move', sort_order: 10, attrs: { drip_category: 'move' } }])
    h.enqueue('location_project_type_senders', null)
    await unassignTypes(LOC, ['Local Move'])
    const call = h.callsFor('location_project_type_senders')[0]
    expect(call.ops.some(o => o[0] === 'delete')).toBe(true)
    expect(call.ops).toContainEqual(['in', ['project_type', ['Local Move']]])
  })

  it('nothing writes a split_* flag any more', async () => {
    h.enqueue('lookups', [{ label: 'Local Move', sort_order: 10, attrs: { drip_category: 'move' } }])
    h.enqueue('location_project_type_senders', null)
    await unassignTypes(LOC, ['Local Move'])
    expect(h.updatePayloads('locations')).toEqual([])
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
