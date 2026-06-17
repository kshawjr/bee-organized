// app/api/feedback/route.ts
//
// User-facing feedback / bug-report endpoints. Any authenticated hub_user can
// file an item and list their own items. Admin triage lives at
// /api/admin/feedback (separate route, fail-closed to super_admin/admin).
//
//   GET  /api/feedback — list the caller's own feedback_items, newest first.
//   POST /api/feedback — file a new bug report or feature request.
//
// Writes go through supabaseService (service role) so the insert isn't gated by
// RLS; reads are scoped to the session user_id in the query itself.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

const VALID_TYPES = new Set(['bug', 'feature'])

// GET — caller's own items, newest first.
export async function GET() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data, error } = await supabaseService
    .from('feedback_items')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[feedback GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ items: data || [] })
}

// POST — file a new item. status defaults to 'submitted'.
export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // location_id is carried from the caller's hub_user record so admin triage
  // can group feedback by franchise without the client having to send it.
  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })

  let body: { type?: string; title?: string; description?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const type = String(body.type || '').trim()
  if (!VALID_TYPES.has(type)) {
    return NextResponse.json({ error: 'type_must_be_bug_or_feature' }, { status: 400 })
  }

  const title = String(body.title || '').trim()
  if (title.length < 1 || title.length > 100) {
    return NextResponse.json({ error: 'title_must_be_1_100_chars' }, { status: 400 })
  }

  const description = String(body.description || '').trim()
  if (description.length < 1 || description.length > 2000) {
    return NextResponse.json({ error: 'description_must_be_1_2000_chars' }, { status: 400 })
  }

  const { data: row, error } = await supabaseService
    .from('feedback_items')
    .insert({
      user_id: user.id,
      location_id: hubUser.location_id || null,
      type,
      title,
      description,
      status: 'submitted',
    })
    .select('*')
    .single()

  if (error || !row) {
    console.error('[feedback POST]', error)
    return NextResponse.json({ error: error?.message || 'insert_failed' }, { status: 500 })
  }

  return NextResponse.json(row, { status: 201 })
}
