// The assignee picker's push to Jobber, by FINGERPRINT (2026-11-12).
//
// Jobber is now the source of truth for who is on a job: owners set the crew
// on each visit in Jobber, and Bee Hub mirrors it (lib/jobber-crew-mirror.ts).
// Until this change, ticking an assignee in Bee Hub called
// visitEditAssignedUsers on every unfinished visit of every linked job, which
// REPLACES that visit's crew: one tick would wipe whatever the owner had set in
// Jobber, visit by visit.
//
// A fingerprint is the full ordered list of everything the code says to
// Jobber for one fixed scenario: each read and each write, by operation name,
// with its exact variables. TODAY below was recorded by running this file
// against commit 647d645, before the change. The tests then prove three things
// against it, not against a description of it:
//   1. the picker's push is TODAY with the job legs taken out, and nothing else
//      moved (the assessment leg is byte-for-byte what it was);
//   2. no visit is written under any assignee set, including an empty one;
//   3. creation-time assignment (the assessment made on Send / Book assessment)
//      sends exactly what it sent at 647d645.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => {
  const state = { queue: [] as { table: string; data: any }[], said: [] as { kind: 'read' | 'write'; op: string; vars: any }[] }
  const builder = (table: string) => {
    const i = state.queue.findIndex(q => q.table === table)
    const resp = { data: i >= 0 ? state.queue.splice(i, 1)[0].data : null, error: null }
    const b: any = {}
    for (const m of ['select', 'eq', 'not', 'is', 'in', 'order', 'limit']) b[m] = () => b
    b.maybeSingle = () => Promise.resolve(resp)
    b.single = () => Promise.resolve(resp)
    b.then = (res: any, rej: any) => Promise.resolve(resp).then(res, rej)
    return b
  }
  const opName = (q: unknown) => (String(q).match(/(?:query|mutation)\s+(\w+)/) || [])[1] || 'unnamed'
  return { state, builder, opName }
})

const START = '2026-08-01T17:00:00Z' // 13:00 America/New_York
const END = '2026-08-01T18:00:00Z'

vi.mock('@/lib/supabase-service', () => ({ supabaseService: { from: (t: string) => h.builder(t) } }))
vi.mock('@/lib/sync-log', () => ({ writeSyncLog: async () => {} }))
vi.mock('@/lib/jobber', () => ({
  jobberGraphQL: async (_loc: string, query: string, vars: any) => {
    const op = h.opName(query)
    h.state.said.push({ kind: 'read', op, vars })
    if (op === 'AssessmentScheduleForSync') return { data: { assessment: { id: 'A', startAt: START, endAt: END } } }
    return { data: { job: { id: 'J', visits: { totalCount: 3, nodes: [
      { id: 'V1', isComplete: false }, { id: 'V2', isComplete: true }, { id: 'V3', isComplete: false },
    ] } } } }
  },
  jobberMutation: async (_loc: string, mutation: string, vars: any) => {
    const op = h.opName(mutation)
    h.state.said.push({ kind: 'write', op, vars })
    const ids: string[] = vars?.input?.schedule?.teamMemberIdsToAssign ?? []
    if (op === 'AssessmentEditTeam' || /assessmentEdit/.test(mutation)) {
      return { data: { assessmentEdit: { assessment: { id: 'A', startAt: START, endAt: END, assignedUsers: { nodes: ids.map(id => ({ id })) } } } }, userErrors: [] }
    }
    if (/assessmentCreate/.test(mutation)) {
      return { data: { assessmentCreate: { assessment: { id: 'A-NEW', assignedUsers: { nodes: ids.map(id => ({ id })) } } } }, userErrors: [] }
    }
    return { data: {}, userErrors: [] }
  },
}))

import { syncEngagementAssignmentToJobber } from '@/lib/engagement-assignee-sync'
import { createAssessmentOnRequest } from '@/lib/jobber-assessment-create'
import { encodeJobberId } from '@/lib/jobber-import'

const JOB = '141304145', ASSESS = '2123185874'
const person = (id: string, jobberId: string | null) => ({
  hub_user_id: id, created_at: '2026-07-01T00:00:00Z',
  hub_users: { id, full_name: id, first_name: null, last_name: null, email: `${id}@bee.test`, jobber_user_id: jobberId, location_id: 'LOC' },
})
const wire = (assignees: any[]) => {
  h.state.queue.push(
    { table: 'engagement_assignees', data: assignees },
    { table: 'engagements', data: { location_uuid: 'LOC' } },
    { table: 'jobs', data: [{ jobber_job_id: JOB, status: 'active' }] },
    { table: 'assessments', data: [{ jobber_assessment_id: ASSESS }] },
    { table: 'locations', data: { timezone: 'America/New_York' } },
  )
}
const pushWith = async (assignees: any[]) => {
  wire(assignees)
  const result = await syncEngagementAssignmentToJobber('eng-1', 'loc_test')
  return { result, said: h.state.said.slice() }
}

beforeEach(() => { h.state.queue = []; h.state.said = [] })

const ASSESSMENT_LEG = [
  { kind: 'read', op: 'AssessmentScheduleForSync', vars: { id: encodeJobberId('Assessment', ASSESS) } },
  { kind: 'write', op: 'AssessmentEditTeam', vars: {
    assessmentId: encodeJobberId('Assessment', ASSESS),
    input: { schedule: {
      startAt: { date: '2026-08-01', time: '13:00:00', timezone: 'America/New_York' },
      endAt: { date: '2026-08-01', time: '14:00:00', timezone: 'America/New_York' },
      teamMemberIdsToAssign: ['j1', 'j2'],
    } },
  } },
]

// RECORDED at 647d645 (two mapped assignees; one job with visits V1 open,
// V2 finished, V3 open; one assessment).
const TODAY = [
  { kind: 'read', op: 'JobVisitsForCrew', vars: { jobId: encodeJobberId('Job', JOB) } },
  { kind: 'write', op: 'VisitEditCrew', vars: { visitId: 'V1', input: { assignedUserIds: ['j1', 'j2'] } } },
  { kind: 'write', op: 'VisitEditCrew', vars: { visitId: 'V3', input: { assignedUserIds: ['j1', 'j2'] } } },
  ...ASSESSMENT_LEG,
]

const NOW = ASSESSMENT_LEG

describe('the assignee picker no longer writes to any visit', () => {
  it('the push is TODAY with the job legs taken out, and the assessment leg is exactly what it was', async () => {
    const { said, result } = await pushWith([person('u1', 'j1'), person('u2', 'j2')])
    expect(said).toEqual(NOW)
    // Stated against the recording, not beside it: what left is exactly the
    // visits read and the two visit writes, and what stayed did not move.
    const gone = TODAY.filter(t => !said.some(s => JSON.stringify(s) === JSON.stringify(t)))
    expect(gone.map(g => `${g.kind} ${g.op}`)).toEqual(['read JobVisitsForCrew', 'write VisitEditCrew', 'write VisitEditCrew'])
    expect(TODAY.filter(t => t.op.startsWith('Assessment'))).toEqual(said)
    expect(result).toMatchObject({ request: 'skipped', job: 'none', assessment: 'synced', visitsTouched: 0, mapped: 2, unmapped: 0 })
  })

  // TODAY's other shapes, each of which wrote to visits at 647d645:
  //   one person → that one on V1 and V3; NOBODY → an explicit [] on V1 and
  //   V3, which CLEARED the crew the owner had set in Jobber.
  const SETS: [string, any[], number][] = [
    ['two people linked to Jobber', [person('u1', 'j1'), person('u2', 'j2')], 2],
    ['one person', [person('u1', 'j1')], 2],
    ['nobody at all (this used to CLEAR every unfinished visit)', [], 0],
    ['only someone with no Jobber link', [person('u9', null)], 0],
  ]
  for (const [name, set, assessmentCalls] of SETS) {
    it(`${name}: no visit is read, no visit is written`, async () => {
      const { said, result } = await pushWith(set)
      expect(said.filter(s => /visit/i.test(s.op) || /visit/i.test(JSON.stringify(s.vars)))).toEqual([])
      expect(said.filter(s => s.kind === 'write').map(s => s.op).filter(op => op !== 'AssessmentEditTeam')).toEqual([])
      expect(said).toHaveLength(assessmentCalls)
      expect(result.job).toBe('none')
      expect(result.visitsTouched).toBe(0)
    })
  }

  it('the code that could write a visit is not in the file any more', () => {
    const code = readFileSync('lib/engagement-assignee-sync.ts', 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/visitEditAssignedUsers|VisitEditCrew|assignedUserIds|JobVisitsForCrew/)
    expect(code).not.toMatch(/from\('jobs'\)/)
    // The assessment leg is still there.
    expect(code).toMatch(/mutation AssessmentEditTeam/)
  })
})

describe('creation-time assignment is untouched', () => {
  // What Send to Jobber and Book assessment say to Jobber when they make the
  // assessment with a team: one write, the team inside the schedule.
  const CREATE_TODAY = [{ kind: 'write', op: 'AssessmentCreate', vars: {
    requestId: 'REQ-GID',
    input: { schedule: {
      startAt: { date: '2026-08-01', time: '13:00:00', timezone: 'America/New_York' },
      endAt: { date: '2026-08-01', time: '14:00:00', timezone: 'America/New_York' },
      teamMemberIdsToAssign: ['j1', 'j2'],
    } },
  } }]
  const create = (team: string[]) => createAssessmentOnRequest({
    locationSlug: 'loc_test', requestGlobalId: 'REQ-GID', scheduledAtIso: START,
    timezoneLabel: 'America/New_York', teamJobberIds: team, assessmentType: 'in-person',
  })

  it('making an assessment with a team sends exactly what it sent at 647d645, and the team is confirmed by read-back', async () => {
    const r: any = await create(['j1', 'j2'])
    expect(h.state.said).toEqual(CREATE_TODAY)
    expect(r.ok).toBe(true)
    expect(r.diff).toMatchObject({ ok: true })
  })

  it('with no team the field is left out entirely, as before (an explicit [] would read as a clear)', async () => {
    await create([])
    expect(h.state.said).toHaveLength(1)
    expect(Object.keys(h.state.said[0].vars.input.schedule)).toEqual(['startAt', 'endAt'])
  })

  it('the two files that build that call are byte-for-byte what they were at 647d645', () => {
    const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')
    expect(sha('lib/jobber-assessment-create.ts')).toBe('bb6a952a28ffa3f2bd19b4e236c3545a8ceda83363050efd59dd97784461f637')
    expect(sha('lib/jobber-assessment-assign.ts')).toBe('9a72febed898c97e7de36486526d5102924cfc7c6fba950d7c4a524509e61fb8')
  })
})
