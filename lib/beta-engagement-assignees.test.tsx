// @vitest-environment happy-dom
//
// Engagement-level Assigned To — PLURAL, the Jobber TEAM/CREW who DO the
// work (assessment team + job crew), NOT the salesperson. Covers the build:
//   · resolveJobberAssignment  — all(multi) crew semantics
//   · getEngagementAssignees    — junction→hub_users join, order, names
//   · syncEngagementAssignmentToJobber — assessment team (all) + job crew
//     (all, onto every non-completed visit); request never assigned;
//     completed visits skipped; failure honesty; clear when nobody mapped;
//     no-op when no linked Jobber record; edit re-syncs the crew
//   · persistRosterAndMatch     — auto-match: exact / case-insensitive / none
//   · EngagementAssignees UI     — multi-select, unmapped marking, add/remove
//   · migration SQL              — RLS ::text cast + PK + backfill filters
//   · echo-guard invariant       — no inbound handler touches the junction
//   · lead-level row removed      — AssignedToField gone from ClientProfile
//
// INTROSPECTED LIVE 2026-07-11 / re-introspected 2026-07-31 (API 2025-04-16):
//   Assessment team (issue 147): assessmentEdit(assessmentId, input) with
//     AssessmentEditInput.schedule.teamMemberIdsToAssign : [EncodedId!] (multi).
//     NOT appointmentEditAssignment — that wanted an Appointment id the schema
//     never exposes for an assessment, so it was a silent no-op (0 of 22 in prod).
//     The edit reads back assignedUsers to VERIFY, and re-sends the current
//     startAt/endAt (read live) so preserving the schedule can't wipe the time.
//   VisitEditAssignedUsersInput.assignedUserIds    : [EncodedId!]! (multi) — job crew (per visit)
//   Job crew read via job(id).visits.nodes { id isComplete }
//   JobEditInput / RequestEditInput expose only salespersonId (singular) —
//     NOT a crew; the team model does not use them (request = not assigned)
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
// issue 147 — the assessment leg now uses assessmentEdit and READS BACK
// assignedUsers to verify the team applied (a clean userErrors array is not
// proof). The default mutation mock therefore ECHOES the requested team back
// as assignedUsers (a WORKING Jobber) and preserves startAt/endAt — tests that
// want a silent no-op / mismatch override with a non-echoing implementation.
const ASSESS_START = '2026-08-01T17:00:00Z' // 13:00 America/New_York
const ASSESS_END = '2026-08-01T18:00:00Z'   // 14:00 America/New_York
const defaultMutationImpl = async (_loc: any, mutation: any, vars: any) => {
  if (String(mutation).includes('assessmentEdit')) {
    const ids: string[] = vars?.input?.schedule?.teamMemberIdsToAssign ?? []
    return {
      data: { assessmentEdit: { assessment: {
        id: 'A-GID', startAt: ASSESS_START, endAt: ASSESS_END,
        assignedUsers: { nodes: ids.map(id => ({ id })) },
      } } },
      userErrors: [] as any[],
    }
  }
  return { data: {}, userErrors: [] as any[] }
}
const jobberMutation = vi.fn(defaultMutationImpl)
// jobberGraphQL serves TWO reads: the job's visits (job crew) and the
// assessment's current schedule (issue 147, to re-send startAt/endAt
// unchanged). Branch on the query. Tests override per-case as needed.
const defaultGraphQLImpl = async (_loc: any, query: any) => {
  if (String(query).includes('AssessmentScheduleForSync')) {
    return { data: { assessment: { id: 'A-GID', startAt: ASSESS_START, endAt: ASSESS_END } }, errors: undefined as any }
  }
  return {
    data: { job: { id: 'J1', visits: { totalCount: 1, nodes: [{ id: 'V1', isComplete: false }] } } },
    errors: undefined as any,
  }
}
const jobberGraphQL = vi.fn(defaultGraphQLImpl)
vi.mock('@/lib/jobber', () => ({
  jobberMutation: (...a: any[]) => jobberMutation(...a),
  jobberGraphQL: (...a: any[]) => jobberGraphQL(...a),
}))
const writeSyncLog = vi.fn(async () => {})
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: (...a: any[]) => writeSyncLog(...a) }))

import {
  resolveJobberAssignment,
  getEngagementAssignees,
  syncEngagementAssignmentToJobber,
} from '@/lib/engagement-assignee-sync'
import { encodeJobberId, extractJobberId } from '@/lib/jobber-import'
import { persistRosterAndMatch } from '@/lib/jobber-team-roster'
import EngagementAssignees from '@/components/hive/shared/EngagementAssignees'

beforeEach(() => {
  h.reset(); writeSyncLog.mockClear()
  jobberMutation.mockClear(); jobberMutation.mockImplementation(defaultMutationImpl)
  jobberGraphQL.mockClear(); jobberGraphQL.mockImplementation(defaultGraphQLImpl)
})

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
      // location_id rides along since 6 Oct 2026 — resolveJobberAssignment
      // holds back anyone whose location is not the one being pushed to.
      { hub_user_id: 'u1', name: 'Kevin Shaw', email: 'kevin@bmave.com', jobber_user_id: 'j1', location_id: null },
      { hub_user_id: 'u2', name: 'wendy@x.com', email: 'wendy@x.com', jobber_user_id: null, location_id: null }, // falls back to email
    ])
    const call = h.state.calls.find(c => c.table === 'engagement_assignees')!
    expect(call.ops.some(o => o[0] === 'order')).toBe(true) // ordered
  })

  it('returns [] on error', async () => {
    h.enqueue('engagement_assignees', null, { message: 'boom' })
    expect(await getEngagementAssignees('eng-x')).toEqual([])
  })
})

// ══ 3) syncEngagementAssignmentToJobber — the TEAM/CREW push ══════
// Assignees are the crew who DO the work, PLURAL:
//   · Assessment team         → ALL assignees via assessmentEdit, VERIFIED by
//                               read-back; startAt/endAt preserved (issue 147)
//   · Job crew                → ALL assignees onto every non-completed
//                               visit (visitEditAssignedUsers)
//   · Request                 → NEVER assigned (result 'skipped')
describe('syncEngagementAssignmentToJobber (assessment team; the job crew is Jobber’s)', () => {
  // Note: the sync reads `jobs` then `assessments` (no service_requests).
  // jobber_job_id / jobber_assessment_id are stored NUMERIC (extractJobberId
  // at import) — the real prod values from engagement 59badae2's location —
  // so the sync must re-encode them to base64 gids before feeding EncodedId!.
  const JOB_NUM = '141304145'      // gid://Jobber/Job/141304145
  const ASSESS_NUM = '2123185874'  // gid://Jobber/Assessment/2123185874
  const JOB_GID = encodeJobberId('Job', JOB_NUM)
  const ASSESS_GID = encodeJobberId('Assessment', ASSESS_NUM)
  const wireLinked = (over: any = {}) => {
    h.enqueue('engagement_assignees', over.assignees ?? [
      assignee({ hub_user_id: 'u1', jobber_user_id: 'j1' }),
      assignee({ hub_user_id: 'u2', full_name: 'Wendy', email: 'w@x.com', jobber_user_id: 'j2' }),
    ])
    h.enqueue('jobs', over.jobs ?? [{ jobber_job_id: JOB_NUM }])
    h.enqueue('assessments', over.assess ?? [{ jobber_assessment_id: ASSESS_NUM }])
    // issue 147 — the assessment leg reads the location timezone to preserve
    // startAt/endAt across the edit. Unconsumed when nobody is mapped (the tz
    // read is gated on there being a team to push).
    h.enqueue('locations', 'timezone' in over ? over.timezone : { timezone: 'America/New_York' })
  }
  const varsFor = (needle: string) =>
    jobberMutation.mock.calls.filter(c => String(c[1]).includes(needle)).map(c => c[2])

  // 2026-11-12: the JOB leg is gone. Jobber is the source of truth for who is
  // on a job's visits (lib/jobber-crew-mirror.ts reads it); the picker pushes
  // the assessment team and never reads or writes a visit. The before/after
  // is pinned by fingerprint in lib/beta-assignee-push-fingerprint.test.ts.
  it('assessment team = ALL assignees; the job and its visits are NOT read or written', async () => {
    wireLinked()
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res).toMatchObject({
      request: 'skipped', job: 'none', assessment: 'synced',
      visitsTouched: 0, mapped: 2, unmapped: 0,
    })
    expect(jobberGraphQL.mock.calls.some(c => 'jobId' in (c[2] || {}))).toBe(false)
    expect(varsFor('visitEditAssignedUsers')).toEqual([])
    expect(JOB_GID).not.toMatch(/^\d+$/)
    // assessment team = ALL mapped ids via assessmentEdit (issue 147);
    // assessmentId re-encoded to the Assessment gid (the EncodedId! the
    // mutation demands — the encode STAYS, it was never the bug). The team
    // rides ScheduledItemAttributes.teamMemberIdsToAssign, and the current
    // startAt/endAt are re-sent (converted to the location's local wall-clock)
    // so preserving the schedule can't wipe the appointment time.
    const av = varsFor('assessmentEdit')
    expect(av).toEqual([{
      assessmentId: ASSESS_GID,
      input: { schedule: {
        startAt: { date: '2026-08-01', time: '13:00:00', timezone: 'America/New_York' },
        endAt:   { date: '2026-08-01', time: '14:00:00', timezone: 'America/New_York' },
        teamMemberIdsToAssign: ['j1', 'j2'],
      } },
    }])
    expect(av[0].assessmentId).not.toMatch(/^\d+$/)
    // the OLD mutation is gone entirely
    expect(varsFor('appointmentEditAssignment')).toEqual([])
    // no salesperson / request / job edit anywhere (team model)
    expect(varsFor('jobEdit')).toEqual([])
    expect(varsFor('requestEdit')).toEqual([])
    expect(varsFor('salespersonId')).toEqual([])
    // breadcrumb written, outbound, engagement-scoped
    expect(writeSyncLog).toHaveBeenCalledTimes(1)
    expect(writeSyncLog.mock.calls[0][0]).toMatchObject({ entity_type: 'engagement', direction: 'outbound', status: 'success' })
  })

  it('assessment with null jobber_assessment_id → assessment none, no assessmentEdit (the id-drop bug)', async () => {
    // Reproduces engagement 59badae2: the assessment row exists but its
    // jobber_assessment_id is null, so there is no assessment to target.
    // The sync must report assessment=none and never call the mutation.
    // (The 'A1' happy-path test above pins the inverse: id present → synced.)
    wireLinked({ jobs: [], assess: [{ jobber_assessment_id: null }] })
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res.assessment).toBe('none')
    expect(varsFor('assessmentEdit')).toEqual([])
    // and the query guards at the source: filters out null-id rows
    const assessCall = h.state.calls.find(c => c.table === 'assessments')!
    expect(assessCall.ops).toContainEqual(['not', ['jobber_assessment_id', 'is', null]])
  })

  it('a linked job is never read, whatever its visits look like', async () => {
    wireLinked({ assess: [] })
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res.job).toBe('none')
    expect(res.visitsTouched).toBe(0)
    expect(jobberGraphQL).not.toHaveBeenCalled()
    expect(jobberMutation).not.toHaveBeenCalled()
  })

  it('nobody mapped → NOTHING is sent: the visit crew is not cleared (it used to be), and the assessment is not cleared either (issue 147)', async () => {
    // Until 2026-11-12 an empty set sent visitEditAssignedUsers an explicit [],
    // which wiped the crew an owner had set in Jobber. The assessment team was
    // never cleared: teamMemberIdsToAssign is assign-oriented and omitted for
    // an empty list.
    wireLinked({ assignees: [assignee({ hub_user_id: 'u1', jobber_user_id: null })] })
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res).toMatchObject({ request: 'skipped', job: 'none', assessment: 'none', mapped: 0, unmapped: 1 })
    expect(jobberMutation).not.toHaveBeenCalled()
    expect(jobberGraphQL).not.toHaveBeenCalled()
  })

  it('a failed assessment edit is an error breadcrumb; job stays none', async () => {
    wireLinked()
    jobberMutation.mockImplementation(async () => ({ data: {}, userErrors: [{ message: 'nope' }] }))
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res.job).toBe('none')
    expect(res.assessment).toBe('failed')
    const terminal = writeSyncLog.mock.calls.map(c => c[0]).find(a => String(a.message).includes('job='))
    expect(terminal).toMatchObject({ status: 'error' })
    expect(String(terminal.message)).toContain('job=not_pushed')
  })

  it('editing the roster re-sends the full current team to the assessment only', async () => {
    wireLinked({ assignees: [
      assignee({ hub_user_id: 'u1', jobber_user_id: 'j1' }),
      assignee({ hub_user_id: 'u2', jobber_user_id: 'j2' }),
      assignee({ hub_user_id: 'u3', full_name: 'Ana', email: 'a@x.com', jobber_user_id: 'j3' }),
    ] })
    await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(varsFor('visitEditAssignedUsers')).toEqual([])
    expect(varsFor('assessmentEdit')[0].assessmentId).toBe(ASSESS_GID)
    expect(varsFor('assessmentEdit')[0].input.schedule.teamMemberIdsToAssign).toEqual(['j1', 'j2', 'j3'])
  })

  it('request is NEVER assigned — no requestEdit/salesperson mutation, result skipped', async () => {
    wireLinked()
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res.request).toBe('skipped')
    // the sync never even reads service_requests (only jobs + assessments)
    expect(h.state.calls.some(c => c.table === 'service_requests')).toBe(false)
    expect(jobberMutation.mock.calls.some(c => String(c[1]).includes('requestEdit'))).toBe(false)
  })

  // ── issue 147: VERIFY-BY-READBACK + SCHEDULE PRESERVATION ──────────
  it('read-back mismatch → assessment FAILED + a persisted ASSESSMENT_TEAM_MISMATCH breadcrumb', async () => {
    wireLinked()
    // Jobber returns a CLEAN userErrors array but nobody actually got assigned
    // — the EXACT silent-no-op signature the old appointmentEditAssignment
    // produced. Only the read-back diff catches it; userErrors would not.
    jobberMutation.mockImplementation(async (_loc: any, mut: any) => {
      if (String(mut).includes('assessmentEdit')) {
        return { data: { assessmentEdit: { assessment: {
          id: 'A-GID', startAt: ASSESS_START, endAt: ASSESS_END,
          assignedUsers: { nodes: [] }, // <- applied nobody
        } } }, userErrors: [] }
      }
      return { data: {}, userErrors: [] }
    })
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res.assessment).toBe('failed')
    // PERSISTED, not console-only — a dedicated error breadcrumb naming the miss
    const mismatch = writeSyncLog.mock.calls.map(c => c[0])
      .find(a => String(a.message).includes('ASSESSMENT_TEAM_MISMATCH'))
    expect(mismatch).toMatchObject({ status: 'error', entity_type: 'engagement', direction: 'outbound' })
    expect(String(mismatch.message)).toContain('team mismatch')
    expect(String(mismatch.message)).toContain('missing=[j1,j2]')
  })

  it('schedule drift in the read-back → assessment FAILED (guards against wiping/moving the time)', async () => {
    wireLinked()
    jobberMutation.mockImplementation(async (_loc: any, mut: any, vars: any) => {
      if (String(mut).includes('assessmentEdit')) {
        const ids: string[] = vars?.input?.schedule?.teamMemberIdsToAssign ?? []
        return { data: { assessmentEdit: { assessment: {
          id: 'A-GID',
          startAt: '2026-08-02T17:00:00Z', // moved a day — DRIFT
          endAt: ASSESS_END,
          assignedUsers: { nodes: ids.map(id => ({ id })) }, // team applied fine
        } } }, userErrors: [] }
      }
      return { data: {}, userErrors: [] }
    })
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res.assessment).toBe('failed')
    const drift = writeSyncLog.mock.calls.map(c => c[0])
      .find(a => String(a.message).includes('schedule drift'))
    expect(drift).toBeTruthy()
  })

  it('re-sends the assessment\'s CURRENT startAt/endAt (read LIVE), converted to local — not hard-coded', async () => {
    wireLinked()
    jobberGraphQL.mockImplementation(async (_loc: any, query: any) => {
      if (String(query).includes('AssessmentScheduleForSync'))
        return { data: { assessment: { id: 'A-GID', startAt: '2026-12-15T20:30:00Z', endAt: '2026-12-15T21:30:00Z' } }, errors: undefined }
      return { data: { job: { id: 'J1', visits: { totalCount: 1, nodes: [{ id: 'V1', isComplete: false }] } } }, errors: undefined }
    })
    await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    const sched = varsFor('assessmentEdit')[0].input.schedule
    // 20:30Z → 15:30 EST (America/New_York, winter offset -5) — proves the time
    // is read live and tz-converted, not a fixed value.
    expect(sched.startAt).toEqual({ date: '2026-12-15', time: '15:30:00', timezone: 'America/New_York' })
    expect(sched.endAt).toEqual({ date: '2026-12-15', time: '16:30:00', timezone: 'America/New_York' })
  })

  it('missing/invalid location timezone → assessment FAILED, no assessmentEdit (never risk the schedule)', async () => {
    wireLinked({ timezone: {} }) // locations row with no timezone column
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res.assessment).toBe('failed')
    expect(varsFor('assessmentEdit')).toEqual([])
    // the schedule read is never even attempted
    expect(jobberGraphQL.mock.calls.some(c => String(c[1]).includes('AssessmentScheduleForSync'))).toBe(false)
    const problem = writeSyncLog.mock.calls.map(c => c[0])
      .find(a => String(a.message).includes('cannot preserve schedule'))
    expect(problem).toMatchObject({ status: 'error' })
  })

  // LIVE-ONLY: whether Jobber's assessmentEdit actually persists
  // teamMemberIdsToAssign onto the assessment can only be proven against a real
  // account (mirrors the it.todo in beta-assessment-team-assign.test.ts). The
  // read-back diff above is the in-prod guard for exactly that unknown.
  it.todo('assessmentEdit actually persists teamMemberIdsToAssign onto the assessment in prod — needs a live Jobber call')

  it('no linked Jobber records → no reads/mutations, no breadcrumb (pure local engagement)', async () => {
    wireLinked({ jobs: [], assess: [] })
    const res = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(res).toMatchObject({ request: 'skipped', job: 'none', assessment: 'none' })
    expect(jobberMutation).not.toHaveBeenCalled()
    expect(jobberGraphQL).not.toHaveBeenCalled()
    expect(writeSyncLog).not.toHaveBeenCalled()
  })
})

// ══ 3b) ENCODED-ID CONTRACT — no bare numeric may reach EncodedId! ══
// Regression guard for the 2026-07-11 prod bug (engagement 59badae2):
// jobber_job_id / jobber_assessment_id are stored NUMERIC, but the job-visits
// read (jobId), the assessment schedule read + edit (assessmentId), and the
// visit crew push (visitId) all type their id as EncodedId!. Feeding the bare
// number is rejected ("'<n>' is not a valid EncodedId"). visit ids arrive
// already-encoded from the read; jobber_user_id is stored already-encoded by
// the roster — so those two pass through, and re-encoding them would
// double-wrap. These tests pin: numeric in → base64 gid out, and NOTHING
// numeric is ever sent.
describe('encoded-id contract (EncodedId! args)', () => {
  const JOB_NUM = '141304145'
  const ASSESS_NUM = '2123185874'
  const wire = () => {
    h.enqueue('engagement_assignees', [
      assignee({ hub_user_id: 'u1', jobber_user_id: 'Z2lkOi8vSm9iYmVyL1VzZXIvMQ==' }), // already-encoded gid://Jobber/User/1
    ])
    h.enqueue('jobs', [{ jobber_job_id: JOB_NUM }])
    h.enqueue('assessments', [{ jobber_assessment_id: ASSESS_NUM }])
    h.enqueue('locations', { timezone: 'America/New_York' }) // issue 147 — tz for schedule preservation
  }
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
  const decode = (s: string) => Buffer.from(s, 'base64').toString('utf8')

  it('encodeJobberId round-trips numeric → gid → numeric (inverse of extractJobberId)', () => {
    const gid = encodeJobberId('Job', JOB_NUM)
    expect(decode(gid)).toBe('gid://Jobber/Job/141304145')
    expect(extractJobberId(gid)).toBe(JOB_NUM)
    // idempotent: an already-encoded input is not double-wrapped
    expect(encodeJobberId('Job', gid)).toBe(gid)
  })

  it('assessmentId (schedule read + edit) is sent as a gid, never bare numeric; no job id is sent at all', async () => {
    wire()
    await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    expect(jobberGraphQL.mock.calls.some(c => 'jobId' in (c[2] || {}))).toBe(false)

    // the assessment schedule read keys on `id` (EncodedId!)
    const readVars = jobberGraphQL.mock.calls.find(c => String(c[1]).includes('AssessmentScheduleForSync'))![2]
    expect(readVars.id).toBe(b64('gid://Jobber/Assessment/2123185874'))

    // the edit keys on `assessmentId` (EncodedId!)
    const editVars = jobberMutation.mock.calls.find(c => String(c[1]).includes('assessmentEdit'))![2]
    expect(editVars.assessmentId).toBe(b64('gid://Jobber/Assessment/2123185874'))
    expect(decode(editVars.assessmentId)).toMatch(/^gid:\/\/Jobber\/Assessment\/\d+$/)
  })

  it('NO EncodedId! arg anywhere in the sync is a bare numeric string', async () => {
    wire()
    await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    const idsSent: string[] = []
    for (const [, , vars] of jobberGraphQL.mock.calls) {
      if (vars?.jobId) idsSent.push(vars.jobId)
      if (vars?.id) idsSent.push(vars.id) // assessment schedule read
    }
    for (const [, , vars] of jobberMutation.mock.calls) {
      if (vars?.visitId) idsSent.push(vars.visitId)
      if (vars?.assessmentId) idsSent.push(vars.assessmentId)
    }
    expect(idsSent.length).toBeGreaterThan(0)
    for (const id of idsSent) expect(id).not.toMatch(/^\d+$/)
  })

  it('teamMemberIdsToAssign (already-encoded jobber_user_id) pass through UNtouched — not re-wrapped', async () => {
    wire()
    await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
    const editVars = jobberMutation.mock.calls.find(c => String(c[1]).includes('assessmentEdit'))![2]
    // exactly the stored value — a re-encode would corrupt it to a double gid
    expect(editVars.input.schedule.teamMemberIdsToAssign).toEqual(['Z2lkOi8vSm9iYmVyL1VzZXIvMQ=='])
  })

  it('the module re-encodes job + assessment ids at the call site (source pin)', () => {
    const src = readFileSync('lib/engagement-assignee-sync.ts', 'utf8')
    expect(src).not.toMatch(/encodeJobberId\('Job',/)   // the job leg is gone (2026-11-12)
    expect(src).toMatch(/encodeJobberId\('Assessment',/)
    // visit ids and assignedUserIds must NOT be re-encoded (already encoded)
    expect(src).not.toMatch(/encodeJobberId\('Visit'/)
    expect(src).not.toMatch(/encodeJobberId\('User'/)
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
  it('the EngagementPanel masthead mounts the shared AssigneeCorner (toggle mode), not the old chip-row', () => {
    const panel = readFileSync('components/hive/EngagementPanel.jsx', 'utf8')
    // Assignees moved to the top-right corner (Kevin 7/24) — the same
    // faces-only click-to-assign door the lead card wears. The old
    // masthead chip-row (EngagementAssignees) is no longer mounted here.
    expect(panel).toContain('AssigneeCorner')
    expect(panel).toContain('mode="toggle"')
    expect(panel).not.toContain('<EngagementAssignees')
  })
})
