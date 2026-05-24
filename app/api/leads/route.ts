// app/api/leads/route.ts
//
// POST /api/leads — authenticated, in-app manual lead creation.
//
// Distinct from /api/leads/intake, which uses an X-API-Key for external
// webhooks. This route uses the Supabase session and is what the New Lead
// Modal in components/BeeHub.jsx calls when an owner/admin/super_admin
// creates a record by hand.
//
// On stage='New' inserts (the default), kicks off applyDripSideEffects so
// the drip path auto-starts — same behavior the PATCH route gets on stage
// transitions into 'New'. Caller can pass skip_drip:true to opt out.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { applyDripSideEffects } from '@/lib/drip-lifecycle'
import { sendDripStep } from '@/lib/drip-send'

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
  referred_by_kind?: 'partner' | 'lead' | null
  referred_by_id?: string | null
  marketing_opt_out?: boolean
  request_details?: string | null
  notes?: string | null
  stage?: string
  skip_drip?: boolean
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

  if (body.referred_by_kind && !['partner', 'lead'].includes(body.referred_by_kind)) {
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

  // ─── Drip side-effects ───────────────────────────────────────
  // When stage='New' lands on a fresh lead, start the drip. prevStage=null
  // signals "no prior state" to applyDripSideEffects, which treats it as a
  // valid start trigger. Awaited (not fire-and-forget) because Vercel
  // serverless terminates background work once the response is sent —
  // without the await the row never gets inserted. Errors are swallowed so
  // a drip-bookkeeping failure doesn't fail the lead create itself.
  if (stage === 'New' && body.skip_drip !== true) {
    try {
      await applyDripSideEffects({
        leadId:        lead.id,
        locationUuid:  location.id,
        prevStage:     null,
        patch:         { stage: 'New' },
      })
    } catch (err) {
      console.error('[drip] applyDripSideEffects on create threw', err)
    }

    // ─── Inline step-1 send ──────────────────────────────────────
    // applyDripSideEffects scheduled the row with next_send_at=now();
    // firing here means the welcome email lands in seconds rather than
    // waiting up to ~60 minutes for the next hourly cron tick. The
    // cron remains as the backstop — any failure here just gets
    // retried then.
    try {
      await sendDripStep(lead.id)
    } catch (err) {
      console.error('[drip] inline sendDripStep on create threw', err)
    }
  }

  return NextResponse.json({ lead }, { status: 201 })
}
