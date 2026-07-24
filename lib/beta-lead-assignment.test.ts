// @vitest-environment node
//
// Lead assignment by project type — Kevin's rule, 2026-07-24.
//
//   1. split_notifications_enabled OFF → the LOCATION OWNER. Several
//      notification recipients does NOT mean several assignees.
//   2. split ON  → whoever SPECIFICALLY claims the lead's project type.
//      MULTI-ASSIGN when several do.
//   3. split ON, nobody claims it → the LOCATION OWNER.
//   4. EXTERNAL recipients are notified but NEVER assigned; a type claimed only
//      by externals therefore falls to rule 3.
//   5. Never nobody — a location with no resolvable owner is loud, not silent.
//
// Also pinned here:
//   · label drift ('organizing' vs "Home or Office Organizing") resolves via
//     the legacy alias rather than silently missing every claim
//   · the junction write is fail-soft — a missing lead_assignees table (before
//     migrations/lead_assignees.sql is applied) still writes leads.assigned_to
//   · people-mapper maps assignment to an ARRAY, junction-first, legacy column
//     as compat fallback
//   · the migration SQL carries the ::text RLS cast (the standing gotcha)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

// ── recording supabaseService mock (intake-test pattern) ──────────
const h = vi.hoisted(() => {
  type Resp = { data: any; error: any }
  type Call = { table: string; ops: [string, any[]][] }
  const state = {
    // Per-table canned responses, consumed in order. A table with nothing
    // queued answers { data: null, error: null }.
    queue: [] as { table: string; resp: Resp }[],
    calls: [] as Call[],
  }
  const reset = () => { state.queue = []; state.calls = [] }
  const enqueue = (table: string, data: any, error: any = null) =>
    state.queue.push({ table, resp: { data, error } })
  const makeBuilder = (table: string) => {
    const idx = state.queue.findIndex(q => q.table === table)
    const resp = idx >= 0 ? state.queue.splice(idx, 1)[0].resp : { data: null, error: null }
    const call: Call = { table, ops: [] }
    state.calls.push(call)
    const b: any = {}
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'in', 'not', 'is', 'or', 'ilike', 'range', 'limit', 'order', 'lte']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

const ownerMock = vi.hoisted(() =>
  vi.fn(async () => ({ id: 'owner-1', email: 'owner@bee.com', full_name: 'Owner One', phone: null })),
)
const recipientsMock = vi.hoisted(() =>
  vi.fn(async () => ({ users: [] as any[], externals: [] as any[] })),
)
const splitMock = vi.hoisted(() => vi.fn(async () => false))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('./supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('./owner-resolution', () => ({ getPrimaryOwnerForLocation: ownerMock }))
vi.mock('./notification-recipients', () => ({
  getManageableRecipients: recipientsMock,
  isSplitNotificationsEnabled: splitMock,
}))

import {
  resolveLeadAssignees,
  writeLeadAssignment,
  canonicalProjectType,
} from '@/lib/lead-assignment'
import { mapLeadToPerson } from '@/lib/people-mapper'

const LOC = 'loc-uuid-1'

// The real production vocabulary (lookups, category='project_types').
const VOCAB = [
  { label: 'Home or Office Organizing', dripCategory: 'general' as const },
  { label: 'Moving/Relocation', dripCategory: 'move' as const },
  { label: 'Concierge Services', dripCategory: 'general' as const },
  { label: 'Other', dripCategory: 'general' as const },
]
const queueVocabulary = () =>
  h.enqueue('lookups', VOCAB.map(v => ({ label: v.label, attrs: { drip_category: v.dripCategory } })))

const user = (id: string, category: string, subscribed = true) => ({
  type: 'user' as const,
  hub_user_id: id,
  name: id,
  email: `${id}@bee.com`,
  role: 'manager',
  category,
  subscribed,
})
const external = (email: string, category: string) => ({
  type: 'external' as const,
  id: email,
  first_name: null,
  last_name: null,
  name: email,
  email,
  phone: null,
  category,
})

beforeEach(() => {
  h.reset()
  ownerMock.mockClear()
  recipientsMock.mockClear()
  splitMock.mockClear()
  ownerMock.mockResolvedValue({ id: 'owner-1', email: 'owner@bee.com', full_name: 'Owner One', phone: null } as any)
  recipientsMock.mockResolvedValue({ users: [], externals: [] })
  splitMock.mockResolvedValue(false)
})

describe('rule 1 — split OFF assigns the location owner', () => {
  it('assigns the owner regardless of project type', async () => {
    splitMock.mockResolvedValue(false)
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Moving/Relocation' })
    expect(r.hubUserIds).toEqual(['owner-1'])
    expect(r.basis).toBe('location_owner')
    expect(r.splitEnabled).toBe(false)
  })

  it('does NOT read the recipient list at all — several recipients is not several assignees', async () => {
    splitMock.mockResolvedValue(false)
    recipientsMock.mockResolvedValue({
      users: [user('u1', 'all'), user('u2', 'all'), user('u3', 'all')],
      externals: [external('hive@bee.com', 'all')],
    })
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Other' })
    expect(r.hubUserIds).toEqual(['owner-1'])
    // The load-bearing assertion: the config was never consulted, so a
    // three-recipient location cannot accidentally become three assignees.
    expect(recipientsMock).not.toHaveBeenCalled()
  })
})

describe('rule 2 — split ON assigns whoever claims the type', () => {
  it('assigns the single claimant', async () => {
    splitMock.mockResolvedValue(true)
    queueVocabulary()
    recipientsMock.mockResolvedValue({
      users: [user('u1', '["Home or Office Organizing"]'), user('u2', '["Moving/Relocation"]')],
      externals: [],
    })
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Moving/Relocation' })
    expect(r.hubUserIds).toEqual(['u2'])
    expect(r.basis).toBe('project_type')
    expect(ownerMock).not.toHaveBeenCalled()
  })

  it('MULTI-ASSIGNS when several people claim the same type', async () => {
    splitMock.mockResolvedValue(true)
    queueVocabulary()
    recipientsMock.mockResolvedValue({
      users: [
        user('u1', '["Moving/Relocation"]'),
        user('u2', '["Moving/Relocation","Other"]'),
        user('u3', '["Home or Office Organizing"]'),
      ],
      externals: [],
    })
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Moving/Relocation' })
    expect(r.hubUserIds).toEqual(['u1', 'u2'])
    expect(r.basis).toBe('project_type')
  })

  it("an 'all' recipient is NOT a claimant — cross-cutting means notified, not assigned", async () => {
    splitMock.mockResolvedValue(true)
    queueVocabulary()
    recipientsMock.mockResolvedValue({
      users: [user('u-all', 'all'), user('u-legacy', 'moving')],
      externals: [],
    })
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Moving/Relocation' })
    expect(r.hubUserIds).toEqual(['owner-1'])
    expect(r.basis).toBe('location_owner')
  })

  it('an UNSUBSCRIBED claimant is excluded — the owner cut them off from this flow', async () => {
    splitMock.mockResolvedValue(true)
    queueVocabulary()
    recipientsMock.mockResolvedValue({
      users: [user('u1', '["Moving/Relocation"]', false)],
      externals: [],
    })
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Moving/Relocation' })
    expect(r.hubUserIds).toEqual(['owner-1'])
    expect(r.basis).toBe('location_owner')
  })
})

describe('rule 3 — split ON, nobody claims the type → owner', () => {
  it('falls back when the type is claimed by no one', async () => {
    splitMock.mockResolvedValue(true)
    queueVocabulary()
    recipientsMock.mockResolvedValue({
      users: [user('u1', '["Home or Office Organizing"]')],
      externals: [],
    })
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Concierge Services' })
    expect(r.hubUserIds).toEqual(['owner-1'])
    expect(r.basis).toBe('location_owner')
  })

  it('falls back when the lead carries NO project type at all', async () => {
    splitMock.mockResolvedValue(true)
    queueVocabulary()
    recipientsMock.mockResolvedValue({ users: [user('u1', '["Other"]')], externals: [] })
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: null })
    expect(r.hubUserIds).toEqual(['owner-1'])
    expect(r.basis).toBe('location_owner')
    // A lead with no type isn't "drift" — nothing was there to recognize.
    expect(r.projectTypeUnrecognized).toBe(false)
  })
})

describe('rule 4 — externals are notified, never assigned', () => {
  it('a type claimed ONLY by an external falls to the owner, and names the external', async () => {
    splitMock.mockResolvedValue(true)
    queueVocabulary()
    recipientsMock.mockResolvedValue({
      users: [user('u1', '["Home or Office Organizing"]')],
      externals: [external('hive@beeorganized.com', '["Moving/Relocation"]')],
    })
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Moving/Relocation' })
    expect(r.hubUserIds).toEqual(['owner-1'])
    expect(r.basis).toBe('location_owner')
    // Recorded so "why did the owner get this?" is answerable.
    expect(r.externalClaimants).toEqual(['hive@beeorganized.com'])
  })

  it('a hub_user claimant still wins even when an external claims the same type', async () => {
    splitMock.mockResolvedValue(true)
    queueVocabulary()
    recipientsMock.mockResolvedValue({
      users: [user('u1', '["Moving/Relocation"]')],
      externals: [external('hive@beeorganized.com', '["Moving/Relocation"]')],
    })
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Moving/Relocation' })
    expect(r.hubUserIds).toEqual(['u1'])
    expect(r.basis).toBe('project_type')
  })

  it("a seeded external TWIN of the claimant (same email, category 'all') does not cancel their claim", async () => {
    // The Zoho top-up duplicated owner emails into lead_notification_externals
    // (39 rows in prod, seeded 2026-07-19). The twin carries 'all' and claims
    // nothing — it must be invisible to assignment: the owner's hub_user claim
    // stands, assigned exactly once.
    splitMock.mockResolvedValue(true)
    queueVocabulary()
    recipientsMock.mockResolvedValue({
      users: [user('u1', '["Moving/Relocation"]')],
      externals: [external('u1@bee.com', 'all')], // same address as user('u1')
    })
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Moving/Relocation' })
    expect(r.hubUserIds).toEqual(['u1'])
    expect(r.basis).toBe('project_type')
    expect(ownerMock).not.toHaveBeenCalled()
  })
})

describe('rule 5 — never nobody', () => {
  it('a location with no resolvable owner reports basis "none" LOUDLY, not silently', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    splitMock.mockResolvedValue(false)
    ownerMock.mockResolvedValue(null as any)
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: null })
    expect(r.hubUserIds).toEqual([])
    expect(r.basis).toBe('none')
    expect(err).toHaveBeenCalled()
    expect(String(err.mock.calls[0][0])).toContain('ZERO assignees')
    err.mockRestore()
  })
})

describe('label drift — exact-match would silently miss every claim', () => {
  it('canonicalizes case and whitespace', () => {
    expect(canonicalProjectType('  moving/relocation ', VOCAB)).toBe('Moving/Relocation')
  })

  it("maps the legacy lowercase tokens onto their label family", () => {
    // The real drift in prod: 2 leads store 'organizing', which is the old
    // drip-category vocabulary, not a project-type label.
    expect(canonicalProjectType('organizing', VOCAB)).toBe('Home or Office Organizing')
    expect(canonicalProjectType('moving', VOCAB)).toBe('Moving/Relocation')
  })

  it('returns null for a value that is not a project type at all', () => {
    // 16 prod leads carry project_type='Client' from the manual create path.
    expect(canonicalProjectType('Client', VOCAB)).toBeNull()
    expect(canonicalProjectType('', VOCAB)).toBeNull()
    expect(canonicalProjectType(null, VOCAB)).toBeNull()
  })

  it("a legacy 'organizing' lead still reaches the claimant it should", async () => {
    splitMock.mockResolvedValue(true)
    queueVocabulary()
    recipientsMock.mockResolvedValue({
      users: [user('u1', '["Home or Office Organizing"]')],
      externals: [],
    })
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'organizing' })
    expect(r.hubUserIds).toEqual(['u1'])
    expect(r.basis).toBe('project_type')
    expect(r.resolvedProjectType).toBe('Home or Office Organizing')
  })

  it('unrecognized drift falls back to the owner and FLAGS itself', async () => {
    splitMock.mockResolvedValue(true)
    queueVocabulary()
    recipientsMock.mockResolvedValue({ users: [user('u1', '["Other"]')], externals: [] })
    const r = await resolveLeadAssignees({ locationUuid: LOC, projectType: 'Client' })
    expect(r.hubUserIds).toEqual(['owner-1'])
    expect(r.basis).toBe('location_owner')
    // The fallback is correct; the flag is what keeps it from being silent.
    expect(r.projectTypeUnrecognized).toBe(true)
  })
})

describe('writeLeadAssignment — fail-soft before the migration lands', () => {
  const resolved = {
    hubUserIds: ['u1', 'u2'],
    basis: 'project_type' as const,
    splitEnabled: true,
    resolvedProjectType: 'Moving/Relocation',
    projectTypeUnrecognized: false,
    externalClaimants: [],
  }

  it('writes the junction AND stamps leads.assigned_to with the first assignee', async () => {
    const w = await writeLeadAssignment({ leadId: 'lead-1', resolved })
    expect(w.junctionWritten).toBe(true)
    expect(w.warnings).toEqual([])

    const junction = h.state.calls.find(c => c.table === 'lead_assignees')
    expect(junction).toBeTruthy()
    const upsert = junction!.ops.find(([m]) => m === 'upsert')!
    expect(upsert[1][0]).toEqual([
      { lead_id: 'lead-1', hub_user_id: 'u1', assigned_via: 'project_type' },
      { lead_id: 'lead-1', hub_user_id: 'u2', assigned_via: 'project_type' },
    ])

    const leadUpdate = h.state.calls.find(c => c.table === 'leads')
    expect(leadUpdate!.ops.find(([m]) => m === 'update')![1][0]).toEqual({ assigned_to: 'u1' })
  })

  it('a missing lead_assignees table still stamps assigned_to — the blank is fixed either way', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.enqueue('lead_assignees', null, { message: 'relation "lead_assignees" does not exist' })
    const w = await writeLeadAssignment({ leadId: 'lead-1', resolved })
    expect(w.junctionWritten).toBe(false)
    expect(w.warnings[0]).toContain('lead_assignees_write_failed')
    // The point of the whole fail-soft design: assigned_to still landed.
    const leadUpdate = h.state.calls.find(c => c.table === 'leads')
    expect(leadUpdate!.ops.find(([m]) => m === 'update')![1][0]).toEqual({ assigned_to: 'u1' })
    err.mockRestore()
  })

  it('never throws out to its caller — intake must not 500 over an assignment', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.enqueue('lead_assignees', null, { message: 'boom' })
    h.enqueue('leads', null, { message: 'boom too' })
    await expect(writeLeadAssignment({ leadId: 'lead-1', resolved })).resolves.toBeTruthy()
    err.mockRestore()
  })

  it('an empty assignee set writes nothing at all', async () => {
    const w = await writeLeadAssignment({
      leadId: 'lead-1',
      resolved: { ...resolved, hubUserIds: [], basis: 'none' },
    })
    expect(w.hubUserIds).toEqual([])
    // No stray `assigned_to: undefined` write.
    expect(h.state.calls.find(c => c.table === 'leads')).toBeUndefined()
  })

  it('assignedVia overrides the basis — a human pick records as manual', async () => {
    await writeLeadAssignment({ leadId: 'lead-1', resolved, assignedVia: 'manual' })
    const junction = h.state.calls.find(c => c.table === 'lead_assignees')!
    const rows = junction.ops.find(([m]) => m === 'upsert')![1][0]
    expect(rows.every((r: any) => r.assigned_via === 'manual')).toBe(true)
  })
})

describe('people-mapper — assignment is an ARRAY, junction-first', () => {
  const baseRow: any = { id: 'lead-1', location_id: 'loc_kc', location_uuid: 'u', name: 'A' }

  it('reads the junction in created_at order — index 0 is the primary', () => {
    const p = mapLeadToPerson(
      { ...baseRow, assigned_to: 'legacy-stamp' },
      {
        lead_assignees: [
          { lead_id: 'lead-1', hub_user_id: 'second', created_at: '2026-07-02T00:00:00Z' },
          { lead_id: 'lead-1', hub_user_id: 'first', created_at: '2026-07-01T00:00:00Z' },
        ],
      } as any,
    )
    expect(p.assignedTo).toEqual(['first', 'second'])
  })

  it('falls back to the legacy singular column when the junction is empty', () => {
    // Keeps the ~7,129 import blanket-stamped rows rendering as they do today
    // instead of blanking, and covers any pre-migration load.
    const p = mapLeadToPerson({ ...baseRow, assigned_to: 'legacy-stamp' }, { lead_assignees: [] } as any)
    expect(p.assignedTo).toEqual(['legacy-stamp'])
  })

  it('a lead with neither is an empty array, never null', () => {
    const p = mapLeadToPerson({ ...baseRow, assigned_to: null }, {} as any)
    expect(p.assignedTo).toEqual([])
  })

  it('the junction WINS over the legacy column — never both', () => {
    const p = mapLeadToPerson(
      { ...baseRow, assigned_to: 'legacy-stamp' },
      { lead_assignees: [{ lead_id: 'lead-1', hub_user_id: 'real', created_at: '2026-07-01T00:00:00Z' }] } as any,
    )
    expect(p.assignedTo).toEqual(['real'])
    expect(p.assignedTo).not.toContain('legacy-stamp')
  })
})

describe('migration SQL — the standing gotchas', () => {
  const path = 'migrations/lead_assignees.sql'
  const sql = existsSync(path) ? readFileSync(path, 'utf8') : ''

  it('exists', () => {
    expect(sql.length).toBeGreaterThan(0)
  })

  it('carries the ::text cast on BOTH policies — omitting it is the standing bug', () => {
    // hub_users.location_id is TEXT holding the location uuid; comparing it to
    // a uuid column without the cast fails at apply time.
    const casts = sql.match(/location_uuid::text/g) || []
    expect(casts.length).toBeGreaterThanOrEqual(3) // read + write USING + WITH CHECK
  })

  it('is idempotent — re-runnable without error', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.lead_assignees')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS')
    expect(sql).toContain('DROP POLICY IF EXISTS')
  })

  it('keys on (lead_id, hub_user_id) so a re-add is a no-op', () => {
    expect(sql).toContain('PRIMARY KEY (lead_id, hub_user_id)')
  })

  it('cascades from both parents — no orphan rows when a lead or user is deleted', () => {
    expect(sql).toMatch(/REFERENCES public\.leads\(id\)\s+ON DELETE CASCADE/)
    expect(sql).toMatch(/REFERENCES public\.hub_users\(id\)\s+ON DELETE CASCADE/)
  })

  it('enables RLS', () => {
    expect(sql).toContain('ALTER TABLE public.lead_assignees ENABLE ROW LEVEL SECURITY')
  })
})

describe('the generic lead PATCH must never carry assignment', () => {
  const src = readFileSync('components/BeeHub.jsx', 'utf8')

  it('assignedTo is NOT in PERSON_TO_API_FIELD — an array would corrupt the singular column', () => {
    const map = src.slice(
      src.indexOf('const PERSON_TO_API_FIELD'),
      src.indexOf('const PASSTHROUGH_API_FIELDS'),
    )
    expect(map.length).toBeGreaterThan(0)
    expect(map).not.toMatch(/^\s*assignedTo:/m)
  })

  it('assigned_to is not a PASSTHROUGH field either', () => {
    const pass = src.slice(
      src.indexOf('const PASSTHROUGH_API_FIELDS'),
      src.indexOf('async function patchLeadAPI'),
    )
    expect(pass).not.toContain("'assigned_to'")
  })

  it('the plural route is the only writer the UI reaches for', () => {
    expect(src).toContain('/assignees`')
    expect(src).toContain('hub_user_ids')
  })
})

describe('engagement carry-forward is wired into BOTH founding paths', () => {
  const src = readFileSync('lib/engagements.ts', 'utf8')

  it('foundEngagement and foundManualEngagement both seed the junction', () => {
    const calls = src.match(/seedEngagementAssigneesFromLead\(created\.id, clientId\)/g) || []
    expect(calls.length).toBe(2)
  })

  it('the seed only ever fills an EMPTY engagement junction', () => {
    // Otherwise a re-found would stomp a set someone edited in the masthead.
    const fn = src.slice(src.indexOf('export async function seedEngagementAssigneesFromLead'))
    expect(fn).toContain("from('engagement_assignees')")
    expect(fn).toMatch(/if \(\(already \|\| \[\]\)\.length > 0\) return 0/)
  })
})
