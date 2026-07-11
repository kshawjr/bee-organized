// @vitest-environment happy-dom
//
// Engagement-level Assigned To — PLURAL, Jobber-mapped (multi-user
// foundation). Covers the whole build:
//   · resolveJobberAssignment  — primary(singular)/all(multi) semantics
//   · getEngagementAssignees    — junction→hub_users join, order, names
//   · syncEngagementAssignmentToJobber — request/job salesperson (one),
//     assessment appointment (all); failure honesty; no-op when no
//     linked Jobber record; clear when nobody mapped
//   · persistRosterAndMatch     — auto-match: exact / case-insensitive / none
//   · EngagementAssignees UI     — multi-select, unmapped marking, add/remove
//   · migration SQL              — RLS ::text cast + PK + backfill filters
//   · echo-guard invariant       — no inbound handler touches the junction
//   · lead-level row removed      — AssignedToField gone from ClientProfile
//
// INTROSPECTED LIVE 2026-07-11 (loc_test, API 2025-04-16):
//   RequestEditInput.salespersonId : EncodedId  (singular)
//   JobEditInput.salespersonId     : EncodedId  (singular)
//   AppointmentEditAssignmentInput.assignedUserIds : [EncodedId!]! (multi)
//   VisitEditAssignedUsersInput.assignedUserIds    : [EncodedId!]! (multi, NOT wired)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

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
    for (const m of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'or', 'not', 'range', 'ilike', 'is', 'limit', 'order', 'lte', 'in']) {
      b[m] = (...args: any[]) => { call.ops.push([m, args]); return b }
    }
    b.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return Promise.resolve(resp) }
    b.single = () => { call.ops.push(['single', []]); return Promise.resolve(resp) }
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  return { state, reset, enqueue, makeBuilder }
})

vi.mock('@/lib/supabase-service', () => ({
  supabaseService: { from: (t: string) => h.makeBuilder(t) },
}))
const jobberMutation = vi.fn(async () => ({ data: {}, userErrors: [] as any[] }))
vi.mock('@/lib/jobber', () => ({ jobberMutation: (...a: any[]) => jobberMutation(...a) }))
const writeSyncLog = vi.fn(async () => {})
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: (...a: any[]) => writeSyncLog(...a) }))

import {
  resolveJobberAssignment,
  getEngagementAssignees,
  syncEngagementAssignmentToJobber,
} from '@/lib/engagement-assignee-sync'
import { persistRosterAndMatch } from '@/lib/jobber-team-roster'
import EngagementAssignees from '@/components/hive/shared/EngagementAssignees'

beforeEach(() => { h.reset(); jobberMutation.mockClear(); writeSyncLog.mockClear() })

// `over` keys are honored verbatim when present — including explicit null
// (a `??` default would swallow `jobber_user_id: null`, the unmapped case).
const pick = (over: any, key: string, def: any) => (key in over ? over[key] : def)
const assignee = (over: any = {}) => ({
  hub_user_id: pick(over, 'hub_user_id', 'u1'),
  created_at: pick(over, 'created_at', '2026-07-01T00:00:00Z'),
  hub_users: {
    id: pick(over, 'hub_user_id', 'u1'),
    full_name: pick(over, 'full_name', 'Kevin Shaw'),
    first_name: null, last_name: null,
    email: pick(over, 'email', 'kevin@bmave.com'),
    jobber_user_id: pick(over, 'jobber_user_id', 'gid://jobber/User/1'),
  },
})

// ══ 1) resolveJobberAssignment — the singular/multi split ═════════
describe('resolveJobberAssignment', () => {
  const rows = (over: any[]) => over as any

  it('primary = first MAPPED assignee; all = every mapped id', () => {
    const r = resolveJobberAssignment(rows([
      { hub_user_id: 'u1', name: 'A', email: null, jobber_user_id: 'j1' },
      { hub_user_id: 'u2', name: 'B', email: null, jobber_user_id: 'j2' },
    ]))
    expect(r.primaryJobberUserId).toBe('j1')
    expect(r.allJobberUserIds).toEqual(['j1', 'j2'])
    expect(r.mappedCount).toBe(2)
    expect(r.unmappedCount).toBe(0)
  })

  it('skips unmapped assignees (no jobber_user_id) but counts them', () => {
    const r = resolveJobberAssignment(rows([
      { hub_user_id: 'u1', name: 'Kevin', email: null, jobber_user_id: null }, // no field role
      { hub_user_id: 'u2', name: 'Wendy', email: null, jobber_user_id: 'j2' },
    ]))
    expect(r.primaryJobberUserId).toBe('j2')       // first MAPPED, not first row
    expect(r.allJobberUserIds).toEqual(['j2'])
    expect(r.mappedCount).toBe(1)
    expect(r.unmappedCount).toBe(1)
  })

  it('nobody mapped → null primary + empty array (a clear)', () => {
    const r = resolveJobberAssignment(rows([
      { hub_user_id: 'u1', name: 'Kevin', email: null, jobber_user_id: null },
    ]))
    expect(r.primaryJobberUserId).toBeNull()
    expect(r.allJobberUserIds).toEqual([])
    expect(r.unmappedCount).toBe(1)
  })
})

// ══ 2) getEngagementAssignees — join + name + order ══════════════
describe('getEngagementAssignees', () => {
  it('resolves display names, ordered by created_at, flattening the join', async () => {
    h.enqueue('engagement_assignees', [
      assignee({ hub_user_id: 'u1', full_name: 'Kevin Shaw', jobber_user_id: 'j1' }),
      assignee({ hub_user_id: 'u2', full_name: null, email: 'wendy@x.com', jobber_user_id: null }),
    ])
    const out = await getEngagementAssignees('eng-1')
    expect(out).toEqual([
      { hub_user_id: 'u1', name: 'Kevin Shaw', email: 'kevin@bmave.com', jobber_user_id: 'j1' },
      { hub_user_id: 'u2', name: 'wendy@x.com', email: 'wendy@x.com', jobber_user_id: null }, // falls back to email
    ])
    const call = h.state.calls.find(c => c.table === 'engagement_assignees')!
    expect(call.ops.some(o => o[0] === 'order')).toBe(true) // ordered
  })

  it('returns [] on error', async () => {
    h.enqueue('engagement_assignees', null, { message: 'boom' })
    expect(await getEngagementAssignees('eng-x')).toEqual([])
  })
})

// ══ 3) syncEngagementAssignmentToJobber — the push ═══════════════
describe('syncEngagementAssignmentToJobber', () => {
  const wireLinked = (over: any = {}) => {
    h.enqueue('engagement_assignees', over.assignees ?? [
      assignee({ hub_user_id: 'u1', jobber_user_id: 'j1' }),
      assignee({ hub_user_id: 'u2', full_name: 'Wendy', email: 'w@x.com', jobber_user_id: 'j2' }),
    ])
    h.enqueue('service_requests', over.sr ?? [{ jobber_request_id: 'R1' }])
    h.enqueue('jobs', over.jobs ?? [{ jobber_job_id: 'J1' }])
    h.enqueue('assessments', over.assess ?? [{ jobber_assessment_id: 'A1' }])
  }

  it('request+job get the PRIMARY (singular); assessment gets ALL (multi)', async () => {
    wireLinked()
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res).toMatchObject({ request: 'synced', job: 'synced', assessment: 'synced', mapped: 2, unmapped: 0 })

    const byMutation = (needle: string) =>
      jobberMutation.mock.calls.filter(c => String(c[1]).includes(needle))
    // request salesperson = primary only
    expect(byMutation('requestEdit')[0][2]).toEqual({ requestId: 'R1', input: { salespersonId: 'j1' } })
    // job salesperson = primary only
    expect(byMutation('jobEdit')[0][2]).toEqual({ jobId: 'J1', input: { salespersonId: 'j1' } })
    // assessment appointment = ALL mapped ids
    expect(byMutation('appointmentEditAssignment')[0][2]).toEqual({ appointmentId: 'A1', input: { assignedUserIds: ['j1', 'j2'] } })
    // breadcrumb written, outbound, engagement-scoped
    expect(writeSyncLog).toHaveBeenCalledTimes(1)
    expect(writeSyncLog.mock.calls[0][0]).toMatchObject({ entity_type: 'engagement', direction: 'outbound', status: 'success' })
  })

  it('nobody mapped → salespersonId null (clear) and assessment gets []', async () => {
    wireLinked({ assignees: [assignee({ hub_user_id: 'u1', jobber_user_id: null })] })
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res).toMatchObject({ request: 'cleared', job: 'cleared', assessment: 'cleared', mapped: 0, unmapped: 1 })
    const reqVars = jobberMutation.mock.calls.find(c => String(c[1]).includes('requestEdit'))![2]
    expect(reqVars).toEqual({ requestId: 'R1', input: { salespersonId: null } })
    const apptVars = jobberMutation.mock.calls.find(c => String(c[1]).includes('appointmentEditAssignment'))![2]
    expect(apptVars).toEqual({ appointmentId: 'A1', input: { assignedUserIds: [] } })
  })

  it('a userErrors reply marks that target failed but does not throw', async () => {
    wireLinked({ jobs: [{ jobber_job_id: 'J1' }] })
    jobberMutation.mockImplementation(async (_loc: any, mut: any) =>
      String(mut).includes('jobEdit')
        ? { data: {}, userErrors: [{ message: 'user not on job' }] }
        : { data: {}, userErrors: [] })
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res.job).toBe('failed')
    expect(res.request).toBe('synced')
    // failure flips the breadcrumb to error but still writes it
    expect(writeSyncLog.mock.calls[0][0]).toMatchObject({ status: 'error' })
    jobberMutation.mockImplementation(async () => ({ data: {}, userErrors: [] }))
  })

  it('no linked Jobber records → no mutations, no breadcrumb (pure local engagement)', async () => {
    wireLinked({ sr: [], jobs: [], assess: [] })
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res).toMatchObject({ request: 'none', job: 'none', assessment: 'none' })
    expect(jobberMutation).not.toHaveBeenCalled()
    expect(writeSyncLog).not.toHaveBeenCalled()
  })
})

// ══ 4) persistRosterAndMatch — auto-match cases ══════════════════
describe('persistRosterAndMatch (email auto-match)', () => {
  const runMatch = async (roster: any[], unlinked: any[]) => {
    h.enqueue('locations', {}, null)               // cache write
    h.enqueue('hub_users', unlinked, null)         // unlinked users fetch
    // one patch response per expected match (extra are harmless — FIFO)
    for (let i = 0; i < unlinked.length; i++) h.enqueue('hub_users', {}, null)
    return persistRosterAndMatch('loc-uuid-1', roster as any)
  }

  it('exact email match links the user', async () => {
    const r = await runMatch(
      [{ id: 'j1', name: 'Kevin', email: 'kevin@bmave.com' }],
      [{ id: 'u1', email: 'kevin@bmave.com', jobber_user_id: null }],
    )
    expect(r.matched).toBe(1)
    const patch = h.state.calls.filter(c => c.table === 'hub_users').flatMap(c => c.ops.filter(o => o[0] === 'update').map(o => o[1][0]))
    expect(patch).toContainEqual({ jobber_user_id: 'j1' })
  })

  it('match is case-insensitive / trims', async () => {
    const r = await runMatch(
      [{ id: 'j9', name: 'Wendy', email: '  Wendy@X.com ' }],
      [{ id: 'u9', email: 'wendy@x.COM', jobber_user_id: null }],
    )
    expect(r.matched).toBe(1)
  })

  it('no roster match → user stays unlinked (matched 0)', async () => {
    const r = await runMatch(
      [{ id: 'j1', name: 'Kevin', email: 'kevin@bmave.com' }],
      [{ id: 'u2', email: 'stranger@nowhere.com', jobber_user_id: null }],
    )
    expect(r.matched).toBe(0)
  })
})

// ══ 5) EngagementAssignees — the masthead multi-select ═══════════
describe('EngagementAssignees component', () => {
  let calls: any[] = []
  const jsonRes = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body })
  const mount = async (ui: React.ReactElement) => {
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(ui) })
    return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
  }
  const click = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  const btnWith = (host: Element, text: string) =>
    Array.from(host.querySelectorAll('button')).find(b => (b.textContent || '').includes(text)) || null

  const USERS = [
    { id: 'u1', name: 'Kevin Shaw', email: 'kevin@bmave.com', locationId: 'loc-1', jobberUserId: 'j1' },
    { id: 'u2', name: 'Wendy Ortiz', email: 'wendy@x.com', locationId: 'loc-1', jobberUserId: null }, // unmapped
  ]

  beforeEach(() => {
    calls = []
    ;(globalThis as any).fetch = vi.fn(async (url: any, opts: any = {}) => {
      const method = opts.method || 'GET'
      calls.push({ url: String(url), method, body: opts.body ? JSON.parse(opts.body) : null })
      // POST/DELETE both return the recomputed assignees list
      if (method === 'POST') return jsonRes({ assignees: [{ hub_user_id: JSON.parse(opts.body).hub_user_id, name: 'Kevin Shaw', email: 'kevin@bmave.com', jobber_user_id: 'j1' }] })
      return jsonRes({ assignees: [] })
    })
  })

  it('renders assignees with a remove control; empty state says Unassigned', async () => {
    const { host, unmount } = await mount(
      <EngagementAssignees engagementId="eng-1" assignees={[]} users={USERS} jobberConnected onChange={() => {}} setToast={() => {}} />
    )
    expect(host.textContent).toContain('Unassigned')
    expect(btnWith(host, '+ Assign')).toBeTruthy()
    await unmount()
  })

  it('adding a member POSTs the junction and lifts onChange', async () => {
    const onChange = vi.fn()
    const { host, unmount } = await mount(
      <EngagementAssignees engagementId="eng-1" assignees={[]} users={USERS} jobberConnected onChange={onChange} setToast={() => {}} />
    )
    await click(btnWith(host, '+ Assign')!)
    await click(btnWith(host, 'Kevin Shaw')!)
    expect(calls).toEqual([{ url: '/api/engagements/eng-1/assignees', method: 'POST', body: { hub_user_id: 'u1' } }])
    expect(onChange).toHaveBeenCalledWith([{ hub_user_id: 'u1', name: 'Kevin Shaw', email: 'kevin@bmave.com', jobber_user_id: 'j1' }])
    await unmount()
  })

  it('removing an assignee DELETEs by hub_user_id', async () => {
    const onChange = vi.fn()
    const { host, unmount } = await mount(
      <EngagementAssignees engagementId="eng-1"
        assignees={[{ hub_user_id: 'u1', name: 'Kevin Shaw', email: 'kevin@bmave.com', jobber_user_id: 'j1' }]}
        users={USERS} jobberConnected onChange={onChange} setToast={() => {}} />
    )
    await click(host.querySelector('button[aria-label="Unassign Kevin Shaw"]')!)
    expect(calls[0]).toEqual({ url: '/api/engagements/eng-1/assignees?hub_user_id=u1', method: 'DELETE', body: null })
    expect(onChange).toHaveBeenCalledWith([])
    await unmount()
  })

  it('unmapped user is selectable but MARKED (⚠ + no-Jobber note) when the location is on Jobber', async () => {
    const { host, unmount } = await mount(
      <EngagementAssignees engagementId="eng-1"
        assignees={[{ hub_user_id: 'u2', name: 'Wendy Ortiz', email: 'wendy@x.com', jobber_user_id: null }]}
        users={USERS} jobberConnected onChange={() => {}} setToast={() => {}} />
    )
    // chip carries the tooltip
    const chip = Array.from(host.querySelectorAll('span')).find(s => (s.getAttribute('title') || '').includes("Won't sync to Jobber"))
    expect(chip).toBeTruthy()
    // popover marks the unmapped user
    await click(btnWith(host, '+ Assign')!)
    expect(host.textContent).toContain('no Jobber')
    await unmount()
  })

  it('when the location is NOT on Jobber, no unmapped nag shows', async () => {
    const { host, unmount } = await mount(
      <EngagementAssignees engagementId="eng-1"
        assignees={[{ hub_user_id: 'u2', name: 'Wendy Ortiz', email: 'wendy@x.com', jobber_user_id: null }]}
        users={USERS} jobberConnected={false} onChange={() => {}} setToast={() => {}} />
    )
    await click(btnWith(host, '+ Assign')!)
    expect(host.textContent).not.toContain('no Jobber')
    await unmount()
  })
})

// ══ 6) Migration SQL — RLS cast + PK; FORWARD-ONLY (no backfill) ══
describe('migration SQL', () => {
  const table = readFileSync('migrations/engagement_assignees.sql', 'utf8')

  it('junction has the composite PK and FK cascades', () => {
    expect(table).toMatch(/PRIMARY KEY \(engagement_id, hub_user_id\)/)
    expect(table).toContain('REFERENCES public.engagements(id) ON DELETE CASCADE')
    expect(table).toContain('REFERENCES public.hub_users(id)   ON DELETE CASCADE')
  })

  it('RLS carries the hub_users.location_id ::text cast (the known gotcha) and NEVER a bare compare', () => {
    expect(table).toContain('ENABLE ROW LEVEL SECURITY')
    expect(table).toContain('e.location_uuid::text')
    // no uncast `= e.location_uuid` (would error at eval — text vs uuid)
    expect(table).not.toMatch(/location_id\s*=\s*e\.location_uuid(?!::text)/)
  })

  it('is FORWARD-ONLY — no backfill of the junk leads.assigned_to values', () => {
    expect(table).toContain('FORWARD-ONLY')
    expect(existsSync('migrations/engagement_assignees_backfill.sql')).toBe(false)
  })
})

// ══ 7) Echo-guard invariant — no inbound handler touches junction ══
describe('echo-guard invariant', () => {
  it('no webhook handler reads or writes engagement_assignees (so the push cannot loop)', () => {
    const handlers = readFileSync('lib/jobber-webhook-handlers.ts', 'utf8')
    expect(handlers).not.toContain('engagement_assignees')
  })
  it('the sync writes an OUTBOUND breadcrumb (converges, never re-enters PATCH)', () => {
    const sync = readFileSync('lib/engagement-assignee-sync.ts', 'utf8')
    expect(sync).toContain("direction: 'outbound'")
    expect(sync).toContain("entity_type: 'engagement'")
  })
})

// ══ 8) Lead-level row removed ════════════════════════════════════
describe('lead-level assigned-to removed', () => {
  it('ClientProfile no longer imports or renders AssignedToField', () => {
    const profile = readFileSync('components/hive/ClientProfile.jsx', 'utf8')
    expect(profile).not.toContain('AssignedToField')
  })
  it('the AssignedToField component file is deleted', () => {
    expect(existsSync('components/hive/shared/AssignedToField.jsx')).toBe(false)
  })
  it('the EngagementPanel masthead mounts the plural EngagementAssignees', () => {
    const panel = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')
    expect(panel).toContain('EngagementAssignees')
  })
})
