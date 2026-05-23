// app/api/locations/[id]/drip-paths/route.ts
//
// GET   /api/locations/:id/drip-paths
//   Returns the location's drip_paths with their steps + linked master
//   template names. Used by Settings → Paths editor.
//
// POST  /api/locations/:id/drip-paths
//   Body: { path_key, name, steps?: [{ step_order, delay_days, channel,
//          master_template_id, subject?, body? }] }
//   Creates a new path (optionally with seed steps).
//
// PATCH /api/locations/:id/drip-paths
//   Body: { default?: path_key, default_move?: path_key }
//   Updates locations.default_drip_path / .default_move_drip_path.
//
// Auth: super_admin can hit any location; franchise owners (and admins acting
// at the org level) can only touch their own location.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

async function authForLocation(locId: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'unauthorized', status: 401 as const }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return { error: 'no_hub_user_profile', status: 403 as const }

  if (hubUser.role === 'lite_user') return { error: 'forbidden_read_only', status: 403 as const }
  if (!isAdmin(hubUser.role) && hubUser.location_id !== locId) {
    return { error: 'forbidden_wrong_location', status: 403 as const }
  }
  return { hubUser }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const locId = params.id

  // Read access: any hub_user from this location, plus admin/super_admin.
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  if (!isAdmin(hubUser.role) && hubUser.location_id !== locId) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  const [pathsRes, stepsRes, locRes] = await Promise.all([
    supabaseService
      .from('drip_paths')
      .select('id, location_uuid, path_key, name, is_active, is_default, created_at, updated_at')
      .eq('location_uuid', locId)
      .order('is_default', { ascending: false })
      .order('name', { ascending: true }),
    supabaseService
      .from('drip_path_steps')
      .select('id, drip_path_id, step_order, delay_days, channel, subject, body, master_template_id, is_active, templates:master_template_id(name, legacy_id, subject, body)')
      .order('step_order', { ascending: true }),
    supabaseService
      .from('locations')
      .select('id, default_drip_path, default_move_drip_path')
      .eq('id', locId)
      .maybeSingle(),
  ])

  if (pathsRes.error) {
    console.error('[/api/locations/[id]/drip-paths GET] paths error:', pathsRes.error.message)
    return NextResponse.json({ error: 'paths_query_failed' }, { status: 500 })
  }
  if (stepsRes.error) {
    console.error('[/api/locations/[id]/drip-paths GET] steps error:', stepsRes.error.message)
    return NextResponse.json({ error: 'steps_query_failed' }, { status: 500 })
  }

  const paths = pathsRes.data ?? []
  const allSteps = stepsRes.data ?? []
  const pathIds = new Set(paths.map(p => p.id))

  const enrichedPaths = paths.map(p => ({
    ...p,
    steps: allSteps
      .filter(s => s.drip_path_id === p.id && pathIds.has(s.drip_path_id))
      .map(s => {
        const tpl = Array.isArray((s as any).templates)
          ? (s as any).templates[0]
          : (s as any).templates
        return {
          id: s.id,
          step_order: s.step_order,
          delay_days: s.delay_days,
          channel: s.channel,
          subject: s.subject,
          body: s.body,
          master_template_id: s.master_template_id,
          template_name: tpl?.name ?? null,
          template_legacy_id: tpl?.legacy_id ?? null,
          is_active: s.is_active,
        }
      }),
  }))

  return NextResponse.json({
    paths: enrichedPaths,
    default_drip_path: locRes.data?.default_drip_path ?? null,
    default_move_drip_path: locRes.data?.default_move_drip_path ?? null,
  })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const locId = params.id
  const auth = await authForLocation(locId)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const path_key = typeof body.path_key === 'string' ? body.path_key.trim() : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!path_key) return NextResponse.json({ error: 'path_key_required' }, { status: 400 })
  if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 })

  const { data: pathRow, error: pathErr } = await supabaseService
    .from('drip_paths')
    .insert({
      location_uuid: locId,
      path_key,
      name,
      is_active: true,
      is_default: false,
    })
    .select('id, location_uuid, path_key, name, is_active, is_default')
    .single()

  if (pathErr || !pathRow) {
    console.error('[/api/locations/[id]/drip-paths POST] path insert error:', pathErr?.message)
    return NextResponse.json({ error: 'create_failed', detail: pathErr?.message }, { status: 500 })
  }

  // Optional seed steps
  if (Array.isArray(body.steps) && body.steps.length > 0) {
    const stepRows = (body.steps as Array<Record<string, unknown>>).map((s, i) => ({
      drip_path_id: pathRow.id,
      step_order: typeof s.step_order === 'number' ? s.step_order : i + 1,
      delay_days: typeof s.delay_days === 'number' ? s.delay_days : 0,
      channel: typeof s.channel === 'string' && (s.channel === 'sms' || s.channel === 'email') ? s.channel : 'email',
      master_template_id: typeof s.master_template_id === 'string' ? s.master_template_id : null,
      subject: typeof s.subject === 'string' ? s.subject : null,
      body: typeof s.body === 'string' ? s.body : null,
      is_active: true,
    }))
    const { error: stepsErr } = await supabaseService.from('drip_path_steps').insert(stepRows)
    if (stepsErr) {
      console.error('[/api/locations/[id]/drip-paths POST] steps insert error:', stepsErr.message)
      // Path was created — don't roll back, surface the warning so caller knows.
      return NextResponse.json({ path: pathRow, warning: `steps_insert_failed: ${stepsErr.message}` }, { status: 201 })
    }
  }

  return NextResponse.json({ path: pathRow }, { status: 201 })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const locId = params.id
  const auth = await authForLocation(locId)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof body.default === 'string' && body.default.trim()) {
    patch.default_drip_path = body.default.trim()
  }
  if (typeof body.default_move === 'string' && body.default_move.trim()) {
    patch.default_move_drip_path = body.default_move.trim()
  }
  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ error: 'no_fields' }, { status: 400 })
  }

  const { data, error } = await supabaseService
    .from('locations')
    .update(patch)
    .eq('id', locId)
    .select('id, default_drip_path, default_move_drip_path')
    .single()

  if (error) {
    console.error('[/api/locations/[id]/drip-paths PATCH] error:', error.message)
    return NextResponse.json({ error: 'update_failed', detail: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, location: data })
}
