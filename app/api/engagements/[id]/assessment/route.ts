// app/api/engagements/[id]/assessment/route.ts
//
// POST /api/engagements/:id/assessment — Book assessment.
//
// Books a Jobber assessment ON the request this card already sent, from Bee
// Hub. Body: { scheduled_assessment_at: ISO string, assessment_type:
// 'in-person' | 'virtual' }.
//
// WHY THIS EXISTS (2026-11 twin-card investigation): owners send a lead as
// "Request only" because "Request + Assessment" wants a date and time nobody
// has the moment a lead lands. When the time is agreed later, Bee Hub had no
// way to book it, so they booked it in Jobber, where the easy path is a brand
// NEW request. Jobber then held two requests for one client and Bee Hub showed
// two cards; the first never moved. Sioux Falls: 26 "Request" sends, every
// twin came from them; 2 "Request + Assessment" sends, no twins.
//
// WHAT IT NEVER DOES
//   · create a request — the only Jobber write is assessmentCreate on the
//     request id read from this card's own service_requests row;
//   · create or found a card — it writes no engagements or service_requests
//     row. The REQUEST_UPDATE webhook that Jobber fires for the new assessment
//     re-reads the SAME request, whose row is already linked to this card, so
//     ensureEngagementForServiceRequest returns this card (pinned in
//     lib/beta-book-assessment.test.ts);
//   · book a second assessment — refused when this card already has one
//     locally OR the request already has one in Jobber (read live, because
//     our mirror can lag). Moving an existing one is a reschedule, which this
//     does not do.
//
// Order: every check and the Jobber write happen BEFORE any local write, so a
// refusal anywhere leaves nothing half-written. After Jobber says yes, the
// local mirror (assessment row + type + link to this card) and a sync_log
// breadcrumb are written, non-fatally — the assessment is real in Jobber
// either way and the webhook writes the same rows.
//
// Permissions match Send to Jobber exactly: logged-in hub_user; lite_user
// refused; admin/super_admin any location, everyone else only their own; a
// paused/inactive location is read-only (elevated roles bypass).
//
// The assessment itself — timezone, one-hour block, team at creation, virtual
// note, team read-back — is lib/jobber-assessment-create.ts, the same code
// Send to Jobber runs. Not a second implementation.
//
// Failure shape matches the send popup's: { success:false, error, stage }.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { jobberGraphQL } from '@/lib/jobber'
import { writeSyncLog } from '@/lib/sync-log'
import { isLocationReadOnly } from '@/lib/read-only-access'
import { encodeJobberId } from '@/lib/jobber-import'
import { attachToEngagement } from '@/lib/engagements'
import { getEngagementAssignees, resolveJobberAssignment } from '@/lib/engagement-assignee-sync'
import { createAssessmentOnRequest } from '@/lib/jobber-assessment-create'
import { recordSentAssessmentType } from '@/lib/assessment-type-record'
import { isAssessmentType } from '@/lib/assessment-type'

type Stage =
  | 'auth' | 'validation' | 'lookup' | 'already_booked'
  | 'request_read' | 'assessment_create'

function fail(stage: Stage, error: string, status = 500, extra: object = {}) {
  return NextResponse.json({ success: false, error, stage, ...extra }, { status })
}

// Live read of the request before booking: does it still exist, is it
// archived, does it ALREADY carry an assessment (our mirror may lag a booking
// made in Jobber), and does it have a property for an in-person visit.
const BOOK_REQUEST_CHECK_QUERY = /* GraphQL */ `
  query BookAssessmentRequestCheck($id: EncodedId!) {
    request(id: $id) {
      id
      requestStatus
      assessment { id }
      property { id }
    }
  }
`

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: engagementId } = await params

  // ── Auth (same as Send to Jobber) ─────────────────────────────
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return fail('auth', 'unauthorized', 401)
  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return fail('auth', 'no_hub_user_profile', 403)

  // ── Body ──────────────────────────────────────────────────────
  let body: any = {}
  try { body = await req.json() } catch { /* empty → validation below */ }
  const scheduledAt: unknown = body.scheduled_assessment_at
  const assessmentType: unknown = body.assessment_type
  if (typeof scheduledAt !== 'string' || !scheduledAt) {
    return fail('validation', 'Pick a day and time for the assessment.', 400)
  }
  if (Number.isNaN(Date.parse(scheduledAt))) {
    return fail('validation', `The assessment time is not a valid date ("${scheduledAt}").`, 400)
  }
  if (!isAssessmentType(assessmentType)) {
    return fail('validation', 'invalid_assessment_type', 400)
  }

  // ── The card ──────────────────────────────────────────────────
  const { data: eng } = await supabaseService
    .from('engagements')
    .select('id, client_id, location_uuid, stage')
    .eq('id', engagementId)
    .maybeSingle()
  if (!eng) return fail('lookup', 'engagement_not_found', 404)

  const isAdminRole = hubUser.role === 'admin' || hubUser.role === 'super_admin'
  if (!isAdminRole) {
    if (hubUser.role === 'lite_user') return fail('auth', 'forbidden_read_only_role', 403)
    if (hubUser.location_id !== eng.location_uuid) return fail('auth', 'forbidden_wrong_location', 403)
    const { data: locRow } = await supabaseService
      .from('locations')
      .select('lifecycle_status, subscription_status')
      .eq('id', eng.location_uuid)
      .maybeSingle()
    if (isLocationReadOnly(locRow)) return fail('auth', 'forbidden_read_only_location', 403)
  }

  if (eng.stage === 'Closed Won' || eng.stage === 'Closed Lost') {
    return fail('validation', 'engagement_already_closed', 400)
  }

  // ── The request this card already sent ────────────────────────
  const { data: srs } = await supabaseService
    .from('service_requests')
    .select('id, jobber_request_id, location_id')
    .eq('engagement_id', engagementId)
  const linked = (srs || []).filter((s: any) => !!s.jobber_request_id)
  if (linked.length === 0) {
    return fail('lookup', 'This card has no Jobber request to book the assessment on.', 400)
  }
  if (linked.length > 1) {
    // One request per card is the rule; two means a card someone must look at
    // before anything is booked onto either request.
    return fail('lookup', 'This card holds more than one Jobber request — book the assessment in Jobber.', 409)
  }
  const sr = linked[0] as { id: string; jobber_request_id: string; location_id: string }
  const locationSlug = sr.location_id

  // ── Already booked? (local mirror) ────────────────────────────
  const { data: localAssessments } = await supabaseService
    .from('assessments')
    .select('id')
    .eq('engagement_id', engagementId)
  if ((localAssessments || []).length > 0) {
    return fail('already_booked', ALREADY_BOOKED, 409)
  }

  // ── Location: connected, timezone ─────────────────────────────
  const { data: location } = await supabaseService
    .from('locations')
    .select('location_id, timezone, jobber_access_token')
    .eq('location_id', locationSlug)
    .maybeSingle()
  if (!location) return fail('lookup', 'location_not_found', 404)
  if (!(location as any).jobber_access_token) return fail('lookup', 'location_not_connected_to_jobber', 400)

  // ── Already booked? (Jobber, live) + still bookable ───────────
  const requestGlobalId = encodeJobberId('Request', sr.jobber_request_id)
  const check = await jobberGraphQL(locationSlug, BOOK_REQUEST_CHECK_QUERY, { id: requestGlobalId })
  if (check.errors?.length) {
    return fail('request_read', `Couldn't read the request from Jobber: ${check.errors[0]?.message || 'unknown'}`, 502)
  }
  const live = check.data?.request
  if (!live) return fail('request_read', 'The request is no longer in Jobber.', 400)
  if (live.requestStatus === 'archived') return fail('request_read', 'The request is archived in Jobber.', 400)
  if (live.assessment?.id) return fail('already_booked', ALREADY_BOOKED, 409)
  if (assessmentType === 'in-person' && !live.property?.id) {
    return fail(
      'validation',
      'This request in Jobber has no address, so an in-person visit has nowhere to go. ' +
      'Add the address to the request in Jobber, or book it as virtual.',
      400,
    )
  }

  // ── The team: the card's assignees, as Send to Jobber resolves them ──
  const assignees = await getEngagementAssignees(engagementId)
  const team = resolveJobberAssignment(assignees, { locationUuid: eng.location_uuid })

  // ── Book it (the ONE Jobber write) ────────────────────────────
  const booked = await createAssessmentOnRequest({
    locationSlug,
    requestGlobalId,
    scheduledAtIso: scheduledAt,
    timezoneLabel: (location as any).timezone,
    teamJobberIds: team.allJobberUserIds,
    assessmentType,
  })
  if (!booked.ok && booked.stage === 'validation') {
    return fail(
      'validation',
      `Cannot book the assessment: ${booked.error}. Update Settings → Location → Timezone.`,
      400,
    )
  }
  if (!booked.ok) {
    return fail('assessment_create', `Jobber refused the assessment: ${booked.error}`, 502)
  }

  // ── Jobber said yes: mirror it onto THIS card (non-fatal) ─────
  const startAtIso = new Date(booked.startMs).toISOString()
  let mirrored = false
  if (booked.assessmentGlobalId) {
    const rec = await recordSentAssessmentType({
      assessmentType,
      requestRec: { id: requestGlobalId },
      jobberAssessmentGlobalId: booked.assessmentGlobalId,
      startAtIso,
      leadId: eng.client_id,
      locationSlug,
      serviceRequestId: sr.id,
    })
    if (rec.ok) {
      await attachToEngagement('assessments', rec.assessmentRowId, engagementId)
      mirrored = true
    } else {
      console.error('[book-assessment] local mirror not written (webhook will)', { engagementId, reason: rec.reason })
    }
  }

  const teamVerified = booked.diff
    ? booked.diff.requested.filter(id => booked.diff!.returned.includes(id)).length
    : 0
  const teamNote = booked.diff
    ? (booked.diff.ok ? `team=ok(${teamVerified})` : `team=incomplete missing=[${booked.diff.missing.join(',')}]`)
    : 'team=none'
  await writeSyncLog({
    location_id: locationSlug,
    entity_id: eng.client_id,
    entity_type: 'assessment',
    direction: 'outbound',
    jobber_record_id: sr.jobber_request_id,
    status: booked.diff && !booked.diff.ok ? 'partial' : 'success',
    message:
      `Book-assessment; request=${sr.jobber_request_id}; engagement=${engagementId}; ` +
      `type=${assessmentType}; at=${startAtIso}; ${teamNote}` +
      (mirrored ? '' : '; local mirror deferred to webhook'),
  })

  return NextResponse.json({
    success: true,
    jobber_request_id: sr.jobber_request_id,
    jobber_assessment_id: booked.assessmentGlobalId,
    scheduled_at: startAtIso,
    team_incomplete: !!(booked.diff && !booked.diff.ok),
  })
}

const ALREADY_BOOKED =
  'This card already has an assessment. Moving it is a reschedule — change it in Jobber for now.'
