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
// Status shape (deliberate, see the writeSyncLog note in lib/sync-log.ts):
//   · problems present → 'partial'. The client/request/assessment/job DO
//     exist, so 'error' would falsely say the send failed; 'success' hid the
//     failure. 'partial' is the only honest signal.
//   · no problems, something WAS requested → 'success' + 'assignment=ok'.
//   · nothing to assign (bare lead send) → 'success' + 'assignment=none'.
//
// issue 157 — the picked-but-unmapped case. An owner can pick an assignee who
// has no jobber_user_id (Kevin/Leslie, no Jobber identity). resolveJobberAssignment
// drops them from the Jobber push, so `requested` (mapped-count > 0) never sees
// them and the terminal row reported a bare 'assignment=ok' — a chosen person
// reached Jobber for nobody to see they didn't. Issue 148 already made the
// interactive picker honest about this; the send path now matches. Two counts
// close the gap:
//   · unmapped > 0 AND some mapped (requested) → still 'success' (NOTHING
//     failed — the mapped ones landed and the unmapped ones are correctly
//     assigned internally), but the segment STATES it and is no longer a bare
//     ok: 'assignment=ok(<mapped> of <total> to Jobber, <unmapped> internal-only)'.
//   · all-unmapped — assignees WERE picked but NONE map to Jobber (requested is
//     false, unmapped > 0) → 'success' + 'assignment=none(<unmapped> internal-only)'.
//     Nothing failed and nothing reached Jobber, but this MUST read differently
//     from a bare none: a bare none is the value a send with an EMPTY assignee
//     field produces, and conflating "nobody was picked" with "three people were
//     picked, none linked to Jobber" is the exact bug issue 157 exists to kill —
//     it cost real diagnosis time on a live send. (Log copy — kin to issue 148's
//     owner-facing "not linked to Jobber" line, not identical to it.)
//   · genuinely nobody picked (requested false, unmapped 0) → bare
//     'assignment=none'. That distinction is the whole point.
// mapped/unmapped are optional: absent → treated as 0, so every issue-145
// caller and the all-mapped path keep reporting exactly 'assignment=ok'/'none'.
//
// `problems` are already human-readable ("request salesperson dropped …",
// "assessment team incomplete …"); pass them in the order they occurred.
export function summarizeAssignmentOutcome(input: {
  requested: boolean
  problems: string[]
  mapped?: number
  unmapped?: number
}): { status: 'success' | 'partial'; segment: string } {
  const problems = input.problems.filter(Boolean)
  if (problems.length > 0) {
    return { status: 'partial', segment: `assignment=PARTIAL(${problems.join('; ')})` }
  }
  const unmapped = Number(input.unmapped) || 0
  // Nothing mapped reached Jobber. Two DIFFERENT sends land here and must NOT
  // read alike: assignees picked but none linked to Jobber (unmapped > 0), vs a
  // genuinely empty assignee field (unmapped 0 → bare none).
  if (!input.requested) {
    return {
      status: 'success',
      segment: unmapped > 0 ? `assignment=none(${unmapped} internal-only)` : 'assignment=none',
    }
  }
  if (unmapped > 0) {
    const mapped = Number(input.mapped) || 0
    const total = mapped + unmapped
    return {
      status: 'success',
      segment: `assignment=ok(${mapped} of ${total} to Jobber, ${unmapped} internal-only)`,
    }
  }
  return { status: 'success', segment: 'assignment=ok' }
}
