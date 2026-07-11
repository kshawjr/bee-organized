// lib/engagement-assignee-sync.ts
// ─────────────────────────────────────────────────────────────
// Engagement-level assignees → Jobber assignment push.
//
// Assignment lives on the engagement_assignees junction (many hub_users
// per engagement). This module resolves that set to Jobber user ids and
// pushes it onto the engagement's linked Jobber records.
//
// INTROSPECTED LIVE 2026-07-11 (loc_test, API 2025-04-16) — assignment
// fields differ by record, so the mapping is not uniform:
//   · Request  RequestEditInput.salespersonId : EncodedId  — SINGULAR
//   · Job      JobEditInput.salespersonId      : EncodedId  — SINGULAR
//   · Assessment (appointment) assignedUserIds : [EncodedId!]! — MULTI
//   · Visit    VisitEditAssignedUsersInput.assignedUserIds : [EncodedId!]! — MULTI
// So: request + job carry ONE owner (the PRIMARY = first assignee by
// created_at); the assessment appointment carries ALL mapped assignees.
// Visit crew assignment is available (multi) but deliberately NOT wired
// here — see report notes: pushing deal-owner assignees onto every
// visit's crew is a scheduling claim, not an ownership one, and needs
// Kevin's call.
//
// UNMAPPED assignees (hub_user with no jobber_user_id — e.g. Kevin/Leslie,
// no Jobber identity) are valid internal assignments but are simply
// skipped for the Jobber push; the UI marks them so it's not a surprise.
//
// ECHO-SAFE BY CONSTRUCTION: no inbound webhook topic reads or writes
// engagement_assignees. Our requestEdit/jobEdit re-fire REQUEST_UPDATE /
// JOB_UPDATE, whose handlers re-upsert the child row but never touch the
// junction — so an assignment push cannot loop back. appointmentEdit-
// Assignment fires no webhook we subscribe to. Nothing to guard against.
//
// Every push is NON-FATAL: the junction write already committed; a failed
// Jobber mutation logs a breadcrumb (sync_log, entity_type 'engagement')
// and rides the API response so the toast can tell the truth.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'
import { jobberMutation } from './jobber'
import { writeSyncLog } from './sync-log'

const REQUEST_EDIT_MUTATION = `
  mutation RequestEditAssignee($requestId: EncodedId!, $input: RequestEditInput!) {
    requestEdit(requestId: $requestId, input: $input) {
      request { id }
      userErrors { message path }
    }
  }
`

const JOB_EDIT_MUTATION = `
  mutation JobEditAssignee($jobId: EncodedId!, $input: JobEditInput!) {
    jobEdit(jobId: $jobId, input: $input) {
      job { id }
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

// Resolve the Jobber-facing assignment set from the assignees.
//   primary = first mapped assignee (request/job salesperson — singular)
//   all     = every mapped assignee (assessment appointment — multi)
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
  request: 'synced' | 'cleared' | 'failed' | 'none'
  job: 'synced' | 'cleared' | 'failed' | 'none'
  assessment: 'synced' | 'cleared' | 'failed' | 'none'
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
  const { primaryJobberUserId, allJobberUserIds, mappedCount, unmappedCount } =
    resolveJobberAssignment(assignees)

  const result: AssignmentSyncResult = {
    request: 'none', job: 'none', assessment: 'none',
    mapped: mappedCount, unmapped: unmappedCount,
  }

  // Linked Jobber record ids for this engagement. Multiple requests/jobs
  // are rare but possible (re-founds); apply to each. Assessments carry
  // the appointment id in jobber_assessment_id.
  const [srRes, jobRes, assessRes] = await Promise.all([
    supabaseService.from('service_requests').select('jobber_request_id').eq('engagement_id', engagementId).not('jobber_request_id', 'is', null),
    supabaseService.from('jobs').select('jobber_job_id').eq('engagement_id', engagementId).not('jobber_job_id', 'is', null),
    supabaseService.from('assessments').select('jobber_assessment_id').eq('engagement_id', engagementId).not('jobber_assessment_id', 'is', null),
  ])
  const requestIds = (srRes.data ?? []).map((r: any) => r.jobber_request_id).filter(Boolean)
  const jobIds = (jobRes.data ?? []).map((j: any) => j.jobber_job_id).filter(Boolean)
  const apptIds = (assessRes.data ?? []).map((a: any) => a.jobber_assessment_id).filter(Boolean)

  // Request salesperson (singular) — primary assignee, or null to clear
  // when no mapped assignee remains (full unassign is a legitimate edit).
  for (const requestId of requestIds) {
    try {
      const r = await jobberMutation(locationSlug, REQUEST_EDIT_MUTATION, {
        requestId,
        input: { salespersonId: primaryJobberUserId },
      })
      if (r.userErrors?.length) {
        result.request = 'failed'
        console.warn('[assignee-sync] requestEdit userErrors', JSON.stringify(r.userErrors))
      } else {
        result.request = primaryJobberUserId ? 'synced' : 'cleared'
      }
    } catch (err: any) {
      result.request = 'failed'
      console.warn('[assignee-sync] requestEdit threw', err?.message || err)
    }
  }

  // Job salesperson (singular) — same primary rule.
  for (const jobId of jobIds) {
    try {
      const r = await jobberMutation(locationSlug, JOB_EDIT_MUTATION, {
        jobId,
        input: { salespersonId: primaryJobberUserId },
      })
      if (r.userErrors?.length) {
        result.job = 'failed'
        console.warn('[assignee-sync] jobEdit userErrors', JSON.stringify(r.userErrors))
      } else {
        result.job = primaryJobberUserId ? 'synced' : 'cleared'
      }
    } catch (err: any) {
      result.job = 'failed'
      console.warn('[assignee-sync] jobEdit threw', err?.message || err)
    }
  }

  // Assessment appointment assignment (multi) — ALL mapped assignees.
  // An empty array clears the appointment's assignees.
  for (const appointmentId of apptIds) {
    try {
      const r = await jobberMutation(locationSlug, APPOINTMENT_EDIT_ASSIGNMENT_MUTATION, {
        appointmentId,
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
  // Only write when there was actually a linked record to touch (a local
  // engagement with no Jobber trail is a pure junction write, nothing to log).
  if (requestIds.length || jobIds.length || apptIds.length) {
    await writeSyncLog({
      location_id: locationSlug,
      entity_id: engagementId,
      entity_type: 'engagement',
      direction: 'outbound',
      status: (result.request === 'failed' || result.job === 'failed' || result.assessment === 'failed') ? 'error' : 'success',
      message:
        `[engagement:assignee-sync] mapped=${mappedCount} unmapped=${unmappedCount}` +
        ` request=${result.request} job=${result.job} assessment=${result.assessment}` +
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
