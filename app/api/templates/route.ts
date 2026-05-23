// app/api/templates/route.ts
//
// GET  /api/templates       — list all master_templates (any logged-in hub_user)
// POST /api/templates       — create a master template (super_admin only)
//
// The UI in components/BeeHub.jsx (Settings → Templates) reads these to
// replace the in-memory DEFAULT_TEMPLATES constant. Franchise owners get
// read-only access here; location-level overrides are a separate feature
// (deferred — see Session 3 doc).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isSuperAdmin } from '@/lib/auth'

const VALID_TYPES = new Set(['email', 'sms', 'call'])

export async function GET() {
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
    .order('type', { ascending: true })
    .order('name', { ascending: true })

  if (error) {
    console.error('[/api/templates GET] error:', error.message)
    return NextResponse.json({ error: 'list_failed' }, { status: 500 })
  }

  return NextResponse.json({ templates: data ?? [] })
}

export async function POST(req: NextRequest) {
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

  const { data, error } = await supabaseService
    .from('master_templates')
    .insert({
      name,
      type,
      tag,
      subject: type === 'email' ? subject : null,
      body: tplBody,
      is_active: true,
    })
    .select('id, legacy_id, name, type, tag, subject, body, is_active, created_at, updated_at')
    .single()

  if (error) {
    console.error('[/api/templates POST] error:', error.message)
    return NextResponse.json({ error: 'create_failed', detail: error.message }, { status: 500 })
  }

  return NextResponse.json({ template: data }, { status: 201 })
}
