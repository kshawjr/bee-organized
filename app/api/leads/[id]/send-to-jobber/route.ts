// app/api/leads/[id]/send-to-jobber/route.ts
//
// POST /api/leads/:id/send-to-jobber — port of the Deluge send_to_jobber2
// function. Pushes a Bee Hub lead to the location's Jobber account.
//
// Flow (mirrors Deluge):
//   1. Auth — owner/admin/super_admin scoped to the lead's location
//   2. Validate body (creation_type + scheduled_assessment_at if needed)
//   3. Resolve lead + location + assigned hub_user (for jobber_user_id)
//   4. Extract primary address from lead.addresses (or legacy fields)
//   5. Search Jobber for a client by email
//        - found AND email exact match → reuse, optionally update name/phone
//        - found but no email match    → create new client
//        - not found                   → create new client
//   6. For matched clients, fetch existing properties, match street → reuse
//   7. Create a new property if no match
//   8. Branch on creation_type:
//        - request_only             → requestCreate
//        - request_with_assessment  → requestCreate + assessmentCreate +
//                                     (optional) appointmentEditAssignment
//        - job_direct               → jobCreate
//   9. Write IDs + status back to the lead row
//  10. Append a sync_log entry
//
// Returns the IDs created on success, or { success:false, error, stage }
// on failure so the popup can surface where things broke.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { jobberGraphQL, jobberMutation } from '@/lib/jobber'
import { writeSyncLog } from '@/lib/sync-log'

export const runtime = 'nodejs'
export const maxDuration = 60

type Stage =
  | 'auth'
  | 'lookup'
  | 'validation'
  | 'token'
  | 'client_search'
  | 'client_create'
  | 'client_update'
  | 'property_lookup'
  | 'property_create'
  | 'request_create'
  | 'assessment_create'
  | 'assignment'
  | 'job_create'
  | 'writeback'

type CreationType =
  | 'request_only'
  | 'request_with_assessment'
  | 'job_direct'

const ALLOWED_CREATION_TYPES: CreationType[] = [
  'request_only',
  'request_with_assessment',
  'job_direct',
]

// ── helpers ──────────────────────────────────────────────────────────────────

// Jobber GraphQL IDs come back as base64 "gid://Jobber/Client/12345". The
// codebase stores the numeric portion — mirror the existing import helper.
function extractJobberId(globalId: string | null | undefined): string | null {
  if (!globalId) return null
  if (/^\d+$/.test(globalId)) return globalId
  try {
    const decoded = Buffer.from(globalId, 'base64').toString('utf8')
    const match = decoded.match(/\/(\d+)$/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function fail(stage: Stage, error: string, status = 500, extra: object = {}) {
  return NextResponse.json(
    { success: false, error, stage, ...extra },
    { status },
  )
}

function pickPrimaryAddress(lead: any): {
  street: string
  city: string
  state: string
  zip: string
} | null {
  const addrs = Array.isArray(lead.addresses) ? lead.addresses : []
  if (addrs.length > 0) {
    const a = addrs[0]
    const street = (a.street || a.value || '').trim()
    if (!street) return null
    return {
      street,
      city:  (a.city  || '').trim(),
      state: (a.state || '').trim(),
      zip:   (a.zip   || '').trim(),
    }
  }
  // Legacy single-column fallback
  if (lead.address) {
    return {
      street: String(lead.address).trim(),
      city:   String(lead.city  || '').trim(),
      state:  String(lead.state || '').trim(),
      zip:    String(lead.zip   || '').trim(),
    }
  }
  return null
}

// ── Jobber GraphQL operations ────────────────────────────────────────────────
// Pinned to API version 2025-04-16 (X-JOBBER-GRAPHQL-VERSION) via lib/jobber.ts.

// Jobber's `clients` connection takes `searchTerm` as a top-level argument,
// not as a field inside `ClientFilterAttributes`. Earlier API versions tucked
// it under `filter:` — that no longer validates against the current schema
// and returns: InputObject 'ClientFilterAttributes' doesn't accept argument
// 'searchTerm'.
const FIND_CLIENT_QUERY = /* GraphQL */ `
  query FindClient($searchTerm: String!) {
    clients(searchTerm: $searchTerm, first: 10) {
      nodes {
        id
        firstName
        lastName
        companyName
        emails { address primary }
        phones { number primary }
      }
    }
  }
`

const GET_CLIENT_PROPERTIES_QUERY = /* GraphQL */ `
  query GetClientProperties($clientId: EncodedId!) {
    client(id: $clientId) {
      id
      properties(first: 50) {
        nodes {
          id
          address { street1 street2 city province postalCode country }
        }
      }
    }
  }
`

const CLIENT_CREATE_MUTATION = /* GraphQL */ `
  mutation ClientCreate($input: ClientCreateInput!) {
    clientCreate(input: $input) {
      client { id firstName lastName }
      userErrors { message path }
    }
  }
`

const CLIENT_EDIT_MUTATION = /* GraphQL */ `
  mutation ClientEdit($clientId: EncodedId!, $input: ClientEditInput!) {
    clientEdit(clientId: $clientId, input: $input) {
      client { id firstName lastName }
      userErrors { message path }
    }
  }
`

const CLIENT_CREATE_PROPERTY_MUTATION = /* GraphQL */ `
  mutation ClientCreateProperty($clientId: EncodedId!, $input: PropertyCreateInput!) {
    clientCreateProperty(clientId: $clientId, input: $input) {
      property { id address { street1 city province postalCode country } }
      userErrors { message path }
    }
  }
`

const REQUEST_CREATE_MUTATION = /* GraphQL */ `
  mutation RequestCreate($input: RequestCreateInput!) {
    requestCreate(input: $input) {
      request { id title client { id } property { id } }
      userErrors { message path }
    }
  }
`

const ASSESSMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation AssessmentCreate($input: AssessmentCreateInput!) {
    assessmentCreate(input: $input) {
      assessment { id startAt endAt }
      userErrors { message path }
    }
  }
`

const APPOINTMENT_EDIT_ASSIGNMENT_MUTATION = /* GraphQL */ `
  mutation AppointmentEditAssignment(
    $appointmentId: EncodedId!,
    $input: AppointmentEditAssignmentInput!
  ) {
    appointmentEditAssignment(appointmentId: $appointmentId, input: $input) {
      appointment { id }
      userErrors { message path }
    }
  }
`

const JOB_CREATE_MUTATION = /* GraphQL */ `
  mutation JobCreate($input: JobCreateInput!) {
    jobCreate(input: $input) {
      job { id title client { id } property { id } }
      userErrors { message path }
    }
  }
`

// ── handler ──────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: leadId } = await params

  // ── Auth ────────────────────────────────────────────────────────
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return fail('auth', 'unauthorized', 401)

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return fail('auth', 'no_hub_user_profile', 403)

  // ── Parse + validate body ───────────────────────────────────────
  let body: any = {}
  try { body = await req.json() } catch { /* allow empty */ }

  const creation_type = body.creation_type as CreationType | undefined
  if (!creation_type || !ALLOWED_CREATION_TYPES.includes(creation_type)) {
    return fail('validation', 'invalid_creation_type', 400, {
      allowed: ALLOWED_CREATION_TYPES,
    })
  }
  const scheduled_assessment_at: string | undefined = body.scheduled_assessment_at
  const assessment_type: 'in-person' | 'virtual' | undefined = body.assessment_type
  if (creation_type === 'request_with_assessment') {
    if (!scheduled_assessment_at) {
      return fail('validation', 'scheduled_assessment_at_required', 400)
    }
    if (Number.isNaN(Date.parse(scheduled_assessment_at))) {
      return fail('validation', 'scheduled_assessment_at_invalid', 400)
    }
    if (assessment_type && assessment_type !== 'in-person' && assessment_type !== 'virtual') {
      return fail('validation', 'invalid_assessment_type', 400)
    }
  }

  // Address is only mandatory for paths Jobber can't fulfill without a
  // property: job creation, and in-person assessments. request_only and
  // virtual assessments proceed without a property — mirrors the Deluge
  // reference, which skipped property creation when street1 was empty.
  const addressRequired =
    creation_type === 'job_direct' ||
    (creation_type === 'request_with_assessment' && assessment_type === 'in-person')

  // ── Load lead + location + assigned user ────────────────────────
  const { data: lead, error: leadErr } = await supabaseService
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .maybeSingle()
  if (leadErr || !lead) return fail('lookup', 'lead_not_found', 404)

  // Scope: owner/lite_user must match. admin + super_admin pass.
  const isAdminRole = hubUser.role === 'admin' || hubUser.role === 'super_admin'
  if (!isAdminRole) {
    if (hubUser.role === 'lite_user') {
      return fail('auth', 'forbidden_read_only_role', 403)
    }
    if (hubUser.location_id !== lead.location_uuid) {
      return fail('auth', 'forbidden_wrong_location', 403)
    }
  }

  const locationSlug: string = lead.location_id
  if (!locationSlug) return fail('lookup', 'lead_has_no_location', 400)

  const { data: location } = await supabaseService
    .from('locations')
    .select('id, location_id, name, timezone, jobber_access_token')
    .eq('location_id', locationSlug)
    .maybeSingle()
  if (!location) return fail('lookup', 'location_not_found', 404)
  if (!location.jobber_access_token) {
    return fail('lookup', 'location_not_connected_to_jobber', 400)
  }

  // Assigned hub_user (for jobber_user_id assignment on assessments)
  let assignedJobberUserId: string | null = null
  if (lead.assigned_to) {
    const { data: assignedUser } = await supabaseService
      .from('hub_users')
      .select('id, jobber_user_id')
      .eq('id', lead.assigned_to)
      .maybeSingle()
    assignedJobberUserId = assignedUser?.jobber_user_id ?? null
  }

  // ── Address ─────────────────────────────────────────────────────
  const address = pickPrimaryAddress(lead)
  if (!address && addressRequired) {
    return fail('validation', 'lead_has_no_address', 400)
  }

  const firstName = (lead.first_name || lead.name?.split(' ')[0] || '').trim()
  const lastName  = (lead.last_name  || lead.name?.split(' ').slice(1).join(' ') || '').trim()
  const email     = (lead.email || '').trim()
  const phone     = (lead.phone || '').trim()

  // ─────────────────────────────────────────────────────────────────
  // 1. SEARCH for an existing client by email
  // ─────────────────────────────────────────────────────────────────
  let jobberClientGlobalId: string | null = null
  let matchStatus: 'matched_existing' | 'new_client' = 'new_client'

  if (email) {
    const search = await jobberGraphQL(locationSlug, FIND_CLIENT_QUERY, {
      searchTerm: email,
    })
    if (search.errors?.length) {
      return fail('client_search', search.errors[0]?.message || 'search_failed')
    }
    const candidates: any[] = search.data?.clients?.nodes || []
    const exactMatch = candidates.find((c: any) =>
      (c.emails || []).some((e: any) =>
        e?.address && e.address.toLowerCase() === email.toLowerCase()
      )
    )
    if (exactMatch) {
      jobberClientGlobalId = exactMatch.id
      matchStatus = 'matched_existing'
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 2. CREATE or UPDATE the client
  // ─────────────────────────────────────────────────────────────────
  if (jobberClientGlobalId) {
    // Matched: refresh name + phone in case they changed locally
    const editInput: Record<string, any> = {
      firstName: firstName || null,
      lastName:  lastName  || null,
    }
    if (phone) editInput.phones = [{ number: phone, primary: true }]
    const edit = await jobberMutation(locationSlug, CLIENT_EDIT_MUTATION, {
      clientId: jobberClientGlobalId,
      input: editInput,
    })
    if (edit.userErrors?.length) {
      // Non-fatal — the client exists, we just couldn't update them.
      // Log and continue.
      console.warn('[send-to-jobber] clientEdit userErrors',
        JSON.stringify(edit.userErrors))
    }
  } else {
    const createInput: Record<string, any> = {
      firstName: firstName || null,
      lastName:  lastName  || null,
    }
    if (email) createInput.emails = [{ address: email, primary: true }]
    if (phone) createInput.phones = [{ number: phone, primary: true }]
    const create = await jobberMutation(locationSlug, CLIENT_CREATE_MUTATION, {
      input: createInput,
    })
    if (create.userErrors?.length) {
      return fail('client_create', create.userErrors[0].message)
    }
    jobberClientGlobalId = create.data?.clientCreate?.client?.id || null
    if (!jobberClientGlobalId) {
      return fail('client_create', 'client_create_returned_no_id')
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 3. PROPERTY: reuse if street matches, else create new.
  // Skipped entirely when no address is present (request_only / virtual
  // assessment) — Deluge reference did the same.
  // ─────────────────────────────────────────────────────────────────
  let jobberPropertyGlobalId: string | null = null

  if (address) {
    if (matchStatus === 'matched_existing') {
      const propsRes = await jobberGraphQL(
        locationSlug,
        GET_CLIENT_PROPERTIES_QUERY,
        { clientId: jobberClientGlobalId },
      )
      if (propsRes.errors?.length) {
        return fail('property_lookup', propsRes.errors[0]?.message || 'property_lookup_failed')
      }
      const existing: any[] = propsRes.data?.client?.properties?.nodes || []
      const wantedStreet = address.street.toLowerCase()
      const matchedProp = existing.find((p: any) =>
        (p.address?.street1 || '').trim().toLowerCase() === wantedStreet
      )
      if (matchedProp) jobberPropertyGlobalId = matchedProp.id
    }

    if (!jobberPropertyGlobalId) {
      const propCreate = await jobberMutation(
        locationSlug,
        CLIENT_CREATE_PROPERTY_MUTATION,
        {
          clientId: jobberClientGlobalId,
          input: {
            address: {
              street1:    address.street,
              city:       address.city || null,
              province:   address.state || null,
              postalCode: address.zip || null,
              country:    'US',
            },
          },
        },
      )
      if (propCreate.userErrors?.length) {
        return fail('property_create', propCreate.userErrors[0].message)
      }
      jobberPropertyGlobalId = propCreate.data?.clientCreateProperty?.property?.id || null
      if (!jobberPropertyGlobalId) {
        return fail('property_create', 'property_create_returned_no_id')
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 4. Branch on creation_type
  // ─────────────────────────────────────────────────────────────────
  let jobberRequestGlobalId:    string | null = null
  let jobberAssessmentGlobalId: string | null = null
  let jobberJobGlobalId:        string | null = null

  const requestTitle =
    (lead.name || `${firstName} ${lastName}`.trim() || 'Service Request').slice(0, 200)

  if (creation_type === 'request_only' || creation_type === 'request_with_assessment') {
    const requestInput: Record<string, any> = {
      clientId:       jobberClientGlobalId,
      title:          requestTitle,
      requestDetails: lead.request_details || null,
    }
    // Only include propertyId when we actually have one — Deluge mirrored
    // this with two requestCreate variants. Omitting the key lets Jobber
    // accept the request without a property attached.
    if (jobberPropertyGlobalId) requestInput.propertyId = jobberPropertyGlobalId
    const reqCreate = await jobberMutation(
      locationSlug,
      REQUEST_CREATE_MUTATION,
      { input: requestInput },
    )
    if (reqCreate.userErrors?.length) {
      return fail('request_create', reqCreate.userErrors[0].message)
    }
    jobberRequestGlobalId = reqCreate.data?.requestCreate?.request?.id || null
    if (!jobberRequestGlobalId) {
      return fail('request_create', 'request_create_returned_no_id')
    }

    if (creation_type === 'request_with_assessment') {
      const assessCreate = await jobberMutation(
        locationSlug,
        ASSESSMENT_CREATE_MUTATION,
        {
          input: {
            requestId: jobberRequestGlobalId,
            startAt:   scheduled_assessment_at,
            // Assessments are time-boxed; Jobber's UI defaults to 1hr if endAt
            // is omitted. We mirror that by sending a 1hr endAt explicitly so
            // calendar views render with a sensible block.
            endAt:     new Date(
              new Date(scheduled_assessment_at!).getTime() + 60 * 60 * 1000,
            ).toISOString(),
          },
        },
      )
      if (assessCreate.userErrors?.length) {
        return fail('assessment_create', assessCreate.userErrors[0].message)
      }
      jobberAssessmentGlobalId = assessCreate.data?.assessmentCreate?.assessment?.id || null

      // Assign team member if we have their Jobber user ID. Non-fatal —
      // a missing assignment shouldn't kill the whole send.
      if (jobberAssessmentGlobalId && assignedJobberUserId) {
        const assign = await jobberMutation(
          locationSlug,
          APPOINTMENT_EDIT_ASSIGNMENT_MUTATION,
          {
            appointmentId: jobberAssessmentGlobalId,
            input: { assignedUsers: [assignedJobberUserId] },
          },
        )
        if (assign.userErrors?.length) {
          console.warn('[send-to-jobber] assignment userErrors',
            JSON.stringify(assign.userErrors))
        }
      }
    }
  } else if (creation_type === 'job_direct') {
    const jobCreate = await jobberMutation(locationSlug, JOB_CREATE_MUTATION, {
      input: {
        clientId:   jobberClientGlobalId,
        propertyId: jobberPropertyGlobalId,
        title:      requestTitle,
      },
    })
    if (jobCreate.userErrors?.length) {
      return fail('job_create', jobCreate.userErrors[0].message)
    }
    jobberJobGlobalId = jobCreate.data?.jobCreate?.job?.id || null
    if (!jobberJobGlobalId) {
      return fail('job_create', 'job_create_returned_no_id')
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 5. Writeback to lead
  // ─────────────────────────────────────────────────────────────────
  const jobberClientId     = extractJobberId(jobberClientGlobalId)
  const jobberPropertyId   = extractJobberId(jobberPropertyGlobalId)
  const jobberRequestId    = extractJobberId(jobberRequestGlobalId)
  const jobberAssessmentId = extractJobberId(jobberAssessmentGlobalId)
  const jobberJobId        = extractJobberId(jobberJobGlobalId)

  const typeLabel = creation_type === 'request_only'
    ? 'Request'
    : creation_type === 'request_with_assessment'
      ? 'Request + Assessment'
      : 'Job'
  const syncedAtIso = new Date().toISOString()

  const writeback: Record<string, any> = {
    jobber_client_id:     jobberClientId,
    jobber_property_id:   jobberPropertyId,
    jobber_request_id:    jobberRequestId    ?? lead.jobber_request_id ?? null,
    jobber_assessment_id: jobberAssessmentId ?? lead.jobber_assessment_id ?? null,
    jobber_job_id:        jobberJobId        ?? lead.jobber_job_id ?? null,
    jobber_match_status:  matchStatus,
    jobber_sync_status:   `Success: ${typeLabel} — ${syncedAtIso.slice(0, 19)}`,
    jobber_synced_at:     syncedAtIso,
    updated_at:           syncedAtIso,
  }

  const { error: writeErr } = await supabaseService
    .from('leads')
    .update(writeback)
    .eq('id', leadId)
  if (writeErr) {
    return fail('writeback', writeErr.message, 500, {
      // Surface the IDs anyway — the Jobber side succeeded, only the local
      // mirror failed. The caller can retry the writeback or sync later.
      jobber_client_id:     jobberClientId,
      jobber_request_id:    jobberRequestId,
      jobber_assessment_id: jobberAssessmentId,
      jobber_job_id:        jobberJobId,
    })
  }

  // ── sync_log (fire-and-forget; failures don't block the response) ──
  await writeSyncLog({
    location_id:      locationSlug,
    entity_id:        leadId,
    entity_type:      creation_type === 'job_direct' ? 'job' : 'request',
    direction:        'outbound',
    jobber_record_id: jobberRequestId || jobberJobId || jobberClientId || '',
    status:           'success',
    message:
      `Send-to-Jobber (${typeLabel}); match=${matchStatus}; ` +
      `client=${jobberClientId}` +
      (jobberRequestId    ? `; request=${jobberRequestId}`    : '') +
      (jobberAssessmentId ? `; assessment=${jobberAssessmentId}` : '') +
      (jobberJobId        ? `; job=${jobberJobId}`            : ''),
  })

  return NextResponse.json({
    success:              true,
    match_status:         matchStatus,
    jobber_client_id:     jobberClientId,
    jobber_property_id:   jobberPropertyId,
    jobber_request_id:    jobberRequestId,
    jobber_assessment_id: jobberAssessmentId,
    jobber_job_id:        jobberJobId,
  })
}
