// app/api/drip-paths/[id]/steps/route.ts
//
// PATCH /api/drip-paths/:id/steps
//   Body: { steps: Array<{ id?, step_order, delay_days, channel,
//          master_template_id?, subject?, body? }> }
//
// Replaces the entire step set for a path with the provided list. New rows
// (no id) are inserted; rows referenced by id are updated; rows in the DB
// not present in the payload are deleted. This makes the editor "save"
// idempotent — caller just sends what should exist.
//
// Channel must be 'email' or 'sms' per the drip_path_steps CHECK constraint.
//
// Auth matches /api/drip-paths/[id]: super_admin or owner of the location.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

const VALID_CHANNELS = new Set(['email', 'sms'])

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const pathId = params.id

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })

  const { data: path } = await supabaseService
    .from('drip_paths')
    .select('id, location_uuid')
    .eq('id', pathId)
    .maybeSingle()
  if (!path) return NextResponse.json({ error: 'path_not_found' }, { status: 404 })

  // Drip step edits are owner/elevated config — block lite_user (read-only)
  // and manager (operational lead; no drip/template config).
  if (hubUser.role === 'lite_user' || hubUser.role === 'manager') {
    return NextResponse.json({ error: 'forbidden_read_only' }, { status: 403 })
  }
  if (!isAdmin(hubUser.role) && hubUser.location_id !== path.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  if (!Array.isArray(body.steps)) {
    return NextResponse.json({ error: 'steps_must_be_array' }, { status: 400 })
  }

  // Validate + normalize step payload
  type StepIn = { id?: string; step_order: number; delay_days: number; channel: string; master_template_id: string | null; subject: string | null; body: string | null }
  const stepsIn: StepIn[] = []
  for (const raw of body.steps as Array<Record<string, unknown>>) {
    if (typeof raw !== 'object' || raw === null) {
      return NextResponse.json({ error: 'step_entry_must_be_object' }, { status: 400 })
    }
    const step_order = typeof raw.step_order === 'number' ? raw.step_order : NaN
    if (!Number.isFinite(step_order) || step_order < 1) {
      return NextResponse.json({ error: 'invalid_step_order' }, { status: 400 })
    }
    const delay_days = typeof raw.delay_days === 'number' ? raw.delay_days : 0
    if (!Number.isFinite(delay_days) || delay_days < 0) {
      return NextResponse.json({ error: 'invalid_delay_days' }, { status: 400 })
    }
    const channel = typeof raw.channel === 'string' ? raw.channel : 'email'
    if (!VALID_CHANNELS.has(channel)) {
      return NextResponse.json({ error: 'invalid_channel', allowed: Array.from(VALID_CHANNELS) }, { status: 400 })
    }
    stepsIn.push({
      id: typeof raw.id === 'string' ? raw.id : undefined,
      step_order,
      delay_days,
      channel,
      master_template_id: typeof raw.master_template_id === 'string' ? raw.master_template_id : null,
      subject: typeof raw.subject === 'string' ? raw.subject : null,
      body: typeof raw.body === 'string' ? raw.body : null,
    })
  }

  // Two-phase write to avoid bumping into the UNIQUE(drip_path_id, step_order)
  // constraint when reordering: stash incoming step_orders into a high range
  // first by deleting all existing rows, then inserting fresh ones. The DB has
  // ON DELETE CASCADE from drip_paths so no other table references step rows.
  const { error: delErr } = await supabaseService
    .from('drip_path_steps')
    .delete()
    .eq('drip_path_id', pathId)
  if (delErr) {
    console.error('[/api/drip-paths/[id]/steps PATCH] delete error:', delErr.message)
    return NextResponse.json({ error: 'delete_failed', detail: delErr.message }, { status: 500 })
  }

  if (stepsIn.length === 0) {
    return NextResponse.json({ ok: true, steps: [] })
  }

  const insertRows = stepsIn.map(s => ({
    drip_path_id: pathId,
    step_order: s.step_order,
    delay_days: s.delay_days,
    channel: s.channel,
    master_template_id: s.master_template_id,
    subject: s.subject,
    body: s.body,
    is_active: true,
  }))

  const { data: inserted, error: insErr } = await supabaseService
    .from('drip_path_steps')
    .insert(insertRows)
    .select('id, step_order, delay_days, channel, subject, body, master_template_id, is_active')

  if (insErr) {
    console.error('[/api/drip-paths/[id]/steps PATCH] insert error:', insErr.message)
    return NextResponse.json({ error: 'insert_failed', detail: insErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, steps: inserted ?? [] })
}
