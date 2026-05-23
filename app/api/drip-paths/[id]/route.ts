// app/api/drip-paths/[id]/route.ts
//
// GET    /api/drip-paths/:id  — fetch a single path + its steps
// PATCH  /api/drip-paths/:id  — rename / toggle active / toggle default
// DELETE /api/drip-paths/:id  — delete a path (cascade-removes steps)
//
// Auth: super_admin can hit any path; franchise owners only paths in their
// own location.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

async function loadPathWithAuth(pathId: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'unauthorized', status: 401 as const }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return { error: 'no_hub_user_profile', status: 403 as const }

  const { data: path } = await supabaseService
    .from('drip_paths')
    .select('id, location_uuid, path_key, name, is_active, is_default')
    .eq('id', pathId)
    .maybeSingle()
  if (!path) return { error: 'not_found', status: 404 as const }

  if (hubUser.role === 'lite_user') return { error: 'forbidden_read_only', status: 403 as const }
  if (!isAdmin(hubUser.role) && hubUser.location_id !== path.location_uuid) {
    return { error: 'forbidden_wrong_location', status: 403 as const }
  }

  return { hubUser, path }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const result = await loadPathWithAuth(params.id)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })

  const { data: steps, error } = await supabaseService
    .from('drip_path_steps')
    .select('id, step_order, delay_days, channel, subject, body, master_template_id, is_active, master_templates(name, legacy_id)')
    .eq('drip_path_id', params.id)
    .order('step_order', { ascending: true })

  if (error) {
    console.error('[/api/drip-paths/[id] GET] steps error:', error.message)
    return NextResponse.json({ error: 'steps_query_failed' }, { status: 500 })
  }

  return NextResponse.json({
    path: result.path,
    steps: (steps ?? []).map(s => {
      const tpl = Array.isArray((s as any).master_templates)
        ? (s as any).master_templates[0]
        : (s as any).master_templates
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
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const result = await loadPathWithAuth(params.id)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if (typeof body.name === 'string') patch.name = body.name.trim()
  if (typeof body.path_key === 'string') patch.path_key = body.path_key.trim()
  if (typeof body.is_active === 'boolean') patch.is_active = body.is_active
  if (typeof body.is_default === 'boolean') patch.is_default = body.is_default

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no_fields' }, { status: 400 })
  }

  const { data, error } = await supabaseService
    .from('drip_paths')
    .update(patch)
    .eq('id', params.id)
    .select('id, location_uuid, path_key, name, is_active, is_default')
    .single()

  if (error) {
    console.error('[/api/drip-paths/[id] PATCH] error:', error.message)
    return NextResponse.json({ error: 'update_failed', detail: error.message }, { status: 500 })
  }

  return NextResponse.json({ path: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const result = await loadPathWithAuth(params.id)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })

  const { error } = await supabaseService
    .from('drip_paths')
    .delete()
    .eq('id', params.id)

  if (error) {
    console.error('[/api/drip-paths/[id] DELETE] error:', error.message)
    return NextResponse.json({ error: 'delete_failed', detail: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
