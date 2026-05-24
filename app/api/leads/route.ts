// app/api/leads/route.ts
//
// POST /api/leads — create a new lead from the in-app NewLeadModal.
//
// Auth: must be a logged-in hub_user (session cookie). lite_user blocked.
// Scope: admins can create in any location; owner restricted to their own.
// Side effects: fires startDripForLead (since new leads enter at stage='New').
//
// Distinct from /api/leads/intake, which is the X-API-Key webhook for
// inbound web-form leads.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { applyDripSideEffects } from '@/lib/drip-lifecycle'

const VALID_STAGES = [
  'New',
  'Attempting',
  'Nurturing',
  'Request',
  'Estimate Sent',
  'Job in Progress',
  'Final Processing',
  'Closed Won',
  'Closed Lost',
] as const

export async function POST(req: Request) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()

  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }

  if (hubUser.role === 'lite_user') {
    return NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 })
  }

  let body: Record<string, any>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const {
    location_uuid,
    name,
    first_name,
    last_name,
    email,
    phone,
    source,
    project_type,
    assigned_to,
    addresses,
    address,
    city,
    state,
    zip,
    stage,
    marketing_opt_out,
    drip_path,
    referred_by_kind,
    referred_by_id,
    request_details,
    notes,
  } = body || {}

  if (!location_uuid || typeof location_uuid !== 'string') {
    return NextResponse.json({ error: 'location_uuid_required' }, { status: 400 })
  }

  const finalName =
    (typeof name === 'string' && name.trim()) ||
    [first_name, last_name].filter(Boolean).join(' ').trim()
  if (!finalName) {
    return NextResponse.json({ error: 'name_required' }, { status: 400 })
  }

  const finalStage = typeof stage === 'string' && stage ? stage : 'New'
  if (!VALID_STAGES.includes(finalStage as typeof VALID_STAGES[number])) {
    return NextResponse.json(
      { error: 'invalid_stage', allowed: VALID_STAGES },
      { status: 400 },
    )
  }

  if (!isAdmin(hubUser.role) && hubUser.location_id !== location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  if (addresses !== undefined && !Array.isArray(addresses)) {
    return NextResponse.json({ error: 'addresses_must_be_array' }, { status: 400 })
  }

  // Look up the location slug (leads.location_id stores the slug, matching
  // the intake route + dual-write convention).
  const { data: location, error: locErr } = await supabaseService
    .from('locations')
    .select('id, location_id')
    .eq('id', location_uuid)
    .maybeSingle()

  if (locErr || !location) {
    return NextResponse.json({ error: 'location_not_found' }, { status: 400 })
  }

  const now = new Date().toISOString()

  const insertRow: Record<string, any> = {
    location_uuid: location.id,
    location_id: location.location_id,
    name: finalName,
    first_name: first_name || null,
    last_name: last_name || null,
    email: email || null,
    phone: phone || null,
    address: address || null,
    city: city || null,
    state: state || null,
    zip: zip || null,
    addresses: Array.isArray(addresses) ? addresses : [],
    project_type: project_type || null,
    stage: finalStage,
    source: source || null,
    assigned_to: assigned_to || null,
    marketing_opt_out: !!marketing_opt_out,
    drip_path: drip_path || null,
    referred_by_kind: referred_by_kind || null,
    referred_by_id: referred_by_id || null,
    request_details: request_details || null,
    notes: notes || null,
    created_at: now,
    updated_at: now,
  }

  const { data: inserted, error: insertErr } = await supabaseService
    .from('leads')
    .insert(insertRow)
    .select('*')
    .single()

  if (insertErr || !inserted) {
    return NextResponse.json(
      { error: 'insert_failed', detail: insertErr?.message },
      { status: 500 },
    )
  }

  // Fire drip start (lead entered at 'New'). Fire-and-forget; mirrors PATCH.
  if (finalStage === 'New') {
    void applyDripSideEffects({
      leadId: inserted.id,
      locationUuid: location.id,
      prevStage: null,
      patch: { stage: 'New' },
    }).catch((err) => console.error('[drip] applyDripSideEffects on create threw', err))
  }

  return NextResponse.json({ lead: inserted }, { status: 201 })
}
