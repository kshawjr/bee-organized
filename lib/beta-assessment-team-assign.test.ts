// @vitest-environment node
//
// issue 144 — assign the assessment team INSIDE assessmentCreate, not after.
//
// Scout 143 (confirmed by live read-back): the old flow created the
// assessment and THEN called appointmentEditAssignment(appointmentId) to
// attach the team. It NEVER applied — 0 of 22 sent assessments with a mapped
// assignee carried the Bee Hub person. Assignment has never worked in prod on
// this path.
//
// The fix assigns through the create via ScheduledItemAttributes.
// teamMemberIdsToAssign, and READS BACK assessment.assignedUsers to verify the
// create actually applied the team (nothing checked before — that is why the
// silent failure survived 22 sends).
//
// INTROSPECTED LIVE 2026-07-31 (loc_seattle, API 2025-04-16):
//   AssessmentCreateInput.schedule                : ScheduledItemAttributes
//   ScheduledItemAttributes.teamMemberIdsToAssign : [EncodedId!]
//   ScheduledItemAttributes.notifyTeam            : Boolean
//   Assessment.assignedUsers                      : UserConnection  → { nodes { id } }
//
// LIMITS OF UNIT TESTING (stated plainly): these tests pin the REQUEST we
// build and the way we react to a RESPONSE. They CANNOT assert that Jobber's
// assessmentCreate honors teamMemberIdsToAssign, nor that a real
// assessment.assignedUsers comes back populated — both require a live mutation
// against the production Jobber API, which is out of scope here. What is
// provable without a live call: the field is present in the schedule when
// assignees resolve and absent when they don't; a returned/requested mismatch
// is detected and surfaced rather than swallowed. Those are below.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

import {
  applyTeamToSchedule,
  diffAssessmentAssignment,
} from '@/lib/jobber-assessment-assign'

const ROUTE = 'app/api/leads/[id]/send-to-jobber/route.ts'

// ── 1) applyTeamToSchedule — the field is present iff assignees resolve ─────
describe('applyTeamToSchedule', () => {
  const base = { startAt: { date: '2026-08-01', time: '09:00' }, endAt: { date: '2026-08-01', time: '10:00' } }

  it('adds teamMemberIdsToAssign when there is at least one resolved assignee', () => {
    const out = applyTeamToSchedule(base, ['gid://Jobber/User/1', 'gid://Jobber/User/2'])
    expect(out.teamMemberIdsToAssign).toEqual(['gid://Jobber/User/1', 'gid://Jobber/User/2'])
    // the schedule the mutation receives carries the team
    expect(Object.keys(out)).toContain('teamMemberIdsToAssign')
  })

  it('OMITS the field entirely when the list is empty — never an explicit [] (a clear)', () => {
    const out = applyTeamToSchedule(base, [])
    expect('teamMemberIdsToAssign' in out).toBe(false)
    // and the create input built from it therefore carries no team key
    expect(JSON.stringify({ schedule: out })).not.toContain('teamMemberIdsToAssign')
  })

  it('does not mutate the input schedule', () => {
    const input = { ...base }
    const out = applyTeamToSchedule(input, ['gid://Jobber/User/1'])
    expect('teamMemberIdsToAssign' in input).toBe(false) // original untouched
    expect(out).not.toBe(input)                           // a new object
    expect(out.startAt).toEqual(base.startAt)             // start/end preserved
    expect(out.endAt).toEqual(base.endAt)
  })
})

// ── 2) diffAssessmentAssignment — mismatch is detected, not swallowed ───────
describe('diffAssessmentAssignment', () => {
  it('full match → ok, nothing missing or unexpected', () => {
    const d = diffAssessmentAssignment(
      ['gid://User/1', 'gid://User/2'],
      [{ id: 'gid://User/1' }, { id: 'gid://User/2' }],
    )
    expect(d.ok).toBe(true)
    expect(d.missing).toEqual([])
    expect(d.unexpected).toEqual([])
  })

  it('the prod bug: requested a team but the create returned NOBODY → not ok, all missing', () => {
    // This is exactly the 0-of-22 failure — we asked, the appointment came
    // back empty. Before the fix nothing looked; now the diff catches it.
    const d = diffAssessmentAssignment(['gid://User/1', 'gid://User/2'], [])
    expect(d.ok).toBe(false)
    expect(d.missing).toEqual(['gid://User/1', 'gid://User/2'])
  })

  it('null/undefined assignedUsers is treated as empty, still a surfaced mismatch', () => {
    expect(diffAssessmentAssignment(['gid://User/1'], null).ok).toBe(false)
    expect(diffAssessmentAssignment(['gid://User/1'], undefined).missing).toEqual(['gid://User/1'])
  })

  it('partial apply → missing lists only the ones that did not take', () => {
    const d = diffAssessmentAssignment(
      ['gid://User/1', 'gid://User/2', 'gid://User/3'],
      [{ id: 'gid://User/2' }],
    )
    expect(d.ok).toBe(false)
    expect(d.missing).toEqual(['gid://User/1', 'gid://User/3'])
    expect(d.unexpected).toEqual([])
  })

  it('a user Jobber assigned that we never asked for is flagged unexpected', () => {
    const d = diffAssessmentAssignment(
      ['gid://User/1'],
      [{ id: 'gid://User/1' }, { id: 'gid://User/99' }],
    )
    expect(d.ok).toBe(false)
    expect(d.missing).toEqual([])
    expect(d.unexpected).toEqual(['gid://User/99'])
  })

  it('order-independent and de-duplicated on both sides', () => {
    const d = diffAssessmentAssignment(
      ['gid://User/2', 'gid://User/1', 'gid://User/1'],
      [{ id: 'gid://User/1' }, { id: 'gid://User/2' }, { id: 'gid://User/2' }],
    )
    expect(d.ok).toBe(true)
    expect(d.requested).toEqual(['gid://User/2', 'gid://User/1'])
    expect(d.returned).toEqual(['gid://User/1', 'gid://User/2'])
  })

  it('drops null/empty ids on the returned side (defensive against sparse nodes)', () => {
    const d = diffAssessmentAssignment(
      ['gid://User/1'],
      [{ id: 'gid://User/1' }, { id: null }, {}],
    )
    expect(d.ok).toBe(true)
    expect(d.returned).toEqual(['gid://User/1'])
  })
})

// ── 3) route wiring (source pins) — the create carries and verifies the team ─
// These read the route source rather than invoking the POST handler (its live
// deps — Supabase, Jobber, timezone resolution — are not mounted here; the
// repo pins route wiring this way, see jobber-request-form.test.ts).
describe('send-to-jobber route wiring (issue 144)', () => {
  const route = readFileSync(ROUTE, 'utf8')

  it('the assessmentCreate response reads back assignedUsers so the result can be verified', () => {
    expect(route).toContain('assessmentCreate(requestId: $requestId, input: $input)')
    expect(route).toContain('assignedUsers { nodes { id } }')
  })

  it('the team is assigned AT CREATION — schedule built via applyTeamToSchedule from the resolved ids', () => {
    expect(route).toContain("import { applyTeamToSchedule, diffAssessmentAssignment } from '@/lib/jobber-assessment-assign'")
    expect(route).toContain('const schedule = applyTeamToSchedule(')
    expect(route).toContain('allAssigneeJobberIds,')
    // the create input is fed the schedule that (conditionally) carries the team
    expect(route).toContain('input: { schedule },')
  })

  it('the returned assignedUsers are diffed against the requested set and a mismatch is SURFACED', () => {
    expect(route).toContain('diffAssessmentAssignment(')
    expect(route).toContain('createdAssessment?.assignedUsers?.nodes')
    expect(route).toContain('if (!diff.ok)')
    // surfaced two ways: a loud console warn AND a sync_log breadcrumb...
    expect(route).toContain('assessment team mismatch')
    expect(route).toContain('ASSESSMENT_TEAM_MISMATCH (issue 144)')
    // ...and the breadcrumb is an ERROR, not a silent success
    expect(route).toMatch(/ASSESSMENT_TEAM_MISMATCH[\s\S]{0,400}status:\s*'error'|status:\s*'error'[\s\S]{0,400}ASSESSMENT_TEAM_MISMATCH/)
  })

  it('the confirmed-nonfunctional appointmentEditAssignment call is GONE from this path', () => {
    // the mutation const and its unique input field must not survive
    expect(route).not.toContain('APPOINTMENT_EDIT_ASSIGNMENT_MUTATION')
    expect(route).not.toContain('assignedUserIds')
  })

  it('notifyTeam is NEVER set — team emails wait for Kevin', () => {
    // the word appears in an explanatory comment, but never as an input key
    expect(route).not.toMatch(/notifyTeam\s*:/)
  })

  it('comments use the "issue 144" form, never the "#144" hex-sweep trap', () => {
    expect(route).toContain('issue 144')
    expect(route).not.toContain('#144')
  })
})

// ── 4) what CANNOT be asserted here (documented, not silently skipped) ───────
describe('live-only guarantees (require a real Jobber mutation — out of scope)', () => {
  it.todo('assessmentCreate actually persists teamMemberIdsToAssign onto the appointment')
  it.todo('assessment.assignedUsers comes back populated with the sent team after a real create')
})
