// lib/engagement-assignee-sync.ts
// ─────────────────────────────────────────────────────────────
// Engagement-level assignees → Jobber TEAM/CREW push.
//
// Assignees are the people who DO the work — the assessment team and the
// job crew — PLURAL. They are NOT the deal's salesperson (Kevin 7/11).
// Assignment lives on the engagement_assignees junction (many hub_users
// per engagement); this module resolves that set to Jobber user ids and
// pushes ALL of them onto the engagement's linked work records.
//
// INTROSPECTED LIVE 2026-07-11 / re-introspected 2026-07-31 (loc_test/
// loc_seattle, API 2025-04-16) — the crew/team surfaces, and the one place a
// team does NOT exist:
//   · Assessment team: assessmentEdit (issue 147). NOT appointmentEditAssignment.
//       assessmentEdit(assessmentId: EncodedId!, input: AssessmentEditInput!)
//       AssessmentEditInput.schedule : ScheduledItemAttributes
//       ScheduledItemAttributes.teamMemberIdsToAssign : [EncodedId!] — MULTI
//     WHY THE SWITCH (scout 147, live-introspected — do not re-litigate):
//     jobber_assessment_id holds an ASSESSMENT node id. appointmentEditAssignment
//     wants an APPOINTMENT id, and the live Assessment type has NO appointment
//     field — so no valid id was ever feedable to it. A wrong-node-type id comes
//     back as a success shape with an EMPTY userErrors array: a SILENT no-op.
//     Prod sync_log showed assessment=synced at loc_kc/loc_omaha/loc_palmbeach
//     while a live read-back found 0 of 22 assessments carried the assignee.
//     assessmentEdit is keyed by the assessment id we already store, uses the
//     SAME teamMemberIdsToAssign field the send path assigns with at create
//     (issue 144), and — critically — its result is VERIFIED by reading back
//     assignedUsers, because a clean userErrors array is not proof here.
//   · Job crew: NOT a field on the job. JobEditInput carries only
//       salespersonId (singular) — no crew. The crew lives on the job's
//       VISITS. Read job(id).visits.nodes { id isComplete }, then per visit:
//       visitEditAssignedUsers(visitId, VisitEditAssignedUsersInput)
//       VisitEditAssignedUsersInput.assignedUserIds : [EncodedId!]! — MULTI
//   · Request: RequestEditInput has only salespersonId (singular) — NO team
//       concept. A request is pre-work (intake), so a crew doesn't apply.
//       We DELIBERATELY do NOT assign requests anymore (was Build-3
//       salesperson wiring). Assignment starts at the actual work =
//       assessment + job. `request: 'skipped'` records that in the result
//       and breadcrumb. (Open decision for Kevin: keep owner-as-salesperson
//       on the request? Default = no.)
//
// So: the SAME full set of mapped assignees goes onto the assessment AND
// every (non-completed) visit of every linked job. An empty set clears the
// visit crew (visitEditAssignedUsers accepts an explicit [] as a clear); it
// does NOT clear the assessment team — teamMemberIdsToAssign is assign-oriented
// and is omitted for an empty list (issue 147; see the assessment leg). Completed
// visits are left untouched — crew is about who WILL do the work, not a rewrite
// of finished history.
//
// SCHEDULE PRESERVATION (issue 147): teamMemberIdsToAssign rides inside
// ScheduledItemAttributes, the same object that carries startAt/endAt. Those
// are nullable, but sending `schedule` with them ABSENT is unverified against
// Jobber's edit semantics — if absent read as "clear", we would WIPE the
// appointment time on every assessment we touch. So we mirror the create path:
// read the assessment's current startAt/endAt LIVE, convert to the location's
// local wall-clock, and pass them back alongside the team. A read-back guard
// then confirms the time did not move (see hasScheduleDrift).
//
// ENCODED-ID CONTRACT: every id fed to an EncodedId! arg must be the full
// base64 global id (gid://Jobber/<Type>/<n>), never the bare numeric — Jobber
// rejects a bare number with "'<n>' is not a valid EncodedId". Our jobber_*_id
// columns store the numeric tail (extractJobberId at import), so jobId and
// assessmentId are re-encoded here via encodeJobberId (matching contact-/
// address-sync). NOTE the encode STAYS under issue 147: encodeJobberId('Assessment',
// …) builds exactly the Assessment gid assessmentEdit demands — it was never the
// bug; the bug was feeding that Assessment gid to appointmentEditAssignment, which
// wanted an Appointment id. Two ids need NO re-encode: visit ids arrive
// already-encoded from the visits read, and jobber_user_id is stored
// already-encoded by the roster — so assignedUserIds pass through untouched.
//
// UNMAPPED assignees (hub_user with no jobber_user_id — e.g. Kevin/Leslie,
// no Jobber identity) are valid internal assignments but are simply
// skipped for the Jobber push; the UI marks them so it's not a surprise.
//
// ECHO-SAFE BY CONSTRUCTION: no inbound webhook topic reads or writes
// engagement_assignees. assessmentEdit / visitEditAssignedUsers fire no
// webhook we subscribe to that touches the junction — so a crew push cannot
// loop back. Nothing to guard against.
//
// Every push is NON-FATAL: the junction write already committed; a failed
// Jobber mutation logs a breadcrumb (sync_log, entity_type 'engagement')
// and rides the API response so the toast can tell the truth.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { jobberMutation, jobberGraphQL } from './jobber'
import { encodeJobberId } from './jobber-import'
import { writeSyncLog } from './sync-log'
import { requireIanaTimezone } from './drip-time'
import { formatInTimeZone } from 'date-fns-tz'
// issue 147 — reuse issue 144's PURE helpers (do not write a second builder or
// differ). applyTeamToSchedule attaches teamMemberIdsToAssign (omitting it for
// an empty list); diffAssessmentAssignment proves the team actually applied.
import { applyTeamToSchedule, diffAssessmentAssignment } from './jobber-assessment-assign'

// Read a job's visits so we can push the crew onto each. first: 100 covers
// every real one-off/recurring job; if a job somehow has more we log the
// cap rather than silently under-assign (see VISIT_PAGE below).
const JOB_VISITS_QUERY = `
  query JobVisitsForCrew($jobId: EncodedId!) {
    job(id: $jobId) {
      id
      visits(first: 100) {
        totalCount
        nodes { id isComplete }
      }
    }
  }
`
const VISIT_PAGE = 100

const VISIT_EDIT_ASSIGNED_USERS_MUTATION = `
  mutation VisitEditCrew($visitId: EncodedId!, $input: VisitEditAssignedUsersInput!) {
    visitEditAssignedUsers(visitId: $visitId, input: $input) {
      visit { id }
      userErrors { message path }
    }
  }
`

// issue 147 — read the assessment's CURRENT schedule so the edit can re-send
// startAt/endAt UNCHANGED (see the SCHEDULE PRESERVATION note in the header).
// root query assessment(id: EncodedId!) exists (introspected 2026-07-31).
const ASSESSMENT_SCHEDULE_QUERY = `
  query AssessmentScheduleForSync($id: EncodedId!) {
    assessment(id: $id) { id startAt endAt }
  }
`

// issue 147 — assign the assessment team via assessmentEdit (NOT
// appointmentEditAssignment; see header for why that never applied). The
// response selection reads back assignedUsers AND startAt/endAt so the caller
// can VERIFY both the team took and the schedule did not move — a clean
// userErrors array is not proof here.
const ASSESSMENT_EDIT_MUTATION = `
  mutation AssessmentEditTeam($assessmentId: EncodedId!, $input: AssessmentEditInput!) {
    assessmentEdit(assessmentId: $assessmentId, input: $input) {
      assessment {
        id
        startAt
        endAt
        assignedUsers { nodes { id } }
      }
      userErrors { message path }
    }
  }
`

// Jobber's ScheduledItemAttributes wants LocalDateTimeAttributes { date, time,
// timezone } for startAt/endAt — not an ISO string. Convert a stored UTC ISO
// instant into the location's local wall-clock pieces (mirrors the identical
// helper in the send path). issue 147.
function toLocalDateTime(iso: string, timezone: string) {
  const ms = new Date(iso).getTime()
  return {
    date:     formatInTimeZone(ms, timezone, 'yyyy-MM-dd'),
    time:     formatInTimeZone(ms, timezone, 'HH:mm:ss'),
    timezone,
  }
}

// issue 147 — SCHEDULE GUARD. We send the assessment's existing startAt/endAt
// back with the team edit; this confirms the edit did not move or wipe them.
// Compare by parsed instant (not string) to tolerate format normalization, and
// only assert on a field that actually existed before (so we never flag a time
// we deliberately did not send). A time that existed before and is gone/changed
// after IS drift.
function hasScheduleDrift(
  before: { startAt?: string | null; endAt?: string | null } | null | undefined,
  after: { startAt?: string | null; endAt?: string | null } | null | undefined,
): boolean {
  const inst = (v: any) => {
    const ms = v ? new Date(v).getTime() : NaN
    return Number.isFinite(ms) ? ms : null
  }
  for (const field of ['startAt', 'endAt'] as const) {
    const b = inst(before?.[field])
    const a = inst(after?.[field])
    if (b !== null && a !== b) return true
  }
  return false
}

// issue 147 — persist an assessment-assignment problem as its OWN sync_log row.
// A mismatch/drift/failure MUST leave a durable trace (the send-path convention,
// topic=ASSESSMENT_TEAM_MISMATCH); console.warn alone is exactly what let the
// 3-week silence survive. This is IN ADDITION to the terminal summary row.
async function persistAssessmentProblem(
  locationSlug: string,
  engagementId: string,
  assessmentGid: string,
  detail: string,
): Promise<void> {
  await writeSyncLog({
    location_id: locationSlug,
    entity_id: engagementId,
    entity_type: 'engagement',
    direction: 'outbound',
    status: 'error',
    message:
      `[engagement:assignee-sync] topic=ASSESSMENT_TEAM_MISMATCH (issue 147) ` +
      `assessment=${assessmentGid} ${detail}`,
  })
}

export type EngagementAssignee = {
  hub_user_id: string
  name: string | null
  email: string | null
  jobber_user_id: string | null
}

// The junction → hub_users join, ordered by assignment time (created_at)
// so "primary" is stable = the first person assigned.
export async function getEngagementAssignees(engagementId: string): Promise<EngagementAssignee[]> {
  const { data, error } = await supabaseService
    .from('engagement_assignees')
    .select('hub_user_id, created_at, hub_users(id, full_name, first_name, last_name, email, jobber_user_id)')
    .eq('engagement_id', engagementId)
    .order('created_at', { ascending: true })
  if (error || !data) return []
  return data.map((row: any) => {
    const u = Array.isArray(row.hub_users) ? row.hub_users[0] : row.hub_users
    const name = u?.full_name || [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim() || null
    return {
      hub_user_id: row.hub_user_id,
      name: name || u?.email || null,
      email: u?.email ?? null,
      jobber_user_id: u?.jobber_user_id ?? null,
    }
  })
}

// Resolve the Jobber-facing crew/team set from the assignees.
//   all     = every mapped assignee — the crew/team pushed to both the
//             assessment appointment and each job visit (both MULTI).
//   primary = first mapped assignee, retained only as metadata (the
//             owner-as-salesperson decision is open — see request notes).
export function resolveJobberAssignment(assignees: EngagementAssignee[]) {
  const mapped = assignees.filter(a => a.jobber_user_id)
  return {
    primaryJobberUserId: mapped[0]?.jobber_user_id ?? null,
    allJobberUserIds: mapped.map(a => a.jobber_user_id as string),
    mappedCount: mapped.length,
    unmappedCount: assignees.length - mapped.length,
  }
}

export type AssignmentSyncResult = {
  // request is intentionally never assigned under the team model — a
  // request is pre-work with no crew concept. 'skipped' is the only value.
  request: 'skipped'
  // job = the crew push across the job's (non-completed) visits.
  job: 'synced' | 'cleared' | 'failed' | 'none'
  // assessment = the team push via assessmentEdit (issue 147).
  //   synced = team applied AND verified by read-back; failed = mutation error,
  //   read-back mismatch, schedule drift, or missing/invalid location timezone;
  //   none = no team to push (nobody mapped — assessmentEdit is not used to
  //   clear) or no linked assessment. 'cleared' is NOT used on this axis.
  assessment: 'synced' | 'cleared' | 'failed' | 'none'
  visitsTouched: number
  mapped: number
  unmapped: number
}

// Push the engagement's current assignee set onto its linked Jobber
// records. Idempotent — Jobber stores the last-written value; re-running
// with the same set is a no-op on Jobber's side. Non-fatal throughout.
//
// locationSlug is locations.location_id (the jobberMutation key). Callers
// that only hold location_uuid can resolve it via this module's
// resolveLocationSlug helper.
export async function syncEngagementAssignmentToJobber(
  engagementId: string,
  locationSlug: string,
): Promise<AssignmentSyncResult> {
  const assignees = await getEngagementAssignees(engagementId)
  const { allJobberUserIds, mappedCount, unmappedCount } =
    resolveJobberAssignment(assignees)

  const result: AssignmentSyncResult = {
    request: 'skipped', job: 'none', assessment: 'none',
    visitsTouched: 0,
    mapped: mappedCount, unmapped: unmappedCount,
  }

  // Linked Jobber work records for this engagement. Multiple jobs are rare
  // but possible (re-founds); apply the crew to each. Assessments carry the
  // appointment id in jobber_assessment_id. Requests are intentionally NOT
  // read — the team model doesn't assign pre-work.
  const [jobRes, assessRes] = await Promise.all([
    supabaseService.from('jobs').select('jobber_job_id').eq('engagement_id', engagementId).not('jobber_job_id', 'is', null),
    supabaseService.from('assessments').select('jobber_assessment_id').eq('engagement_id', engagementId).not('jobber_assessment_id', 'is', null),
  ])
  const jobIds = (jobRes.data ?? []).map((j: any) => j.jobber_job_id).filter(Boolean)
  const apptIds = (assessRes.data ?? []).map((a: any) => a.jobber_assessment_id).filter(Boolean)

  // Job CREW (multi) — the crew lives on the job's visits, not the job.
  // For each linked job: read its visits, then push ALL mapped assignees
  // onto every non-completed visit. Completed visits are left as-is (crew
  // is about who WILL do the work, not a rewrite of finished history).
  // An empty set clears the crew. A failed visit push flips the job to
  // 'failed' but never throws.
  let jobFailed = false
  let jobPushed = false
  for (const jobId of jobIds) {
    let visitNodes: Array<{ id: string; isComplete: boolean }> = []
    try {
      // jobber_job_id is stored numeric (extractJobberId at import); the
      // EncodedId! arg needs the base64 global id, so re-encode at the call.
      // Feeding the bare number is rejected ("'<n>' is not a valid EncodedId").
      const { data, errors } = await jobberGraphQL(locationSlug, JOB_VISITS_QUERY, {
        jobId: encodeJobberId('Job', jobId),
      })
      if (errors?.length) {
        jobFailed = true
        console.warn('[assignee-sync] job visits read errors', JSON.stringify(errors))
        continue
      }
      const conn = data?.job?.visits
      visitNodes = (conn?.nodes ?? []).filter(Boolean)
      const total = conn?.totalCount ?? visitNodes.length
      if (total > VISIT_PAGE) {
        console.warn(`[assignee-sync] job ${jobId} has ${total} visits; crew pushed to first ${VISIT_PAGE} only`)
      }
    } catch (err: any) {
      jobFailed = true
      console.warn('[assignee-sync] job visits read threw', err?.message || err)
      continue
    }

    // Only touch visits that aren't done yet.
    const targetVisitIds = visitNodes.filter(v => !v.isComplete).map(v => v.id)
    for (const visitId of targetVisitIds) {
      try {
        const r = await jobberMutation(locationSlug, VISIT_EDIT_ASSIGNED_USERS_MUTATION, {
          visitId,
          input: { assignedUserIds: allJobberUserIds },
        })
        if (r.userErrors?.length) {
          jobFailed = true
          console.warn('[assignee-sync] visitEditAssignedUsers userErrors', JSON.stringify(r.userErrors))
        } else {
          jobPushed = true
          result.visitsTouched++
        }
      } catch (err: any) {
        jobFailed = true
        console.warn('[assignee-sync] visitEditAssignedUsers threw', err?.message || err)
      }
    }
  }
  if (jobIds.length) {
    result.job = jobFailed ? 'failed'
      : jobPushed ? (allJobberUserIds.length ? 'synced' : 'cleared')
      : 'none' // linked job(s) but no targetable (non-completed) visit
  }

  // Assessment team (multi) via assessmentEdit — ALL mapped assignees. issue 147.
  //
  // Nobody mapped → nothing to push. teamMemberIdsToAssign is assign-oriented
  // and applyTeamToSchedule omits it for an empty list, so we do NOT call
  // assessmentEdit merely to "clear" — that would put the appointment schedule
  // at risk for an unassign this field can't express, and clearing never worked
  // through the old path anyway (it was the same silent no-op). Report 'none'.
  //
  // Otherwise we need the location timezone to preserve startAt/endAt across the
  // edit. Resolve it once. A missing/invalid zone is a hard stop for the
  // assessment leg (fail, don't guess) — the send path already trusts this
  // column to place appointments, so an unusable value is a real config gap.
  if (apptIds.length && allJobberUserIds.length > 0) {
    let locationTz: string | null = null
    let tzError: string | null = null
    const { data: locRow } = await supabaseService
      .from('locations').select('timezone').eq('location_id', locationSlug).maybeSingle()
    try {
      locationTz = requireIanaTimezone((locRow as any)?.timezone)
    } catch (err: any) {
      tzError = err?.message || 'invalid location timezone'
    }

    for (const assessmentId of apptIds) {
      // jobber_assessment_id is stored numeric (extractJobberId at import).
      // encodeJobberId('Assessment', …) builds the gid://Jobber/Assessment/<n>
      // that assessmentEdit(assessmentId: EncodedId!) demands — this encode is
      // correct and REQUIRED (the bare numeric is rejected). See the header:
      // the old bug was the target MUTATION, never this encode.
      const assessmentGid = encodeJobberId('Assessment', assessmentId)

      if (!locationTz) {
        result.assessment = 'failed'
        await persistAssessmentProblem(locationSlug, engagementId, assessmentGid,
          `cannot preserve schedule — ${tzError || 'no location timezone'}`)
        continue
      }

      try {
        // 1) Read the CURRENT schedule LIVE so we re-send startAt/endAt
        //    UNCHANGED (see SCHEDULE PRESERVATION in the header).
        const { data: readData, errors: readErrors } = await jobberGraphQL(
          locationSlug, ASSESSMENT_SCHEDULE_QUERY, { id: assessmentGid })
        if (readErrors?.length) {
          result.assessment = 'failed'
          console.warn('[assignee-sync] assessment schedule read errors', JSON.stringify(readErrors))
          await persistAssessmentProblem(locationSlug, engagementId, assessmentGid, 'schedule read failed')
          continue
        }
        const current = readData?.assessment ?? null
        const schedule: Record<string, any> = {}
        if (current?.startAt) schedule.startAt = toLocalDateTime(current.startAt, locationTz)
        if (current?.endAt)   schedule.endAt   = toLocalDateTime(current.endAt, locationTz)
        // applyTeamToSchedule attaches teamMemberIdsToAssign (present here since
        // the list is non-empty; the empty case never reaches this loop body).
        const scheduleWithTeam = applyTeamToSchedule(schedule, allJobberUserIds)

        // 2) Edit — the response reads back assignedUsers AND startAt/endAt.
        const r = await jobberMutation(locationSlug, ASSESSMENT_EDIT_MUTATION, {
          assessmentId: assessmentGid,
          input: { schedule: scheduleWithTeam },
        })
        if (r.userErrors?.length) {
          result.assessment = 'failed'
          console.warn('[assignee-sync] assessmentEdit userErrors', JSON.stringify(r.userErrors))
          await persistAssessmentProblem(locationSlug, engagementId, assessmentGid, r.userErrors[0].message)
          continue
        }

        const edited = r.data?.assessmentEdit?.assessment ?? null

        // 3) VERIFY — a clean userErrors array is NOT proof. The old mutation
        //    returned exactly that while assigning nobody (0 of 22 in prod).
        //    Only the read-back diff proves the team applied. Reuse issue 144's
        //    differ — do not write a second one.
        const diff = diffAssessmentAssignment(allJobberUserIds, edited?.assignedUsers?.nodes)

        // 4) SCHEDULE GUARD — confirm the edit did not move/wipe the time.
        const drift = hasScheduleDrift(current, edited)

        if (!diff.ok || drift) {
          result.assessment = 'failed'
          const parts: string[] = []
          if (!diff.ok) parts.push(
            `team mismatch requested=[${diff.requested.join(',')}] returned=[${diff.returned.join(',')}]` +
            ` missing=[${diff.missing.join(',')}] unexpected=[${diff.unexpected.join(',')}]`)
          if (drift) parts.push(
            `schedule drift before=(${current?.startAt ?? '∅'}..${current?.endAt ?? '∅'})` +
            ` after=(${edited?.startAt ?? '∅'}..${edited?.endAt ?? '∅'})`)
          // A mismatch/drift MUST be persisted, never console-only — this is the
          // whole point. Dedicated breadcrumb mirrors the send-path convention
          // (ASSESSMENT_TEAM_MISMATCH, issue 144/145).
          await persistAssessmentProblem(locationSlug, engagementId, assessmentGid, parts.join('; '))
        } else {
          result.assessment = 'synced'
        }
      } catch (err: any) {
        result.assessment = 'failed'
        console.warn('[assignee-sync] assessmentEdit threw', err?.message || err)
        await persistAssessmentProblem(locationSlug, engagementId, assessmentGid, `threw ${err?.message || err}`)
      }
    }
  }

  // Breadcrumb — one row per sync, mirroring the send-path convention.
  // Only write when there was actually a linked work record to touch (a
  // local engagement with no Jobber trail is a pure junction write).
  if (jobIds.length || apptIds.length) {
    await writeSyncLog({
      location_id: locationSlug,
      entity_id: engagementId,
      entity_type: 'engagement',
      direction: 'outbound',
      status: (result.job === 'failed' || result.assessment === 'failed') ? 'error' : 'success',
      message:
        `[engagement:assignee-sync] mapped=${mappedCount} unmapped=${unmappedCount}` +
        ` job=${result.job}(${result.visitsTouched} visit${result.visitsTouched === 1 ? '' : 's'}) assessment=${result.assessment} request=skipped` +
        (unmappedCount ? ` — ${unmappedCount} assignee(s) not linked to Jobber, internal-only` : ''),
    })
  }

  return result
}

// location_uuid (locations.id) → location_id slug (the jobberMutation key).
export async function resolveLocationSlug(locationUuid: string): Promise<string | null> {
  const { data } = await supabaseService
    .from('locations')
    .select('location_id, jobber_access_token')
    .eq('id', locationUuid)
    .maybeSingle()
  if (!data?.jobber_access_token) return null // not connected — nothing to sync
  return data.location_id ?? null
}
