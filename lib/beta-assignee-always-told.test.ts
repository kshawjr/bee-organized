// @vitest-environment node
//
// THE ASSIGNEE IS ALWAYS TOLD — 2026-08-30, Kevin's option (c) for Lynette's
// 279fcfbf, replacing the discarded alert-follows-assignment build (6b45202).
//
// THE RULE: the person a lead is assigned to — the handler for its type, or
// the owner when there is none (lib/lead-assignment.ts, the same resolution
// the assignment write uses) — is ALWAYS emailed about it. The "Who is told"
// list keeps its exact meaning: who hears about EVERY lead. The switch adds
// ears beyond the assignee; it can never silence someone's own assignments.
// UNION, never a filter: nobody emailed before this rule stops being emailed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const LOC = '132b42c2-0000-4000-8000-00000000c001'

type Rows = Record<string, any[]>
let rows: Rows = {}
// Every table the resolver touches, in order — the everyone-on and
// externals-only pins assert the assignment chain is not even consulted.
let queried: string[] = []

vi.mock('@/lib/supabase-service', () => {
  const makeQuery = (table: string) => {
    queried.push(table)
    let data = [...(rows[table] || [])]
    const q: any = {
      select() { return q },
      eq(col: string, val: any) { data = data.filter(r => r[col] === val); return q },
      in(col: string, vals: any[]) { data = data.filter(r => vals.includes(r[col])); return q },
      is(col: string, val: any) { data = data.filter(r => (r[col] ?? null) === val); return q },
      not(col: string, _op: string, val: any) { data = data.filter(r => (r[col] ?? null) !== val); return q },
      order() { return q },
      limit(n: number) { data = data.slice(0, n); return q },
      maybeSingle() { return Promise.resolve({ data: data[0] ?? null, error: null }) },
      single() { return Promise.resolve({ data: data[0] ?? null, error: null }) },
      then(res: any, rej: any) { return Promise.resolve({ data, error: null }).then(res, rej) },
    }
    return q
  }
  return { supabaseService: { from: (t: string) => makeQuery(t) } }
})
vi.mock('@/lib/zoho', () => ({ getZohoLocationNotificationContacts: async () => [] }))

const LOOKUP_ROWS = [
  { category: 'project_types', label: 'Home or Office Organizing', is_active: true, sort_order: 10 },
  { category: 'project_types', label: 'Moving/Relocation', is_active: true, sort_order: 20 },
]
const HUB_USERS = [
  { id: 'u-owner', location_id: LOC, full_name: 'Lynette Ewy', first_name: 'Lynette', last_name: 'Ewy', email: 'lynette@bee.test', role: 'owner', is_active: true, disabled_at: null, created_at: '2026-01-01' },
  { id: 'u-carol', location_id: LOC, full_name: 'Carol Kern', first_name: 'Carol', last_name: 'Kern', email: 'carol@bee.test', role: 'manager', is_active: true, disabled_at: null, created_at: '2026-01-02' },
  { id: 'u-alex', location_id: LOC, full_name: 'Alex R', first_name: 'Alex', last_name: 'R', email: 'alex@bee.test', role: 'manager', is_active: true, disabled_at: null, created_at: '2026-01-03' },
]
const MOVING_HANDLER = {
  location_id: LOC, project_type: 'Moving/Relocation', sender_name: 'Carol Kern',
  sender_email: 'carol@bee.test', sender_reply_to: null, source_user_id: 'u-carol',
}
const baseRows = (over: Partial<Rows> = {}): Rows => ({
  lookups: LOOKUP_ROWS,
  hub_users: HUB_USERS,
  lead_notification_prefs: [],
  lead_notification_externals: [],
  location_project_type_senders: [],
  subscription_seats: [],
  locations: [{ id: LOC, location_id: 'loc_kc' }],
  ...over,
})
const mute = (id: string) => ({ location_id: LOC, hub_user_id: id, category: 'all', subscribed: false })
const emails = async (lead: any) => {
  const { resolveLeadRecipients } = await import('@/lib/notification-recipients')
  return (await resolveLeadRecipients(LOC, lead)).map(r => r.email).sort()
}

beforeEach(() => { rows = baseRows(); queried = [] })
afterEach(() => { vi.resetModules() })

describe('an assigned person is emailed even when switched off', () => {
  it('a muted HANDLER still gets leads of their type', async () => {
    rows.location_project_type_senders = [MOVING_HANDLER]
    rows.lead_notification_prefs = [mute('u-carol')]
    expect(await emails({ project_type: 'Moving/Relocation' }))
      .toEqual(['alex@bee.test', 'carol@bee.test', 'lynette@bee.test'])
  })

  it('a muted OWNER still gets leads with no handler — the fallback assignee', async () => {
    rows.lead_notification_prefs = [mute('u-owner')]
    // No handler rows at all: every lead is assigned to the owner (legacy
    // hub_users role=owner tier — no seats seeded, as in production today).
    expect(await emails({ project_type: 'Moving/Relocation' }))
      .toEqual(['alex@bee.test', 'carol@bee.test', 'lynette@bee.test'])
    expect(await emails({ project_type: null }))
      .toEqual(['alex@bee.test', 'carol@bee.test', 'lynette@bee.test'])
  })

  it('an ALL-OFF team still reaches exactly the assignee — off can never mean silence', async () => {
    rows.location_project_type_senders = [MOVING_HANDLER]
    rows.lead_notification_prefs = [mute('u-owner'), mute('u-carol'), mute('u-alex')]
    expect(await emails({ project_type: 'Moving/Relocation' })).toEqual(['carol@bee.test'])
    expect(await emails({ project_type: 'Home or Office Organizing' })).toEqual(['lynette@bee.test'])
  })
})

describe('the switch keeps its whole current meaning for OTHER leads', () => {
  it('switching someone off still removes them from leads not assigned to them', async () => {
    rows.location_project_type_senders = [MOVING_HANDLER]
    rows.lead_notification_prefs = [mute('u-carol')]
    // An organizing lead is assigned to the owner, not Carol — her mute holds.
    expect(await emails({ project_type: 'Home or Office Organizing' }))
      .toEqual(['alex@bee.test', 'lynette@bee.test'])
  })

  it('nobody who is emailed today stops being emailed — the rule is a union, never a filter', async () => {
    // Handler set, everyone on: the full team plus the external, exactly as
    // before the rule. The assignee being guaranteed removes no one.
    rows.location_project_type_senders = [MOVING_HANDLER]
    rows.lead_notification_externals = [
      { id: 'x1', location_id: LOC, first_name: 'Front', last_name: 'Desk', email: 'desk@outside.test', phone: null, category: 'all', subscribed: true, created_at: '2026-01-01' },
    ]
    expect(await emails({ project_type: 'Moving/Relocation' }))
      .toEqual(['alex@bee.test', 'carol@bee.test', 'desk@outside.test', 'lynette@bee.test'])
  })
})

describe('day one is byte-identical: everyone on means nothing changes', () => {
  it('with every switch on, the assignment chain is not even consulted', async () => {
    rows.location_project_type_senders = [MOVING_HANDLER]
    const out = await emails({ project_type: 'Moving/Relocation' })
    expect(out).toEqual(['alex@bee.test', 'carol@bee.test', 'lynette@bee.test'])
    // The union only engages when someone is off. Everyone on → the handler
    // and owner tables are never read → provably identical queries and output.
    expect(queried).not.toContain('location_project_type_senders')
    expect(queried).not.toContain('subscription_seats')
  })
})

describe('externals and onboarding locations are untouched', () => {
  it('externals ride along by their own switch — never added, never removed by assignment', async () => {
    rows.location_project_type_senders = [MOVING_HANDLER]
    rows.lead_notification_prefs = [mute('u-carol')]
    rows.lead_notification_externals = [
      { id: 'x1', location_id: LOC, first_name: 'On', last_name: 'Ext', email: 'on@outside.test', phone: null, category: 'all', subscribed: true, created_at: '2026-01-01' },
      { id: 'x2', location_id: LOC, first_name: 'Off', last_name: 'Ext', email: 'off@outside.test', phone: null, category: 'all', subscribed: false, created_at: '2026-01-02' },
    ]
    const out = await emails({ project_type: 'Moving/Relocation' })
    expect(out).toContain('on@outside.test')      // subscribed external: kept
    expect(out).not.toContain('off@outside.test') // muted external: still off
    expect(out).toContain('carol@bee.test')       // the assignee, added
  })

  it('an externals-only location (the 24 onboarding) never engages the rule', async () => {
    rows.hub_users = []
    rows.lead_notification_externals = [
      { id: 'x1', location_id: LOC, first_name: 'Office', last_name: '', email: 'office@loc.test', phone: null, category: 'all', subscribed: true, created_at: '2026-01-01' },
    ]
    expect(await emails({ project_type: 'Moving/Relocation' })).toEqual(['office@loc.test'])
    expect(queried).not.toContain('location_project_type_senders')
  })

  it('the union appends only location team members — never a global CC shape', async () => {
    // Global CC merges AFTER this resolver (notifyNewLead) and is untouched:
    // nothing this resolver returns can carry the global_cc source, and the
    // lead_notification_global_cc table is never read here.
    rows.location_project_type_senders = [MOVING_HANDLER]
    rows.lead_notification_prefs = [mute('u-carol')]
    const { resolveLeadRecipients } = await import('@/lib/notification-recipients')
    const out = await resolveLeadRecipients(LOC, { project_type: 'Moving/Relocation' })
    expect(out.every(r => r.source === 'user' || r.source === 'external')).toBe(true)
    expect(queried).not.toContain('lead_notification_global_cc')
  })
})

describe('failure cannot make things worse than today', () => {
  it('an assignment-resolution error falls back to exactly the switched-on list', async () => {
    rows.location_project_type_senders = [MOVING_HANDLER]
    rows.lead_notification_prefs = [mute('u-carol')]
    vi.doMock('@/lib/lead-assignment', () => ({
      resolveLeadAssignees: async () => { throw new Error('boom') },
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await emails({ project_type: 'Moving/Relocation' })
    expect(out).toEqual(['alex@bee.test', 'lynette@bee.test']) // today's list, unshrunk
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toContain('assignee-always-told')
    warn.mockRestore()
    vi.doUnmock('@/lib/lead-assignment')
  })
})
