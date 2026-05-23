// app/api/templates/route.ts
//
// GET  /api/templates  — list templates visible to the caller:
//   - super_admin / admin: all rows (every master + every location's customs)
//   - owner:               masters (location_uuid IS NULL) + own location's customs
//   - lite_user:           same as owner read scope
//
// POST /api/templates  — create a template:
//   - super_admin / admin: location_uuid optional (NULL → master, set → that location's custom)
//   - owner:               location_uuid forced to caller's own location_id
//
// Response rows include `is_master` and `is_own_custom` convenience flags so
// the UI can render the master vs. my-templates split without inspecting
// location_uuid itself.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

const VALID_TYPES = new Set(['email', 'sms', 'call'])
const SELECT_COLS =
  'id, legacy_id, name, type, tag, subject, body, is_active, location_uuid, cloned_from_id, created_by, created_at, updated_at'

function decorate(row: any, ownLocId: string | null) {
  const isMaster = row.location_uuid == null
  return {
    ...row,
    is_master: isMaster,
    is_own_custom: !isMaster && ownLocId != null && row.location_uuid === ownLocId,
  }
}

export async function GET() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })

  let query = supabaseService
    .from('templates')
    .select(SELECT_COLS)
    .order('type', { ascending: true })
    .order('location_uuid', { ascending: true, nullsFirst: true })
    .order('name', { ascending: true })

  if (!isAdmin(hubUser.role)) {
    // Owners/lite see masters + own location's customs only. Postgrest .or()
    // takes a comma-separated list of conditions to OR together.
    if (hubUser.location_id) {
      query = query.or(`location_uuid.is.null,location_uuid.eq.${hubUser.location_id}`)
    } else {
      query = query.is('location_uuid', null)
    }
  }

  const { data, error } = await query

  if (error) {
    console.error('[/api/templates GET] error:', error.message)
    return NextResponse.json({ error: 'list_failed' }, { status: 500 })
  }

  return NextResponse.json({
    templates: (data ?? []).map(r => decorate(r, hubUser.location_id ?? null)),
  })
}

export async function POST(req: NextRequest) {
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

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const type = typeof body.type === 'string' ? body.type.trim() : ''
  const tag = typeof body.tag === 'string' ? body.tag.trim() || null : null
  const subject = typeof body.subject === 'string' ? body.subject : null
  const tplBody = typeof body.body === 'string' ? body.body : ''

  if (!name) return NextResponse.json({ error: 'name_required' }, { status: 400 })
  if (!VALID_TYPES.has(type)) {
    return NextResponse.json({ error: 'invalid_type', allowed: Array.from(VALID_TYPES) }, { status: 400 })
  }
  if (!tplBody.trim()) return NextResponse.json({ error: 'body_required' }, { status: 400 })

  // Owners can only create customs scoped to their own location. Admins
  // can pass an explicit location_uuid (null for master, uuid for a
  // specific location's custom).
  let location_uuid: string | null = null
  if (isAdmin(hubUser.role)) {
    if (body.location_uuid === null) {
      location_uuid = null
    } else if (typeof body.location_uuid === 'string' && body.location_uuid) {
      location_uuid = body.location_uuid
    }
  } else {
    if (!hubUser.location_id) {
      return NextResponse.json({ error: 'owner_has_no_location' }, { status: 400 })
    }
    location_uuid = hubUser.location_id
  }

  const { data, error } = await supabaseService
    .from('templates')
    .insert({
      name,
      type,
      tag,
      subject: type === 'email' ? subject : null,
      body: tplBody,
      is_active: true,
      location_uuid,
      created_by: hubUser.id,
    })
    .select(SELECT_COLS)
    .single()

  if (error) {
    console.error('[/api/templates POST] error:', error.message)
    return NextResponse.json({ error: 'create_failed', detail: error.message }, { status: 500 })
  }

  return NextResponse.json(
    { template: decorate(data, hubUser.location_id ?? null) },
    { status: 201 },
  )
}
