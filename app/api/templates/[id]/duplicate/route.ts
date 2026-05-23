// app/api/templates/[id]/duplicate/route.ts
//
// POST /api/templates/:id/duplicate — copy a master template into the
// caller's own location as an independent custom.
//
// Rules:
//   - Source must be a master (location_uuid IS NULL). Owners can't duplicate
//     a custom — customs are already independent; just edit in place. Admins
//     get the same restriction here (use POST /api/templates with a body
//     copy if you really want a cross-location clone).
//   - Owners get a custom in their own location.
//   - Admins must supply location_uuid in the body (defaults to caller's
//     location_id if they have one).
//
// :id accepts either templates.id uuid or legacy_id text.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

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

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
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

  // Optional body for admin overrides; owners ignore it entirely.
  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    // empty body is fine
  }

  const { data: src, error: srcErr } = await supabaseService
    .from('templates')
    .select(SELECT_COLS)
    .eq(matchColumn(params.id), params.id)
    .maybeSingle()

  if (srcErr) {
    console.error('[/api/templates/[id]/duplicate POST] src error:', srcErr.message)
    return NextResponse.json({ error: 'fetch_failed' }, { status: 500 })
  }
  if (!src) return NextResponse.json({ error: 'source_not_found' }, { status: 404 })

  if (src.location_uuid != null) {
    return NextResponse.json({ error: 'source_not_a_master' }, { status: 400 })
  }

  // Determine target location for the new custom.
  let targetLocation: string | null = null
  if (isAdmin(hubUser.role)) {
    if (typeof body.location_uuid === 'string' && body.location_uuid) {
      targetLocation = body.location_uuid
    } else if (hubUser.location_id) {
      targetLocation = hubUser.location_id
    }
  } else {
    targetLocation = hubUser.location_id
  }

  if (!targetLocation) {
    return NextResponse.json({ error: 'no_target_location' }, { status: 400 })
  }

  const copyName = `${src.name} (Copy)`

  const { data: copy, error: copyErr } = await supabaseService
    .from('templates')
    .insert({
      // legacy_id deliberately NULL — only masters carry the t1/ta2 ids,
      // and the column has a UNIQUE constraint that doesn't allow reuse.
      name: copyName,
      type: src.type,
      tag: src.tag,
      subject: src.subject,
      body: src.body,
      is_active: true,
      location_uuid: targetLocation,
      cloned_from_id: src.id,
      created_by: hubUser.id,
    })
    .select(SELECT_COLS)
    .single()

  if (copyErr) {
    console.error('[/api/templates/[id]/duplicate POST] insert error:', copyErr.message)
    return NextResponse.json({ error: 'create_failed', detail: copyErr.message }, { status: 500 })
  }

  return NextResponse.json(
    { template: decorate(copy, hubUser.location_id ?? null) },
    { status: 201 },
  )
}
