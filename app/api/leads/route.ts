// app/api/leads/route.ts
//
// POST /api/leads — authenticated, in-app manual lead creation.
//
// Distinct from /api/leads/intake, which uses an X-API-Key for external
// webhooks. This route uses the Supabase session and is what the New Lead
// Modal in components/BeeHub.jsx calls when an owner/admin/super_admin
// creates a record by hand.
//
// OPT-IN NOTIFICATIONS (manual create): the create form offers three
// independent, default-OFF actions — notifyEmail / notifySlack / startDrip
// — each reusing the SAME underlying function the webhook intake path uses
// (notifyNewLead / notifyNewLeadSlack / applyDripSideEffects+sendDripStep).
// Each fires only when selected, each is fail-soft (own try/catch → warnings)
// and NEVER blocks the lead row or the response. Nothing selected = silent.
// Legacy callers that omit startDrip fall back to the historical skip_drip
// default-ON drip behavior. The X-API-Key webhook route /api/leads/intake is
// SEPARATE and unchanged — it always fires all three automatically.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { applyDripSideEffects } from '@/lib/drip-lifecycle'
import { sendDripStep } from '@/lib/drip-send'
import { notifyNewLead } from '@/lib/lead-notification-email'
import { notifyNewLeadSlack } from '@/lib/slack-bot'
import { logSlackNotification } from '@/lib/notification-log'
import { writeLeadAssignment } from '@/lib/lead-assignment'

export const runtime = 'nodejs'

type Body = {
  location_uuid?: string
  assigned_to?: string | null
  name?: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
  source?: string | null
  project_type?: string | null
  drip_path?: string | null
  // Address: caller sends both the legacy single-field string and the
  // jsonb-array form. The mapper falls back to legacy when addresses is
  // empty, so we mirror the import route and write both.
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
  addresses?: any
  referred_by_kind?: 'partner' | 'lead' | 'company' | null
  referred_by_id?: string | null
  marketing_opt_out?: boolean
  request_details?: string | null
  notes?: string | null
  stage?: string
  skip_drip?: boolean
  // Opt-in notification actions (manual create form). All default OFF; each
  // fires independently, reusing the intake path's functions. startDrip is
  // the explicit successor to skip_drip — when present it wins; when absent
  // the legacy skip_drip default-ON behavior applies (classic modal).
  notifyEmail?: boolean
  notifySlack?: boolean
  startDrip?: boolean
}

const VALID_STAGES = new Set([
  'New', 'Attempting', 'Nurturing', 'Request',
  'Estimate Sent', 'Job in Progress', 'Final Processing',
  'Closed Won', 'Closed Lost',
])

export async function POST(req: NextRequest) {
  // ─── Auth ─────────────────────────────────────────────────────
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  if (hubUser.role === 'lite_user') {
    return NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 })
  }

  // ─── Parse body ───────────────────────────────────────────────
  let body: Body
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  // ─── Validation ───────────────────────────────────────────────
  if (!body.location_uuid || typeof body.location_uuid !== 'string') {
    return NextResponse.json({ error: 'location_uuid_required' }, { status: 400 })
  }

  const firstName = (body.first_name || '').trim()
  const lastName  = (body.last_name  || '').trim()
  const composedName = (body.name || `${firstName} ${lastName}`).trim()
  if (!composedName) {
    return NextResponse.json({ error: 'name_required' }, { status: 400 })
  }

  const stage = body.stage || 'New'
  if (!VALID_STAGES.has(stage)) {
    return NextResponse.json({ error: 'invalid_stage' }, { status: 400 })
  }

  // 'company' is Network Phase 1 (network_phase1.sql widens the DB CHECK to
  // match; until it runs, a company referrer is rejected by the DB, loudly).
  if (body.referred_by_kind && !['partner', 'lead', 'company'].includes(body.referred_by_kind)) {
    return NextResponse.json({ error: 'invalid_referred_by_kind' }, { status: 400 })
  }

  if (body.addresses !== undefined && !Array.isArray(body.addresses)) {
    return NextResponse.json({ error: 'addresses_must_be_array' }, { status: 400 })
  }

  // ─── Location scoping ────────────────────────────────────────
  // Owner can only create in their own location. Admin/super_admin pass.
  if (!isAdmin(hubUser.role)) {
    if (hubUser.location_id !== body.location_uuid) {
      return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
    }
  }

  // ─── Read-only guard (868kawwmh) ──────────────────────────────
  const roBlock = await readOnlyWriteBlock(hubUser, body.location_uuid)
  if (roBlock) return roBlock

  // Resolve the slug — leads.location_id stores the slug, not the UUID
  // (matches dual-write + jobber-clients import).
  const { data: location, error: locErr } = await supabaseService
    .from('locations')
    .select('id, location_id, name')
    .eq('id', body.location_uuid)
    .maybeSingle()
  if (locErr) {
    return NextResponse.json({ error: 'location_lookup_failed', detail: locErr.message }, { status: 500 })
  }
  if (!location) {
    return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
  }

  // ─── assigned_to validation (must be a hub_user in this location) ──
  let assignedTo: string | null = null
  if (body.assigned_to) {
    const { data: assignee } = await supabaseService
      .from('hub_users')
      .select('id, location_id')
      .eq('id', body.assigned_to)
      .maybeSingle()
    if (!assignee) {
      return NextResponse.json({ error: 'assigned_to_user_not_found' }, { status: 400 })
    }
    // Tolerate cross-location assignment for admins; reject for owners.
    if (!isAdmin(hubUser.role) && assignee.location_id !== body.location_uuid) {
      return NextResponse.json({ error: 'assigned_to_wrong_location' }, { status: 400 })
    }
    assignedTo = assignee.id
  }

  // ─── Insert ──────────────────────────────────────────────────
  const now = new Date().toISOString()
  const insertPayload: Record<string, any> = {
    location_id:   location.location_id,
    location_uuid: location.id,
    assigned_to:   assignedTo,
    name:          composedName,
    first_name:    firstName || null,
    last_name:     lastName  || null,
    email:         (body.email || '').trim() || null,
    phone:         (body.phone || '').trim() || null,
    source:        body.source || null,
    project_type:  body.project_type || null,
    drip_path:     body.drip_path || null,
    address:       body.address || null,
    city:          body.city  || null,
    state:         body.state || null,
    zip:           body.zip   || null,
    addresses:     Array.isArray(body.addresses) ? body.addresses : [],
    referred_by_kind: body.referred_by_kind || null,
    referred_by_id:   body.referred_by_id   || null,
    marketing_opt_out: !!body.marketing_opt_out,
    request_details:   body.request_details || null,
    notes:             body.notes || null,
    stage,
    created_at: now,
    updated_at: now,
  }

  const { data: lead, error: insertErr } = await supabaseService
    .from('leads')
    .insert(insertPayload)
    .select('*')
    .single()
  if (insertErr || !lead) {
    return NextResponse.json(
      { error: 'insert_failed', detail: insertErr?.message },
      { status: 500 },
    )
  }

  // ─── Mirror the assignment into the plural junction ──────────
  // This route takes a SINGLE assigned_to from the create form (which defaults
  // to the creating user), and that column is written above. Mirror it into
  // lead_assignees so the lead's assignment lives where every other path reads
  // it — without this, a hand-created lead would found its engagement with an
  // EMPTY assignee set (seedEngagementAssigneesFromLead reads the junction, not
  // the legacy column).
  //
  // Fail-soft by construction (writeLeadAssignment never throws); the redundant
  // assigned_to write it performs is a harmless no-op against the value already
  // inserted. Nothing here can cost us the lead row.
  if (assignedTo) {
    const mirrored = await writeLeadAssignment({
      leadId: lead.id,
      assignedVia: 'manual', // a human picked this; not an auto-resolution
      resolved: {
        hubUserIds: [assignedTo],
        basis: 'location_owner',
        splitEnabled: false,
        resolvedProjectType: null,
        projectTypeUnrecognized: false,
        externalClaimants: [],
      },
    })
    if (!mirrored.junctionWritten) {
      console.warn(
        `[leads] lead ${lead.id} created with assigned_to but no lead_assignees row — ${mirrored.warnings.join('; ')}`,
      )
    }
  }

  // ─── Seed creation touchpoint ────────────────────────────────
  // Without this, post-reload `outreachTimeline` is empty and the
  // PersonPanel "Last Activity" field collapses to em-dash. Mirrors
  // the optimistic in-memory entry that BeeHub adds on create.
  await supabaseService.from('touchpoints').insert({
    lead_id:       lead.id,
    location_uuid: location.id,
    kind:          'system',
    method:        'system',
    label:         'Client created',
    status:        'done',
    occurred_at:   now,
    user_id:       null,
  })

  // ─── Opt-in notifications (manual create only) ────────────────
  // The create form offers three INDEPENDENT, default-OFF actions. Each
  // fires ONLY when selected, each reuses the SAME function the webhook
  // intake path uses, and each is fully fail-soft: a failure is collected
  // as a warning and NEVER blocks the others, the lead row (already
  // inserted above), or the 201 response. Nothing selected = silent —
  // matches the pre-notification manual behavior. This is opt-in ONLY;
  // /api/leads/intake (website/webhook) always fires all three and is
  // untouched.
  const warnings: string[] = []

  // Base URL for the "open this lead" deep-links — same fallback chain the
  // intake path uses (proxy-fronted override → site url → request origin).
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ||
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
    req.nextUrl?.origin ||
    null

  // 1) Notification email → the SAME notifyNewLead the intake path calls
  //    (B1 recipient resolution + template). Zero recipients is a quiet
  //    no-send, not an error.
  if (body.notifyEmail === true) {
    try {
      const notify = await notifyNewLead({
        location: { id: location.id, name: location.name },
        // locations.location_id is the SLUG, not the uuid (notification_log).
        locationSlug: location.location_id,
        baseUrl,
        lead: {
          id: lead.id,
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          project_type: lead.project_type,
          request_details: lead.request_details,
          preferred_contact: lead.preferred_contact ?? null,
        },
      })
      if (notify.error) warnings.push(`lead_notification_failed: ${notify.error}`)
    } catch (err: any) {
      console.error('[leads] notifyNewLead threw', err)
      warnings.push(`lead_notification_failed: ${err?.message || String(err)}`)
    }
  }

  // 2) Slack post → the SAME notifyNewLeadSlack the intake path calls. It
  //    does its own fail-soft slack_connected read (a not-connected or
  //    not-yet-migrated location returns a quiet skip), so the slack_connected
  //    gate is enforced inside, exactly as on intake.
  if (body.notifySlack === true) {
    // Shared by the success + throw branches below so both record the same
    // lead/location against the slack row.
    const slackLogContext = {
      lead_id: lead.id,
      lead_name: lead.name,
      location_id: location.id,
      // locations.location_id is the SLUG, not the uuid.
      location_slug: location.location_id,
    }
    try {
      const slackRes = await notifyNewLeadSlack({
        locationId: location.id,
        locationName: location.name,
        baseUrl,
        lead: {
          id: lead.id,
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          project_type: lead.project_type,
          request_details: lead.request_details,
          preferred_contact: lead.preferred_contact ?? null,
          source: lead.source ?? null,
        },
      })
      if (slackRes.error) warnings.push(`slack_notification_failed: ${slackRes.error}`)
      await logSlackNotification(slackRes, slackLogContext)
    } catch (err: any) {
      console.error('[leads] notifyNewLeadSlack threw', err)
      warnings.push(`slack_notification_failed: ${err?.message || String(err)}`)
      await logSlackNotification(
        { ok: false, error: err?.message || String(err) },
        slackLogContext,
      )
    }
  }

  // 3) Drip → the SAME start path the intake create path uses:
  //    applyDripSideEffects on stage='New' delegates to startDripForLead
  //    (which carries the interface-active + paused + marketing-opt-out
  //    gates), then an inline sendDripStep so step 1 lands in seconds rather
  //    than waiting up to ~60 min for the next hourly cron tick (cron stays
  //    the backstop). Gate: explicit startDrip wins; legacy callers that
  //    omit it fall back to the historical skip_drip default-ON behavior.
  const wantsDrip =
    typeof body.startDrip === 'boolean' ? body.startDrip : body.skip_drip !== true
  if (stage === 'New' && wantsDrip) {
    try {
      await applyDripSideEffects({
        leadId:        lead.id,
        locationUuid:  location.id,
        prevStage:     null,
        patch:         { stage: 'New' },
      })
    } catch (err: any) {
      console.error('[drip] applyDripSideEffects on create threw', err)
      warnings.push(`drip_side_effects_failed: ${err?.message || String(err)}`)
    }

    try {
      await sendDripStep(lead.id)
    } catch (err: any) {
      console.error('[drip] inline sendDripStep on create threw', err)
      warnings.push(`drip_send_failed: ${err?.message || String(err)}`)
    }
  }

  return NextResponse.json(
    { lead, ...(warnings.length ? { warnings } : {}) },
    { status: 201 },
  )
}
