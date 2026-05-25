// app/api/locations/[id]/drip-paths/clone/route.ts
//
// POST /api/locations/:id/drip-paths/clone
//   Body: { master_id: uuid }
//   Clones a master drip_paths row (and its drip_path_steps) into a
//   location-owned copy. The copy:
//     - is_master = false
//     - location_uuid = :id
//     - cloned_from_id = master_id
//     - path_key + name + is_active copied from master
//   Steps are copied verbatim (subject, body, delay_days, channel,
//   master_template_id, step_order).
//
// Auth: super_admin any location; owner only their own.
// Idempotent: if a path already exists for (:id, master.path_key), the
// existing path is returned instead of duplicating.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const locId = params.id

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
    return NextResponse.json({ error: 'forbidden_read_only' }, { status: 403 })
  }
  if (!isAdmin(hubUser.role) && hubUser.location_id !== locId) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const masterId = typeof body.master_id === 'string' ? body.master_id.trim() : ''
  if (!masterId) return NextResponse.json({ error: 'master_id_required' }, { status: 400 })

  // Load master + verify it's actually a master
  const { data: master, error: masterErr } = await supabaseService
    .from('drip_paths')
    .select('id, path_key, name, is_active, is_master')
    .eq('id', masterId)
    .maybeSingle()

  if (masterErr) {
    return NextResponse.json({ error: 'master_lookup_failed', detail: masterErr.message }, { status: 500 })
  }
  if (!master) return NextResponse.json({ error: 'master_not_found' }, { status: 404 })
  if (!master.is_master) return NextResponse.json({ error: 'not_a_master' }, { status: 400 })

  // Idempotency: if location already has this path_key, return it.
  const { data: existing } = await supabaseService
    .from('drip_paths')
    .select('id, location_uuid, path_key, name, is_active, cloned_from_id')
    .eq('location_uuid', locId)
    .eq('path_key', master.path_key)
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ path: existing, already_cloned: true })
  }

  // Load master's steps
  const { data: masterSteps, error: stepsErr } = await supabaseService
    .from('drip_path_steps')
    .select('step_order, delay_days, channel, subject, body, master_template_id, is_active')
    .eq('drip_path_id', master.id)
    .order('step_order', { ascending: true })

  if (stepsErr) {
    return NextResponse.json({ error: 'master_steps_lookup_failed', detail: stepsErr.message }, { status: 500 })
  }

  // Insert the copy
  const { data: copy, error: copyErr } = await supabaseService
    .from('drip_paths')
    .insert({
      location_uuid: locId,
      path_key: master.path_key,
      name: master.name,
      is_active: master.is_active,
      is_default: false,
      is_master: false,
      cloned_from_id: master.id,
    })
    .select('id, location_uuid, path_key, name, is_active, cloned_from_id')
    .single()

  if (copyErr || !copy) {
    console.error('[/api/locations/[id]/drip-paths/clone] insert error', copyErr?.message)
    return NextResponse.json({ error: 'clone_failed', detail: copyErr?.message }, { status: 500 })
  }

  // Insert step copies
  if (masterSteps && masterSteps.length > 0) {
    const stepRows = masterSteps.map(s => ({
      drip_path_id: copy.id,
      step_order: s.step_order,
      delay_days: s.delay_days,
      channel: s.channel,
      subject: s.subject,
      body: s.body,
      master_template_id: s.master_template_id,
      is_active: s.is_active,
    }))
    const { error: insErr } = await supabaseService.from('drip_path_steps').insert(stepRows)
    if (insErr) {
      console.error('[/api/locations/[id]/drip-paths/clone] step insert error', insErr.message)
      // Don't roll back the path — surface warning so caller knows partial state.
      return NextResponse.json({ path: copy, warning: `steps_insert_failed: ${insErr.message}` }, { status: 201 })
    }
  }

  return NextResponse.json({ path: copy }, { status: 201 })
}
