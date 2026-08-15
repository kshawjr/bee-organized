// @vitest-environment node
//
// issue 149 — RESOLVE ASSIGNEES AT FOUNDING, not just at intake.
//
// The lead's assignment is decided at intake (lib/lead-assignment.ts). But a
// lead that predates the resolver — or that resolved to nobody then — carries
// an EMPTY lead_assignees junction, so the verbatim carry-forward in
// seedEngagementAssigneesFromLead would open the work with NOBODY, and nothing
// would ever re-resolve against the location's CURRENT config.
//
// The fix: when the lead junction is empty AND a `fallback` is supplied, the
// seed runs the SAME resolver intake would — so an engagement founded from an
// unassigned lead opens on the project-type claimer (or the owner), exactly as
// it would have had the lead been assigned at intake. It stays strictly
// EMPTY-ONLY: an engagement whose junction is already non-empty (e.g. a manual
// masthead edit) is never touched, and a lead that DID carry assignees is
// seeded verbatim without the resolver ever running.
//
// These tests drive the REAL resolver (its supabase reads for the project-type
// vocabulary are canned; owner / recipients / split-flag are mocked the same
// way lib/beta-lead-assignment.test.ts mocks them) so the whole chain
// empty-junction → resolveLeadAssignees → engagement_assignees is exercised.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── recording supabaseService mock (intake-test pattern) ──────────
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
// issue 246 step 2 — assignment resolves through the HANDLER table.
const handlersMock = vi.hoisted(() => vi.fn(async () => new Map<string, any>()))
const handlers = (pairs: Array<[string, string]>) =>
  new Map(pairs.map(([type, userId]) => [
    type.toLowerCase(),
    { project_type: type, hub_user_id: userId, name: userId, email: `${userId}@bee.com`, reply_to: null },
  ]))

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('./supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
vi.mock('./owner-resolution', () => ({ getPrimaryOwnerForLocation: ownerMock }))
vi.mock('./notification-recipients', () => ({
  getManageableRecipients: recipientsMock,
}))
vi.mock('./project-type-handlers', () => ({ getLocationHandlers: handlersMock }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))
vi.mock('./sync-log', () => ({ writeSyncLog: vi.fn(async () => {}) }))

import { seedEngagementAssigneesFromLead } from '@/lib/engagements'

const LOC = 'loc-uuid-1'
const ENG = 'eng-1'
const LEAD = 'lead-1'

const VOCAB = [
  { label: 'Home or Office Organizing', dripCategory: 'general' as const },
  { label: 'Moving/Relocation', dripCategory: 'move' as const },
  { label: 'Concierge Services', dripCategory: 'general' as const },
  { label: 'Other', dripCategory: 'general' as const },
]
const queueVocabulary = () =>
  h.enqueue('lookups', VOCAB.map(v => ({ label: v.label, attrs: { drip_category: v.dripCategory } })))

const user = (id: string, category: string, subscribed = true) => ({
  type: 'user' as const, hub_user_id: id, name: id, email: `${id}@bee.com`, role: 'manager', category, subscribed,
})

// The engagement_assignees UPSERT rows (the second engagement_assignees call —
// the first is the empty-junction probe).
const seededRows = () => {
  const upsertCall = h.state.calls.find(c => c.table === 'engagement_assignees' && c.ops.some(([m]) => m === 'upsert'))
  return upsertCall?.ops.find(([m]) => m === 'upsert')?.[1][0] ?? null
}
const seededIds = () => (seededRows() || []).map((r: any) => r.hub_user_id)

beforeEach(() => {
  h.reset()
  ownerMock.mockClear(); recipientsMock.mockClear(); splitMock.mockClear()
  ownerMock.mockResolvedValue({ id: 'owner-1', email: 'owner@bee.com', full_name: 'Owner One', phone: null } as any)
  recipientsMock.mockResolvedValue({ users: [], externals: [] })
  splitMock.mockResolvedValue(false)
  handlersMock.mockClear(); handlersMock.mockResolvedValue(new Map())
})

describe('issue 149 — empty lead junction re-resolves at founding', () => {
  it('empty junction + a HANDLED project type seeds the handler', async () => {
    queueVocabulary()
    handlersMock.mockResolvedValue(handlers([
      ['Home or Office Organizing', 'u1'],
      ['Moving/Relocation', 'u2'],
    ]))
    h.enqueue('lead_assignees', []) // lead never carried assignees

    const n = await seedEngagementAssigneesFromLead(ENG, LEAD, {
      locationUuid: LOC, projectType: 'Moving/Relocation',
    })

    expect(n).toBe(1)
    expect(seededIds()).toEqual(['u2'])
    // Every seeded row hangs on THIS engagement.
    expect(seededRows().every((r: any) => r.engagement_id === ENG)).toBe(true)
    expect(ownerMock).not.toHaveBeenCalled() // the handler won, not the owner
  })

  it('seeds exactly ONE person — a type has one handler', async () => {
    // This used to MULTI-ASSIGN when several people claimed a type in the
    // notification config. Several assignees on a lead is now set ON the lead,
    // not inferred from configuration (issue 246 step 2).
    queueVocabulary()
    handlersMock.mockResolvedValue(handlers([['Moving/Relocation', 'u1']]))
    h.enqueue('lead_assignees', [])

    const n = await seedEngagementAssigneesFromLead(ENG, LEAD, {
      locationUuid: LOC, projectType: 'Moving/Relocation',
    })
    expect(n).toBe(1)
    expect(seededIds()).toEqual(['u1'])
  })

  it('empty junction + an UNHANDLED type seeds the owner', async () => {
    queueVocabulary()
    handlersMock.mockResolvedValue(handlers([['Home or Office Organizing', 'u1']]))
    h.enqueue('lead_assignees', [])

    const n = await seedEngagementAssigneesFromLead(ENG, LEAD, {
      locationUuid: LOC, projectType: 'Concierge Services',
    })
    expect(n).toBe(1)
    expect(seededIds()).toEqual(['owner-1'])
  })

  it('split OFF seeds the owner regardless of type (rule 1) — the manual-founding shape', async () => {
    splitMock.mockResolvedValue(false)
    // projectType null mirrors foundManualEngagement, which declares no type.
    h.enqueue('lead_assignees', [])

    const n = await seedEngagementAssigneesFromLead(ENG, LEAD, {
      locationUuid: LOC, projectType: null,
    })
    expect(n).toBe(1)
    expect(seededIds()).toEqual(['owner-1'])
    // Split off never consults the recipient list — several recipients is not
    // several assignees.
    expect(recipientsMock).not.toHaveBeenCalled()
  })

  it('a location with no resolvable owner seeds NOBODY (rule 5) rather than inventing one', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    splitMock.mockResolvedValue(false)
    ownerMock.mockResolvedValue(null as any)
    h.enqueue('lead_assignees', [])

    const n = await seedEngagementAssigneesFromLead(ENG, LEAD, { locationUuid: LOC, projectType: null })
    expect(n).toBe(0)
    expect(seededRows()).toBeNull() // no upsert at all
    err.mockRestore()
  })
})

describe('issue 149 — the empty-only guard is never violated', () => {
  it('a NON-EMPTY lead junction is seeded verbatim; the resolver never runs', async () => {
    h.enqueue('lead_assignees', [
      { hub_user_id: 'a', created_at: '2026-07-01T00:00:00Z' },
      { hub_user_id: 'b', created_at: '2026-07-02T00:00:00Z' },
    ])

    const n = await seedEngagementAssigneesFromLead(ENG, LEAD, {
      locationUuid: LOC, projectType: 'Moving/Relocation',
    })
    expect(n).toBe(2)
    expect(seededIds()).toEqual(['a', 'b'])
    // The fallback resolver was NOT consulted — the lead's own set stands.
    expect(splitMock).not.toHaveBeenCalled()
    expect(ownerMock).not.toHaveBeenCalled()
    expect(recipientsMock).not.toHaveBeenCalled()
  })

  it('an engagement whose junction is ALREADY populated is left untouched (no resolve, no write)', async () => {
    // A masthead edit must survive a re-found. Probe returns a row → bail early.
    h.enqueue('engagement_assignees', [{ hub_user_id: 'kept' }])

    const n = await seedEngagementAssigneesFromLead(ENG, LEAD, {
      locationUuid: LOC, projectType: 'Moving/Relocation',
    })
    expect(n).toBe(0)
    expect(seededRows()).toBeNull()
    expect(splitMock).not.toHaveBeenCalled()
    expect(ownerMock).not.toHaveBeenCalled()
  })

  it('without a fallback, an empty lead junction opens blank (pre-issue-149 behavior preserved)', async () => {
    h.enqueue('lead_assignees', [])
    const n = await seedEngagementAssigneesFromLead(ENG, LEAD)
    expect(n).toBe(0)
    expect(seededRows()).toBeNull()
    expect(splitMock).not.toHaveBeenCalled()
  })
})
