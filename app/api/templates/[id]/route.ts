// app/api/templates/[id]/route.ts
//
// GET    /api/templates/:id  — fetch single template the caller can see
// PATCH  /api/templates/:id  — edit (super_admin/admin any; owner only own customs)
// DELETE /api/templates/:id  — delete (same rules as PATCH)
//
// :id accepts either the templates.id uuid or the legacy_id text
// ('t1', 'ta2', …) — legacy_ids only exist on masters; customs are
// uuid-only.
//
// Owners cannot edit or delete a master (location_uuid IS NULL) — 403.
// drip_path_steps.master_template_id is ON DELETE SET NULL so deleting
// a template leaves its referencing steps in place with no linked
// template (cron falls back to inline subject/body or skips).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

const VALID_TYPES = new Set(['email', 'sms', 'call'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SELECT_COLS =
  'id, legacy_id, name, type, tag, subject, body, is_active, location_uuid, cloned_from_id, created_by, created_at, updated_at'

function matchColumn(id: string) {
  return UUID_RE.test(id) ? 'id' : 'legacy_id'
}

function decorate(row: any, ownLocId: string | null) {
  const isMaster = row.location_uuid == null
  return {
    ...row,
    is_master: isMaster,
    is_own_custom: !isMaster && ownLocId != null && row.location_uuid === ownLocId,
  }
}

async function loadCallerAndTemplate(id: string) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'unauthorized', status: 401 as const }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return { error: 'no_hub_user_profile', status: 403 as const }

  const { data: tpl, error } = await supabaseService
    .from('templates')
    .select(SELECT_COLS)
    .eq(matchColumn(id), id)
    .maybeSingle()

  if (error) return { error: 'fetch_failed', status: 500 as const }
  if (!tpl) return { error: 'not_found', status: 404 as const }

  return { hubUser, tpl }
}

function ownerCanRead(hubUser: { role: string; location_id: string | null }, tpl: any) {
  if (isAdmin(hubUser.role)) return true
  // Masters are readable by anyone logged in. Customs only by their own location.
  if (tpl.location_uuid == null) return true
  return hubUser.location_id != null && tpl.location_uuid === hubUser.location_id
}

function ownerCanWrite(hubUser: { role: string; location_id: string | null }, tpl: any) {
  if (isAdmin(hubUser.role)) return true
  // lite_user (read-only) and manager (operational lead; no template config)
  // cannot write templates. Both can still read via ownerCanRead.
  if (hubUser.role === 'lite_user' || hubUser.role === 'manager') return false
  // Owners can only modify customs in their own location. Masters are off-limits.
  return tpl.location_uuid != null
    && hubUser.location_id != null
    && tpl.location_uuid === hubUser.location_id
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const result = await loadCallerAndTemplate(params.id)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  const { hubUser, tpl } = result

  if (!ownerCanRead(hubUser, tpl)) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  return NextResponse.json({ template: decorate(tpl, hubUser.location_id ?? null) })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const result = await loadCallerAndTemplate(params.id)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  const { hubUser, tpl } = result

  if (!ownerCanWrite(hubUser, tpl)) {
    return NextResponse.json({ error: 'forbidden_cannot_edit_master' }, { status: 403 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if (typeof body.name === 'string') patch.name = body.name.trim()
  if (typeof body.type === 'string') {
    if (!VALID_TYPES.has(body.type)) {
      return NextResponse.json({ error: 'invalid_type', allowed: Array.from(VALID_TYPES) }, { status: 400 })
    }
    patch.type = body.type
  }
  if ('tag' in body) {
    patch.tag = typeof body.tag === 'string' ? (body.tag.trim() || null) : null
  }
  if ('subject' in body) {
    patch.subject = typeof body.subject === 'string' ? body.subject : null
  }
  if (typeof body.body === 'string') patch.body = body.body
  if (typeof body.is_active === 'boolean') patch.is_active = body.is_active

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no_fields' }, { status: 400 })
  }

  const { data, error } = await supabaseService
    .from('templates')
    .update(patch)
    .eq('id', tpl.id)
    .select(SELECT_COLS)
    .maybeSingle()

  if (error) {
    console.error('[/api/templates/[id] PATCH] error:', error.message)
    return NextResponse.json({ error: 'update_failed', detail: error.message }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  return NextResponse.json({ template: decorate(data, hubUser.location_id ?? null) })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const result = await loadCallerAndTemplate(params.id)
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
  const { hubUser, tpl } = result

  if (!ownerCanWrite(hubUser, tpl)) {
    return NextResponse.json({ error: 'forbidden_cannot_delete_master' }, { status: 403 })
  }

  // In-use guard: drip_path_steps.master_template_id is ON DELETE SET NULL,
  // so deleting a referenced template would silently strand those steps with
  // no content source. Refuse instead; the caller re-points the steps first.
  const { count: refCount, error: refErr } = await supabaseService
    .from('drip_path_steps')
    .select('id', { count: 'exact', head: true })
    .eq('master_template_id', tpl.id)

  if (refErr) {
    console.error('[/api/templates/[id] DELETE] ref check error:', refErr.message)
    return NextResponse.json({ error: 'ref_check_failed', detail: refErr.message }, { status: 500 })
  }
  if ((refCount ?? 0) > 0) {
    return NextResponse.json({
      error: 'template_in_use',
      detail: `This template is used by ${refCount} email step${refCount === 1 ? '' : 's'} in your new lead emails. Point ${refCount === 1 ? 'that step' : 'those steps'} at a different template first, then delete it.`,
      steps_referencing: refCount,
    }, { status: 409 })
  }

  const { error } = await supabaseService
    .from('templates')
    .delete()
    .eq('id', tpl.id)

  if (error) {
    console.error('[/api/templates/[id] DELETE] error:', error.message)
    return NextResponse.json({ error: 'delete_failed', detail: error.message }, { status: 500 })
  }

  // Suppress unused-var lint warning while keeping hubUser in scope for future audit.
  void hubUser
  return NextResponse.json({ ok: true })
}
