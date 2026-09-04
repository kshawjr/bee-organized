// issue 144 — assign the assessment team AT CREATION, and verify it took.
//
// Background: send-to-jobber used to create the assessment, then call
// appointmentEditAssignment(appointmentId) to attach the team. Live
// read-back (scout 143) found that mutation NEVER applied here — 0 of 22
// sent assessments with a mapped assignee carried the Bee Hub person.
// Assignment has never worked in production on this path.
//
// The fix assigns through the create itself. Live introspection
// (2026-07-31, loc_seattle, API 2025-04-16):
//   AssessmentCreateInput.schedule : ScheduledItemAttributes
//   ScheduledItemAttributes.teamMemberIdsToAssign : [EncodedId!]
//   ScheduledItemAttributes.notifyTeam            : Boolean
//   Assessment.assignedUsers                      : UserConnection
// so the create response reads back via `assignedUsers { nodes { id } }`.
//
// These two helpers are pure so the wiring is unit-testable without a live
// Jobber round-trip: one builds the schedule input, the other diffs what we
// asked to assign against what the create returned.

// Attach teamMemberIdsToAssign to a schedule object — but ONLY when there is
// at least one resolved assignee. An empty or unresolved list omits the field
// entirely: Jobber reads an explicit `[]` as a deliberate clear, and a create
// must never look like an intentional unassign. Returns a NEW object; the
// input is never mutated.
export function applyTeamToSchedule<T extends Record<string, any>>(
  schedule: T,
  teamMemberJobberIds: string[],
): T {
  if (!teamMemberJobberIds.length) return schedule
  return { ...schedule, teamMemberIdsToAssign: teamMemberJobberIds }
}

export type AssessmentAssignmentDiff = {
  ok: boolean
  requested: string[]
  returned: string[]
  missing: string[]    // asked to assign, but not present in the create result
  unexpected: string[] // present in the result, but never asked for
}

// Compare the team we asked Jobber to assign (already-encoded User gids)
// against what the create returned (assessment.assignedUsers.nodes[].id, also
// encoded User gids). Order-independent, de-duplicated on both sides. The
// caller surfaces any discrepancy rather than swallowing it — nothing checked
// the result before, which is exactly why the silent failure lived in prod.
export function diffAssessmentAssignment(
  requestedJobberIds: string[],
  returnedAssignedUsers: Array<{ id?: string | null }> | null | undefined,
): AssessmentAssignmentDiff {
  const requested = Array.from(new Set(requestedJobberIds.filter(Boolean)))
  const returned = Array.from(
    new Set((returnedAssignedUsers ?? []).map(u => u?.id).filter((x): x is string => !!x)),
  )
  const returnedSet = new Set(returned)
  const requestedSet = new Set(requested)
  const missing = requested.filter(id => !returnedSet.has(id))
  const unexpected = returned.filter(id => !requestedSet.has(id))
  return { ok: missing.length === 0 && unexpected.length === 0, requested, returned, missing, unexpected }
}

// issue 145 — summarize the WHOLE send's assignment outcome for the terminal
// sync_log row. Before this, that row was hard-coded status:'success', so a
// send whose salesperson/team assignment silently failed still reported clean
// — the root cause of the 3-week silence (0 of 22 assessments carried the
// assignee, and not one breadcrumb named assignment). The individual sub-steps
// still write their own topic= breadcrumb (the 144 convention, e.g.
// ASSESSMENT_TEAM_MISMATCH / *_ASSIGN_RETRY); this folds them into the send
// summary so the terminal row can no longer claim clean success while an
// assignment degraded. It is the summary seam, not a second parallel one.
//
// issue 158 — THE TOKEN NOW REPORTS WHAT LANDED, NOT WHAT RESOLVED.
//
// The lie this replaces: the old input was `requested: boolean`, computed at
// the top of the send as `allAssigneeJobberIds.length > 0` — i.e. "we HAVE a
// Jobber-linked assignee". It never asked whether that person was pushed
// anywhere. A request-only send on a bare lead has no assessment to carry a
// team and (before issue 158) set no salesperson, so it pushed NOTHING and
// still reported a clean `assignment=ok`. 67 real sends across 19 locations
// read that way between 2026-07-31 and 2026-09-03, and the token is exactly
// what made them look fine. `requested` is GONE — not softened, removed, so
// no caller can reintroduce the conflation.
//
// The input is now the set of things that actually reached Jobber:
//   landed.salesperson  — salespersonId was accepted on the request and/or job
//                         (false when it was never sent OR was dropped on the
//                         rejection retry, which is separately a `problem`)
//   landed.teamVerified — how many ids came BACK in assessment.assignedUsers,
//                         i.e. read-back-proven, not merely requested
// mapped/unmapped stay as they were: who was resolvable to a Jobber identity,
// and who was picked but has none.
//
// Status shape (deliberate, see the writeSyncLog note in lib/sync-log.ts):
//   · problems present → 'partial'. The client/request/assessment/job DO
//     exist, so 'error' would falsely say the send failed; 'success' hid the
//     failure. 'partial' is the only honest signal.
//   · something landed → 'success' + `assignment=ok(<what landed>)`, naming
//     each destination. A bare `assignment=ok` is no longer producible.
//   · nothing landed → 'success' (nothing FAILED) but the segment says so:
//       - mapped people existed and none was pushed →
//         `assignment=none(<n> mapped, nothing reached Jobber)`. This is the
//         honest form of the 67. It must never read as ok again.
//       - people picked, none linked to Jobber (issue 157) →
//         `assignment=none(<n> internal-only)`
//       - genuinely nobody picked → bare `assignment=none`
//
// `problems` are already human-readable ("request salesperson dropped …",
// "assessment team incomplete …"); pass them in the order they occurred.
export type AssignmentLanded = {
  // salespersonId accepted on the request and/or the job.
  salesperson?: boolean
  // ids confirmed present in assessment.assignedUsers on the create read-back.
  teamVerified?: number
}

export function summarizeAssignmentOutcome(input: {
  problems: string[]
  mapped?: number
  unmapped?: number
  landed?: AssignmentLanded
}): { status: 'success' | 'partial'; segment: string } {
  const problems = input.problems.filter(Boolean)
  if (problems.length > 0) {
    return { status: 'partial', segment: `assignment=PARTIAL(${problems.join('; ')})` }
  }

  const mapped = Number(input.mapped) || 0
  const unmapped = Number(input.unmapped) || 0
  const salesperson = !!input.landed?.salesperson
  const teamVerified = Number(input.landed?.teamVerified) || 0

  // What actually reached Jobber, named. Order is the order of the send.
  const destinations: string[] = []
  if (salesperson) destinations.push('salesperson')
  if (teamVerified > 0) destinations.push(`team ${teamVerified} of ${mapped}`)

  // NOTHING reached Jobber. Three different sends land here and must NOT read
  // alike — conflating them is the whole bug this replaces.
  if (destinations.length === 0) {
    // Mapped people existed and not one was pushed. The 67. Nothing failed —
    // there was simply no Jobber field to hold them — but the row must say it.
    if (mapped > 0) {
      const tail = unmapped > 0 ? `, ${unmapped} internal-only` : ''
      return {
        status: 'success',
        segment: `assignment=none(${mapped} mapped, nothing reached Jobber${tail})`,
      }
    }
    // Assignees picked, none linked to Jobber (issue 157).
    if (unmapped > 0) {
      return { status: 'success', segment: `assignment=none(${unmapped} internal-only)` }
    }
    // Genuinely nobody picked.
    return { status: 'success', segment: 'assignment=none' }
  }

  const tail = unmapped > 0 ? `, ${unmapped} internal-only` : ''
  return { status: 'success', segment: `assignment=ok(${destinations.join(', ')}${tail})` }
}
