// app/api/templates/[id]/route.ts
//
// GET    /api/templates/:id  — fetch single master template (any logged-in)
// PATCH  /api/templates/:id  — edit (super_admin only)
// DELETE /api/templates/:id  — delete (super_admin only)
//
// :id accepts either the master_templates.id uuid or the legacy_id text
// ('t1', 'ta2', etc.) so the UI can keep its existing string IDs in
// in-memory state.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isSuperAdmin } from '@/lib/auth'

const VALID_TYPES = new Set(['email', 'sms', 'call'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function matchColumn(id: string) {
  return UUID_RE.test(id) ? 'id' : 'legacy_id'
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })

  const { data, error } = await supabaseService
    .from('master_templates')
    .select('id, legacy_id, name, type, tag, subject, body, is_active, created_at, updated_at')
    .eq(matchColumn(params.id), params.id)
    .maybeSingle()

  if (error) {
    console.error('[/api/templates/[id] GET] error:', error.message)
    return NextResponse.json({ error: 'fetch_failed' }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  return NextResponse.json({ template: data })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  if (!isSuperAdmin(hubUser.role)) {
    return NextResponse.json({ error: 'forbidden_super_admin_only' }, { status: 403 })
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
    .from('master_templates')
    .update(patch)
    .eq(matchColumn(params.id), params.id)
    .select('id, legacy_id, name, type, tag, subject, body, is_active, created_at, updated_at')
    .maybeSingle()

  if (error) {
    console.error('[/api/templates/[id] PATCH] error:', error.message)
    return NextResponse.json({ error: 'update_failed', detail: error.message }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  return NextResponse.json({ template: data })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  if (!isSuperAdmin(hubUser.role)) {
    return NextResponse.json({ error: 'forbidden_super_admin_only' }, { status: 403 })
  }

  const { error } = await supabaseService
    .from('master_templates')
    .delete()
    .eq(matchColumn(params.id), params.id)

  if (error) {
    console.error('[/api/templates/[id] DELETE] error:', error.message)
    return NextResponse.json({ error: 'delete_failed', detail: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
