// app/api/leads/[id]/route.ts
//
// PATCH /api/leads/:id — update a lead (Hive client record)
//
// Used by PersonPanel's update() function. Accepts a partial body containing
// any of the updatable fields. Validates inputs, enforces location scoping
// for non-admin users, dual-writes to Supabase + Zoho via lib/dual-write.
//
// Auth: must be a logged-in hub_user.
// Scope: super_admin/admin can update any lead. owner/lite_user can only
//        update leads in their own location.
// Validation: stage values are checked against the 7 allowed; addresses
//             must be an array; is_junk must be boolean.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { updateLead } from '@/lib/dual-write'
import { isAdmin } from '@/lib/auth'

const VALID_STAGES = [
  'New',
  'Nurturing',
  'Estimate',
  'Job in Progress',
  'Final Processing',
  'Won',
  'Lost',
] as const

// Fields a client request can update. Anything not in this list is dropped
// silently — prevents accidental overwriting of jobber_synced_at, created_at,
// location_id (slug), etc.
const PATCHABLE_FIELDS = new Set([
  'stage',
  'source',
  'project_type',
  'drip_path',
  'move_drip_path',
  'is_junk',
  'final_processed',
  'closed_lost_reason',
  'closed_lost_note',
  'referred_by_kind',
  'referred_by_id',
  'addresses',
  'assigned_to',
  'name',
  'first_name',
  'last_name',
  'email',
  'phone',
  // legacy single-field address (kept writable until we drop it post-launch)
  'address',
  'city',
  'state',
  'zip',
])

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  // ─── Auth ──────────────────────────────────────────────────────
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

  // ─── Parse body ────────────────────────────────────────────────
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  // ─── Load existing lead for scoping check ─────────────────────
  const { data: existing, error: loadError } = await supabaseService
    .from('leads')
    .select('id, location_uuid, location_id, stage')
    .eq('id', id)
    .single()

  if (loadError || !existing) {
    return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  }

  // ─── Location scoping ─────────────────────────────────────────
  // Admins/super_admins can edit any lead. Owners + lite_users restricted
  // to leads in their own location.
  if (!isAdmin(hubUser.role)) {
    if (hubUser.location_id !== existing.location_uuid) {
      return NextResponse.json(
        { error: 'forbidden_wrong_location' },
        { status: 403 }
      )
    }
    // lite_users are read-only — block writes outright
    if (hubUser.role === 'lite_user') {
      return NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 })
    }
  }

  // ─── Validate + filter patch ──────────────────────────────────
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (!PATCHABLE_FIELDS.has(key)) continue // silently drop unknown
    patch[key] = value
  }

  // Stage validation
  if ('stage' in patch) {
    if (typeof patch.stage !== 'string' || !VALID_STAGES.includes(patch.stage as typeof VALID_STAGES[number])) {
      return NextResponse.json(
        { error: 'invalid_stage', allowed: VALID_STAGES },
        { status: 400 }
      )
    }
  }

  // is_junk + final_processed must be boolean
  for (const k of ['is_junk', 'final_processed'] as const) {
    if (k in patch && typeof patch[k] !== 'boolean') {
      return NextResponse.json({ error: `${k}_must_be_boolean` }, { status: 400 })
    }
  }

  // addresses must be an array of {type, value} objects
  if ('addresses' in patch) {
    if (!Array.isArray(patch.addresses)) {
      return NextResponse.json({ error: 'addresses_must_be_array' }, { status: 400 })
    }
    for (const a of patch.addresses as unknown[]) {
      if (typeof a !== 'object' || a === null) {
        return NextResponse.json({ error: 'address_entry_must_be_object' }, { status: 400 })
      }
    }
  }

  // referred_by_kind must be one of allowed values (or null)
  if ('referred_by_kind' in patch) {
    const v = patch.referred_by_kind
    if (v !== null && v !== 'partner' && v !== 'lead') {
      return NextResponse.json(
        { error: 'invalid_referred_by_kind', allowed: ['partner', 'lead', null] },
        { status: 400 }
      )
    }
  }

  // ─── Write ────────────────────────────────────────────────────
  // updateLead handles Supabase + Zoho dual-write. For fields it doesn't
  // know how to sync to Zoho (drip_path, is_junk, addresses jsonb, etc.),
  // it just updates Supabase — Zoho doesn't need every field. Stage and
  // source are the important sync paths.

  try {
    await updateLead(id, patch as any)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'update_failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // ─── Touchpoint on stage change ───────────────────────────────
  // Auto-log a stage_change touchpoint so the activity feed shows it.
  if ('stage' in patch && patch.stage !== existing.stage) {
    await supabaseService.from('touchpoints').insert({
      lead_id: id,
      location_uuid: existing.location_uuid,
      kind: 'stage_change',
      label: `Stage: ${existing.stage} → ${patch.stage}`,
      user_id: hubUser.id,
      occurred_at: new Date().toISOString(),
    })
  }

  // ─── Return fresh row ─────────────────────────────────────────
  const { data: fresh, error: refetchError } = await supabaseService
    .from('leads')
    .select('*')
    .eq('id', id)
    .single()

  if (refetchError) {
    return NextResponse.json({ error: 'refetch_failed' }, { status: 500 })
  }

  return NextResponse.json({ lead: fresh }, { status: 200 })
}