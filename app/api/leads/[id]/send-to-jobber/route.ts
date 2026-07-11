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
//
// engagement_id (optional body field): a send on an already-FOUNDED
// engagement (founded_by='manual', decoupled founding). When present the
// route pre-writes the local service_requests row for the new Jobber
// request and attaches it to that engagement — so the REQUEST_CREATE
// webhook's ensureEngagementForServiceRequest finds the SR already
// founded and never mints a second engagement for the same work cycle.
// Sends WITHOUT engagement_id are untouched: no local SR write, the
// webhook founds under rule 1 exactly as before.

import { NextRequest, NextResponse } from 'next/server'
import { formatInTimeZone } from 'date-fns-tz'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { jobberGraphQL, jobberMutation } from '@/lib/jobber'
import { writeSyncLog } from '@/lib/sync-log'
import { requireIanaTimezone } from '@/lib/drip-time'
import { upsertServiceRequest } from '@/lib/jobber-import'
import { attachToEngagement } from '@/lib/engagements'
import {
  buildContactEditFields,
  resolveContactWriteback,
  type ContactWriteback,
} from '@/lib/jobber-contact-writeback'
import { getEngagementAssignees, resolveJobberAssignment } from '@/lib/engagement-assignee-sync'

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

// Jobber's ScheduledItemAttributes uses LocalDateTimeAttributes { date,
// time, timezone } for startAt/endAt — not an ISO 8601 string. Convert the
// stored UTC ISO timestamp into the location's local wall-clock pieces so
// Jobber renders the appointment in the right zone.
function toLocalDateTime(iso: string, timezone: string) {
  const ms = new Date(iso).getTime()
  return {
    date:     formatInTimeZone(ms, timezone, 'yyyy-MM-dd'),
    time:     formatInTimeZone(ms, timezone, 'HH:mm:ss'),
    timezone,
  }
}

function pickPrimaryAddress(lead: any): {
  street: string
  city: string
  state: string
  zip: string
} | null {
  // Prefer the jsonb array (current write path for new manual leads). Fall
  // through to the legacy single-column form when the jsonb entry is missing
  // or malformed — Jobber-imported leads only populate the legacy columns,
  // and stub jsonb entries (e.g. `{ type: 'Service' }` with no value) would
  // otherwise mask a perfectly valid legacy address.
  const addrs = Array.isArray(lead.addresses) ? lead.addresses : []
  if (addrs.length > 0) {
    const a = addrs[0]
    const street = (a.street || a.value || '').trim()
    if (street) {
      return {
        street,
        city:  (a.city  || '').trim(),
        state: (a.state || '').trim(),
        zip:   (a.zip   || '').trim(),
      }
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
// emails/phones carry their EncodedIds so a matched client's contact info
// can be updated via emailsToEdit/phonesToEdit without a second fetch — the
// contact write-back (lib/jobber-contact-writeback.ts) diffs against these.
const FIND_CLIENT_QUERY = /* GraphQL */ `
  query FindClient($searchTerm: String!) {
    clients(searchTerm: $searchTerm, first: 10) {
      nodes {
        id
        firstName
        lastName
        companyName
        emails { id address primary }
        phones { id number primary }
      }
    }
  }
`

// Jobber's Client type has two property-bearing fields: a legacy `properties`
// list (no pagination args accepted) and the current `clientProperties`
// connection. Sending `(first: N)` to `properties` fails with: Field
// 'properties' doesn't accept argument 'first'. The connection at
// `clientProperties` is the supported shape today.
const GET_CLIENT_PROPERTIES_QUERY = /* GraphQL */ `
  query GetClientProperties($clientId: EncodedId!) {
    client(id: $clientId) {
      id
      clientProperties(first: 50) {
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

// Jobber removed `clientCreateProperty` — the current entry point is the
// top-level `propertyCreate(clientId, input)` mutation, where input wraps
// a LIST of PropertyAttributes (you can create several in one call). Even
// for a single property we send `properties: [{ … }]`. The payload returns
// `properties` (also a list), not `property`.
const PROPERTY_CREATE_MUTATION = /* GraphQL */ `
  mutation PropertyCreate($clientId: EncodedId!, $input: PropertyCreateInput!) {
    propertyCreate(clientId: $clientId, input: $input) {
      properties { id address { street1 city province postalCode country } }
      userErrors { message path }
    }
  }
`

const REQUEST_CREATE_MUTATION = /* GraphQL */ `
  mutation RequestCreate($input: RequestCreateInput!) {
    requestCreate(input: $input) {
      request { id title createdAt jobberWebUri client { id } property { id } }
      userErrors { message path }
    }
  }
`

// Jobber moved `requestId` out of AssessmentCreateInput and onto the
// mutation as a top-level arg; the input now only carries `instructions`
// and `schedule: ScheduledItemAttributes`. Inside schedule, startAt/endAt
// are LocalDateTimeAttributes objects, not ISO strings.
const ASSESSMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation AssessmentCreate(
    $requestId: EncodedId!,
    $input: AssessmentCreateInput!
  ) {
    assessmentCreate(requestId: $requestId, input: $input) {
      assessment { id }
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
  // job_direct is gated off until JobCreateAttributes' newly-required fields
  // (jobFormIds, notes, invoicing, lineItems, customFields) have product-
  // defined defaults. See JOB_CREATE_MUTATION below for the schema context.
  if (creation_type === 'job_direct') {
    return fail(
      'validation',
      "Direct job creation isn't supported yet. Use Request (with or without Assessment) instead.",
      400,
    )
  }
  const scheduled_assessment_at: string | undefined = body.scheduled_assessment_at
  const assessment_type: 'in-person' | 'virtual' | undefined = body.assessment_type
  if (creation_type === 'request_with_assessment') {
    if (!scheduled_assessment_at) {
      return fail(
        'validation',
        'Cannot send to Jobber: assessment time required.',
        400,
      )
    }
    if (Number.isNaN(Date.parse(scheduled_assessment_at))) {
      return fail(
        'validation',
        `Cannot send to Jobber: assessment time is not a valid date ("${scheduled_assessment_at}").`,
        400,
      )
    }
    if (assessment_type && assessment_type !== 'in-person' && assessment_type !== 'virtual') {
      return fail('validation', 'invalid_assessment_type', 400)
    }
  }

  // Optional founded-engagement link (decoupled founding). Validated
  // against the lead below, before any Jobber mutation fires.
  const engagementId: string | null =
    typeof body.engagement_id === 'string' && body.engagement_id.trim()
      ? body.engagement_id.trim()
      : null

  // Address is only mandatory for in-person assessments. request_only and
  // virtual assessments proceed without a property — mirrors the Deluge
  // reference, which skipped property creation when street1 was empty.
  // (job_direct also needs an address but is gated above.)
  const addressRequired =
    creation_type === 'request_with_assessment' && assessment_type === 'in-person'

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

  // engagement_id must be THIS lead's open engagement — fail fast, before
  // any Jobber write. A mismatched id would silently attach the new
  // request to someone else's work cycle.
  if (engagementId) {
    const { data: eng } = await supabaseService
      .from('engagements')
      .select('id, client_id, stage')
      .eq('id', engagementId)
      .maybeSingle()
    if (!eng) return fail('validation', 'engagement_not_found', 400)
    if (eng.client_id !== leadId) {
      return fail('validation', 'engagement_belongs_to_different_client', 400)
    }
    if (eng.stage === 'Closed Won' || eng.stage === 'Closed Lost') {
      return fail('validation', 'engagement_already_closed', 400)
    }
  }

  const { data: location } = await supabaseService
    .from('locations')
    .select('id, location_id, name, timezone, jobber_access_token')
    .eq('location_id', locationSlug)
    .maybeSingle()
  if (!location) return fail('lookup', 'location_not_found', 404)
  if (!location.jobber_access_token) {
    return fail('lookup', 'location_not_connected_to_jobber', 400)
  }

  // Assignee → Jobber ids. Assignment lives ONLY on the engagement
  // (engagement_assignees, plural) — read the junction when we have an
  // engagementId. Request/job take ONE salesperson (the PRIMARY = first
  // assignee); the assessment appointment takes ALL mapped assignees.
  // No leads.assigned_to fallback: that column is import-stamped junk
  // (ids aren't hub_users) and assignment is forward-only now. A bare
  // lead send (no engagementId — the webhook founds the engagement later)
  // simply ships unassigned; the user assigns via the panel afterward.
  let salesPersonJobberId: string | null = null   // request/job salesperson (singular)
  let allAssigneeJobberIds: string[] = []          // assessment appointment (multi)
  if (engagementId) {
    const engAssignees = await getEngagementAssignees(engagementId)
    const resolved = resolveJobberAssignment(engAssignees)
    salesPersonJobberId = resolved.primaryJobberUserId
    allAssigneeJobberIds = resolved.allJobberUserIds
  }

  // ── Address ─────────────────────────────────────────────────────
  const address = pickPrimaryAddress(lead)
  if (!address && addressRequired) {
    return fail(
      'validation',
      'Cannot send to Jobber: lead has no street address. ' +
      'Add an address to the lead before sending.',
      400,
    )
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
  let matchedClientNode: any = null

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
      matchedClientNode = exactMatch
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 2. CREATE or UPDATE the client
  // ─────────────────────────────────────────────────────────────────
  let contactWriteback: ContactWriteback = { phone: 'unchanged', email: 'unchanged' }

  if (jobberClientGlobalId) {
    // Matched: refresh name in case it changed locally, and sync phone/email
    // through phonesToEdit/phonesToAdd (emails mirror) using the entry ids
    // the search already fetched — fetch-at-push, nothing stored, never a
    // *ToDelete. Values already present on the client are omitted entirely.
    const { fields: contactFields, plan: contactPlan } = buildContactEditFields(
      { phone, email },
      {
        phones: matchedClientNode?.phones || [],
        emails: matchedClientNode?.emails || [],
      },
    )
    const editInput: Record<string, any> = {
      firstName: firstName || null,
      lastName:  lastName  || null,
      ...contactFields,
    }
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
    contactWriteback = resolveContactWriteback(contactPlan, !!edit.userErrors?.length)
  } else {
    const createInput: Record<string, any> = {
      firstName: firstName || null,
      lastName:  lastName  || null,
    }
    if (email) createInput.emails = [{ address: email, primary: true }]
    if (phone) createInput.phones = [{ number: phone, primary: true }]
    contactWriteback = {
      phone: phone ? 'added' : 'unchanged',
      email: email ? 'added' : 'unchanged',
    }
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
      const existing: any[] = propsRes.data?.client?.clientProperties?.nodes || []
      const wantedStreet = address.street.toLowerCase()
      const matchedProp = existing.find((p: any) =>
        (p.address?.street1 || '').trim().toLowerCase() === wantedStreet
      )
      if (matchedProp) jobberPropertyGlobalId = matchedProp.id
    }

    if (!jobberPropertyGlobalId) {
      const propCreate = await jobberMutation(
        locationSlug,
        PROPERTY_CREATE_MUTATION,
        {
          clientId: jobberClientGlobalId,
          input: {
            properties: [{
              address: {
                street1:    address.street,
                city:       address.city || null,
                province:   address.state || null,
                postalCode: address.zip || null,
                country:    'US',
              },
            }],
          },
        },
      )
      if (propCreate.userErrors?.length) {
        return fail('property_create', propCreate.userErrors[0].message)
      }
      jobberPropertyGlobalId =
        propCreate.data?.propertyCreate?.properties?.[0]?.id || null
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

  const requestTitle =
    (lead.name || `${firstName} ${lastName}`.trim() || 'Service Request').slice(0, 200)

  if (creation_type === 'request_only' || creation_type === 'request_with_assessment') {
    const requestInput: Record<string, any> = {
      clientId: jobberClientGlobalId,
      title:    requestTitle,
      // `requestDetails` on RequestCreateInput is now a RequestDetailsInput
      // object wrapping a FormInput, not a free-form string. We don't have a
      // form mapping today, so the field is omitted; lead.request_details
      // continues to live on the Bee Hub side until we wire form sync.
    }
    // Only include propertyId when we actually have one — Deluge mirrored
    // this with two requestCreate variants. Omitting the key lets Jobber
    // accept the request without a property attached.
    if (jobberPropertyGlobalId) requestInput.propertyId = jobberPropertyGlobalId
    // Owner assignment at CREATION (card-restore build 3): introspection
    // 2026-07-11 confirmed RequestCreateInput.salespersonId: EncodedId —
    // the same stored jobber_user_id the assessment assignment uses.
    // NON-FATAL like that path: if Jobber rejects the id (stale roster
    // link, deactivated user), retry once WITHOUT it rather than killing
    // the whole send.
    if (salesPersonJobberId) requestInput.salespersonId = salesPersonJobberId
    let reqCreate = await jobberMutation(
      locationSlug,
      REQUEST_CREATE_MUTATION,
      { input: requestInput },
    )
    if (reqCreate.userErrors?.length && requestInput.salespersonId) {
      console.warn('[send-to-jobber] requestCreate with salespersonId failed — retrying unassigned', {
        leadId, salespersonId: requestInput.salespersonId,
        userErrors: JSON.stringify(reqCreate.userErrors),
      })
      await writeSyncLog({
        location_id: locationSlug,
        entity_id: leadId,
        entity_type: 'client',
        status: 'success',
        message: `[send-to-jobber] topic=REQUEST_ASSIGN_RETRY salespersonId=${requestInput.salespersonId} rejected (${reqCreate.userErrors[0]?.message ?? 'unknown'}) — request created unassigned`,
      })
      delete requestInput.salespersonId
      reqCreate = await jobberMutation(
        locationSlug,
        REQUEST_CREATE_MUTATION,
        { input: requestInput },
      )
    }
    if (reqCreate.userErrors?.length) {
      return fail('request_create', reqCreate.userErrors[0].message)
    }
    const requestRec = reqCreate.data?.requestCreate?.request || null
    jobberRequestGlobalId = requestRec?.id || null
    if (!jobberRequestGlobalId) {
      return fail('request_create', 'request_create_returned_no_id')
    }

    // Founded-engagement link: pre-write the local SR row for the new
    // Jobber request and attach it to the founded engagement NOW, so the
    // REQUEST_CREATE webhook (which upserts by jobber_request_id and only
    // founds when the SR has no engagement_id) attaches idempotently
    // instead of founding a second engagement. promoteLead=false — the
    // webhook path owns leads.stage promotion, exactly as before.
    // Non-fatal: the Jobber side already succeeded; a failed local link
    // degrades to the old webhook-founds behavior and is logged.
    if (engagementId) {
      try {
        const sr = await upsertServiceRequest(
          requestRec,
          leadId,
          locationSlug,
          { promoteLead: false },
        )
        await attachToEngagement('service_requests', sr.id, engagementId)
      } catch (err: any) {
        console.error('[send-to-jobber] founded-engagement SR link failed', {
          leadId, engagementId, error: err?.message || String(err),
        })
      }
    }

    if (creation_type === 'request_with_assessment') {
      // Assessments are time-boxed; Jobber's UI defaults to 1hr if endAt
      // is omitted. We mirror that by sending a 1hr endAt explicitly so
      // calendar views render with a sensible block.
      const startMs = new Date(scheduled_assessment_at!).getTime()
      const endMs   = startMs + 60 * 60 * 1000
      // Jobber's LocalDateTimeAttributes requires an IANA timezone. The
      // locations.timezone column historically stores friendly labels like
      // "Eastern Time (ET)"; requireIanaTimezone translates known labels and
      // throws on anything it can't confidently resolve. No silent fallback —
      // a wrong zone misplaces appointments on the customer's calendar.
      let tz: string
      try {
        tz = requireIanaTimezone((location as any).timezone)
      } catch (err: any) {
        return fail(
          'validation',
          `Cannot send to Jobber: ${err?.message || 'invalid location timezone'}. ` +
          `Update Settings → Location → Timezone.`,
          400,
        )
      }
      const assessCreate = await jobberMutation(
        locationSlug,
        ASSESSMENT_CREATE_MUTATION,
        {
          requestId: jobberRequestGlobalId,
          input: {
            schedule: {
              startAt: toLocalDateTime(new Date(startMs).toISOString(), tz),
              endAt:   toLocalDateTime(new Date(endMs).toISOString(),   tz),
            },
          },
        },
      )
      if (assessCreate.userErrors?.length) {
        return fail('assessment_create', assessCreate.userErrors[0].message)
      }
      jobberAssessmentGlobalId = assessCreate.data?.assessmentCreate?.assessment?.id || null

      // Assign the team to the assessment appointment. MULTI now
      // (engagement-assigned-to-multi): AppointmentEditAssignmentInput.
      // assignedUserIds is [EncodedId!]! (introspected 2026-07-11), so we
      // send ALL mapped assignees, not just one. Non-fatal — a missing
      // assignment shouldn't kill the whole send. Unmapped assignees
      // (no jobber_user_id) are simply absent from the array.
      if (jobberAssessmentGlobalId && allAssigneeJobberIds.length > 0) {
        const assign = await jobberMutation(
          locationSlug,
          APPOINTMENT_EDIT_ASSIGNMENT_MUTATION,
          {
            appointmentId: jobberAssessmentGlobalId,
            input: { assignedUserIds: allAssigneeJobberIds },
          },
        )
        if (assign.userErrors?.length) {
          console.warn('[send-to-jobber] assignment userErrors',
            JSON.stringify(assign.userErrors))
        }
      }
    }
  }
  // job_direct branch removed: gated at validation. Restore the mutation
  // when JobCreateAttributes' required fields are wired up — schema
  // confirmed via introspection, see commit history for the prior shape.

  // ─────────────────────────────────────────────────────────────────
  // 5. Writeback to lead
  // ─────────────────────────────────────────────────────────────────
  const jobberClientId     = extractJobberId(jobberClientGlobalId)
  const jobberPropertyId   = extractJobberId(jobberPropertyGlobalId)
  const jobberRequestId    = extractJobberId(jobberRequestGlobalId)
  const jobberAssessmentId = extractJobberId(jobberAssessmentGlobalId)

  const typeLabel = creation_type === 'request_only'
    ? 'Request'
    : 'Request + Assessment'
  const syncedAtIso = new Date().toISOString()

  const writeback: Record<string, any> = {
    jobber_client_id:     jobberClientId,
    jobber_property_id:   jobberPropertyId,
    jobber_request_id:    jobberRequestId    ?? lead.jobber_request_id ?? null,
    jobber_assessment_id: jobberAssessmentId ?? lead.jobber_assessment_id ?? null,
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
    // Special case: leads_jobber_client_id_location_idx is a unique index on
    // (location_id, jobber_client_id). It trips when the Jobber client we just
    // matched/created is already linked to a DIFFERENT Bee Hub lead in the
    // same location (e.g. two intake records for the same person, or one
    // intake plus a previously-imported lead). The Jobber side has already
    // succeeded by this point — the request/property/assessment are real and
    // orphaned from a Bee Hub lead. Surface as 400 with the owner lead so
    // the user can navigate there instead of seeing a raw Postgres error.
    // The index STAYS (decision 2026-07-04): it is the guardrail against
    // duplicate Jobber-linked leads. The returning-client flow routes
    // AROUND it — decoupled founding (POST /api/engagements) creates the
    // new engagement under the EXISTING lead, so no second row is ever
    // written and this branch is only reachable from legacy duplicates.
    const isClientIdDup =
      writeErr.code === '23505' &&
      (writeErr.message?.includes('leads_jobber_client_id_location_idx') ||
       writeErr.details?.includes('jobber_client_id'))
    if (isClientIdDup && jobberClientId) {
      const { data: owner } = await supabaseService
        .from('leads')
        .select('id, name, email')
        .eq('jobber_client_id', jobberClientId)
        .eq('location_id', locationSlug)
        .neq('id', leadId)
        .maybeSingle()
      const ownerLabel = owner
        ? `lead "${owner.name || owner.email || owner.id.slice(0, 8)}"`
        : 'another lead'
      return fail(
        'writeback',
        `This Jobber client (JC-${jobberClientId}) is already linked to ${ownerLabel} ` +
        `in this location. The Jobber request was created — open that lead to ` +
        `view its history, or unlink it before resending.`,
        400,
        {
          jobber_client_id:     jobberClientId,
          jobber_property_id:   jobberPropertyId,
          jobber_request_id:    jobberRequestId,
          jobber_assessment_id: jobberAssessmentId,
          owner_lead_id:        owner?.id || null,
          owner_lead_name:      owner?.name || null,
          owner_lead_email:     owner?.email || null,
        },
      )
    }
    return fail('writeback', writeErr.message, 500, {
      // Surface the IDs anyway — the Jobber side succeeded, only the local
      // mirror failed. The caller can retry the writeback or sync later.
      jobber_client_id:     jobberClientId,
      jobber_request_id:    jobberRequestId,
      jobber_assessment_id: jobberAssessmentId,
    })
  }

  // ── sync_log (fire-and-forget; failures don't block the response) ──
  await writeSyncLog({
    location_id:      locationSlug,
    entity_id:        leadId,
    entity_type:      'request',
    direction:        'outbound',
    jobber_record_id: jobberRequestId || jobberClientId || '',
    status:           'success',
    message:
      `Send-to-Jobber (${typeLabel}); match=${matchStatus}; ` +
      `client=${jobberClientId}` +
      (jobberRequestId    ? `; request=${jobberRequestId}`    : '') +
      (jobberAssessmentId ? `; assessment=${jobberAssessmentId}` : '') +
      (engagementId       ? `; engagement=${engagementId}`    : '') +
      `; contact=phone:${contactWriteback.phone},email:${contactWriteback.email}`,
  })

  return NextResponse.json({
    success:              true,
    match_status:         matchStatus,
    jobber_client_id:     jobberClientId,
    jobber_property_id:   jobberPropertyId,
    jobber_request_id:    jobberRequestId,
    jobber_assessment_id: jobberAssessmentId,
    contact_writeback:    contactWriteback,
  })
}
