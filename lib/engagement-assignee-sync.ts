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
// INTROSPECTED LIVE 2026-07-11 (loc_test, API 2025-04-16) — the crew/team
// surfaces, and the one place a team does NOT exist:
//   · Assessment (appointment): appointmentEditAssignment
//       AppointmentEditAssignmentInput.assignedUserIds : [EncodedId!]! — MULTI
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
// So: the SAME full set of mapped assignees goes onto the assessment
// appointment AND every (non-completed) visit of every linked job. Empty
// set clears the team/crew. Completed visits are left untouched — crew is
// about who WILL do the work, not a rewrite of finished history.
//
// ENCODED-ID CONTRACT: every id fed to an EncodedId! arg must be the full
// base64 global id (gid://Jobber/<Type>/<n>), never the bare numeric — Jobber
// rejects a bare number with "'<n>' is not a valid EncodedId". Our jobber_*_id
// columns store the numeric tail (extractJobberId at import), so jobId and
// appointmentId are re-encoded here via encodeJobberId (matching contact-/
// address-sync). Two ids need NO re-encode: visit ids arrive already-encoded
// from the visits read, and jobber_user_id is stored already-encoded by the
// roster — so assignedUserIds pass through untouched.
//
// UNMAPPED assignees (hub_user with no jobber_user_id — e.g. Kevin/Leslie,
// no Jobber identity) are valid internal assignments but are simply
// skipped for the Jobber push; the UI marks them so it's not a surprise.
//
// ECHO-SAFE BY CONSTRUCTION: no inbound webhook topic reads or writes
// engagement_assignees. appointmentEditAssignment / visitEditAssignedUsers
// fire no webhook we subscribe to that touches the junction — so a crew
// push cannot loop back. Nothing to guard against.
//
// Every push is NON-FATAL: the junction write already committed; a failed
// Jobber mutation logs a breadcrumb (sync_log, entity_type 'engagement')
// and rides the API response so the toast can tell the truth.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { jobberMutation, jobberGraphQL } from './jobber'
import { encodeJobberId } from './jobber-import'
import { writeSyncLog } from './sync-log'

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

const APPOINTMENT_EDIT_ASSIGNMENT_MUTATION = `
  mutation AppointmentEditAssignment($appointmentId: EncodedId!, $input: AppointmentEditAssignmentInput!) {
    appointmentEditAssignment(appointmentId: $appointmentId, input: $input) {
      appointment { id }
      userErrors { message path }
    }
  }
`

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
  // assessment = the appointment team push.
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

  // Assessment appointment team (multi) — ALL mapped assignees.
  // An empty array clears the appointment's team.
  for (const appointmentId of apptIds) {
    try {
      // jobber_assessment_id is stored numeric (the appointment's numeric
      // tail via extractJobberId). appointmentEditAssignment(appointmentId:
      // EncodedId!) accepts the assessment's global id — re-encode from
      // numeric, same as the job path. assignedUserIds are already encoded
      // (roster stores jobber_user_id as the full gid), so they pass through.
      const r = await jobberMutation(locationSlug, APPOINTMENT_EDIT_ASSIGNMENT_MUTATION, {
        appointmentId: encodeJobberId('Assessment', appointmentId),
        input: { assignedUserIds: allJobberUserIds },
      })
      if (r.userErrors?.length) {
        result.assessment = 'failed'
        console.warn('[assignee-sync] appointmentEditAssignment userErrors', JSON.stringify(r.userErrors))
      } else {
        result.assessment = allJobberUserIds.length ? 'synced' : 'cleared'
      }
    } catch (err: any) {
      result.assessment = 'failed'
      console.warn('[assignee-sync] appointmentEditAssignment threw', err?.message || err)
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
