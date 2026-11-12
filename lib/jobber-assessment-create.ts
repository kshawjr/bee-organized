// lib/jobber-assessment-create.ts
//
// THE one place Bee Hub creates a Jobber assessment on a request.
//
// Lifted out of app/api/leads/[id]/send-to-jobber/route.ts unchanged (a
// route file may only export its HTTP verbs, so the code had to move to be
// shared). Two callers:
//   · Send to Jobber, "Request + Assessment" — the request is created a
//     moment before, then this books the assessment on it.
//   · Book assessment (POST /api/engagements/:id/assessment) — the request
//     was sent earlier as "Request only"; this books the assessment on THAT
//     request. Owners used to make a brand new request in Jobber instead,
//     which is where the twin cards came from (2026-11 investigation).
//
// What it does, in order, exactly as the send route always did:
//   1. Resolve the location's timezone label to an IANA zone
//      (requireIanaTimezone — throws on anything it can't resolve; no silent
//      fallback, a wrong zone misplaces the appointment on the calendar).
//   2. Build a one-hour schedule in the location's local wall-clock pieces
//      (Jobber's LocalDateTimeAttributes { date, time, timezone }).
//   3. Assign the team AT CREATION via teamMemberIdsToAssign (issue 144) —
//      omitted entirely when nobody resolves, never an explicit [] (a clear).
//   4. Virtual → the field team's note as `instructions`; in-person → no key.
//   5. assessmentCreate(requestId, input) — Jobber books it ON the request.
//      No request is created here, ever.
//   6. Read back assignedUsers and diff against the team we asked for, so a
//      silent assignment failure is caught (issue 144). The caller decides
//      how to report it.
//
// Writes nothing locally. Callers write their own breadcrumbs and mirror rows
// only after this returns ok, so a Jobber refusal leaves nothing half-written.

import { formatInTimeZone } from 'date-fns-tz'
import { jobberMutation } from '@/lib/jobber'
import { requireIanaTimezone } from '@/lib/drip-time'
import { applyTeamToSchedule, diffAssessmentAssignment, type AssessmentAssignmentDiff } from '@/lib/jobber-assessment-assign'
import { assessmentInstructions } from '@/lib/assessment-type'

// Jobber moved `requestId` out of AssessmentCreateInput and onto the
// mutation as a top-level arg; the input now only carries `instructions`
// and `schedule: ScheduledItemAttributes`. Inside schedule, startAt/endAt
// are LocalDateTimeAttributes objects, not ISO strings.
// issue 144 — the team is assigned AT CREATION via schedule.
// teamMemberIdsToAssign (see the schedule build below). We read back
// assignedUsers here so the caller can VERIFY the create applied the team:
// the reason the old post-create appointmentEditAssignment failure went
// unnoticed for 22 sends is that nothing ever checked the result.
// assignedUsers is a UserConnection (introspected live 2026-07-31), hence
// the { nodes { id } } selection.
export const ASSESSMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation AssessmentCreate(
    $requestId: EncodedId!,
    $input: AssessmentCreateInput!
  ) {
    assessmentCreate(requestId: $requestId, input: $input) {
      assessment {
        id
        assignedUsers { nodes { id } }
      }
      userErrors { message path }
    }
  }
`

// Jobber's ScheduledItemAttributes uses LocalDateTimeAttributes { date,
// time, timezone } for startAt/endAt — not an ISO 8601 string. Convert the
// stored UTC ISO timestamp into the location's local wall-clock pieces so
// Jobber renders the appointment in the right zone.
export function toLocalDateTime(iso: string, timezone: string) {
  const ms = new Date(iso).getTime()
  return {
    date:     formatInTimeZone(ms, timezone, 'yyyy-MM-dd'),
    time:     formatInTimeZone(ms, timezone, 'HH:mm:ss'),
    timezone,
  }
}

export type CreateAssessmentResult =
  | { ok: false; stage: 'validation'; error: string }        // timezone did not resolve
  | { ok: false; stage: 'assessment_create'; error: string } // Jobber refused
  | {
      ok: true
      assessmentGlobalId: string | null
      startMs: number
      // null when no team was asked for (nothing to verify).
      diff: AssessmentAssignmentDiff | null
    }

export async function createAssessmentOnRequest(args: {
  locationSlug: string
  requestGlobalId: string
  scheduledAtIso: string
  timezoneLabel: unknown            // locations.timezone, label or IANA
  teamJobberIds: string[]
  assessmentType: unknown           // 'in-person' | 'virtual' | undefined
}): Promise<CreateAssessmentResult> {
  const { locationSlug, requestGlobalId, scheduledAtIso, teamJobberIds, assessmentType } = args

  // Assessments are time-boxed; Jobber's UI defaults to 1hr if endAt
  // is omitted. We mirror that by sending a 1hr endAt explicitly so
  // calendar views render with a sensible block.
  const startMs = new Date(scheduledAtIso).getTime()
  const endMs   = startMs + 60 * 60 * 1000
  // Jobber's LocalDateTimeAttributes requires an IANA timezone. The
  // locations.timezone column historically stores friendly labels like
  // "Eastern Time (ET)"; requireIanaTimezone translates known labels and
  // throws on anything it can't confidently resolve. No silent fallback —
  // a wrong zone misplaces appointments on the customer's calendar.
  let tz: string
  try {
    tz = requireIanaTimezone(args.timezoneLabel as any)
  } catch (err: any) {
    return { ok: false, stage: 'validation', error: err?.message || 'invalid location timezone' }
  }
  // issue 144 — assign the team AT CREATION. The old flow created the
  // assessment and THEN called appointmentEditAssignment(appointmentId);
  // live read-back proved it never applied (0 of 22 sent assessments
  // carried the assigned person). ScheduledItemAttributes.
  // teamMemberIdsToAssign is [EncodedId!] (introspected live 2026-07-31);
  // the ids are already-encoded User gids. An empty/unresolved list omits
  // the field entirely — an explicit [] would read as a deliberate clear.
  // notifyTeam is deliberately left UNSET: turning on anything that emails a
  // franchise team member needs Kevin's ok first.
  const schedule = applyTeamToSchedule(
    {
      startAt: toLocalDateTime(new Date(startMs).toISOString(), tz),
      endAt:   toLocalDateTime(new Date(endMs).toISOString(),   tz),
    },
    teamJobberIds,
  )
  const assessCreate = await jobberMutation(
    locationSlug,
    ASSESSMENT_CREATE_MUTATION,
    {
      requestId: requestGlobalId,
      // Virtual → the field team's note in Jobber (the only place they
      // see the type). In-person → no instructions key at all, so the
      // input is exactly what it was before (lib/assessment-type.ts).
      input: {
        schedule,
        ...(assessmentInstructions(assessmentType)
          ? { instructions: assessmentInstructions(assessmentType) }
          : {}),
      },
    },
  )
  if (assessCreate.userErrors?.length) {
    return { ok: false, stage: 'assessment_create', error: assessCreate.userErrors[0].message }
  }
  const createdAssessment = assessCreate.data?.assessmentCreate?.assessment || null

  // issue 144 — VERIFY the create actually applied the team. Compare what we
  // asked to assign against assessment.assignedUsers. Only when we asked.
  const diff = teamJobberIds.length > 0
    ? diffAssessmentAssignment(teamJobberIds, createdAssessment?.assignedUsers?.nodes)
    : null

  return { ok: true, assessmentGlobalId: createdAssessment?.id || null, startMs, diff }
}
