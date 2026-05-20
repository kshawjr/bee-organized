// app/api/lead-tags/route.ts
//
// POST   /api/lead-tags — add a tag to a lead
// DELETE /api/lead-tags?lead_id=...&tag_lookup_id=... — remove a tag from a lead
//
// Tags are managed as a junction table (lead_tags) with composite PK
// (lead_id, tag_lookup_id). Tag definitions live in `lookups` rows where
// category='client_tags' — those are admin-managed and global. This route
// only manages the LINK between leads and existing tags. It never creates
// or deletes tag definitions themselves.
//
// Auth: must be a logged-in hub_user.
// Scope: super_admin/admin can write to any lead. owner can only write
//        to leads in their location. lite_user blocked.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

async function authorize() {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()

  if (!hubUser) {
    return { error: NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 }) }
  }

  if (hubUser.role === 'lite_user') {
    return { error: NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 }) }
  }

  return { hubUser }
}

async function checkLocationAccess(
  hubUser: { role: string; location_id: string | null },
  lead_id: string
) {
  const { data: lead, error: leadError } = await supabaseService
    .from('leads')
    .select('id, location_uuid')
    .eq('id', lead_id)
    .single()

  if (leadError || !lead) {
    return { error: NextResponse.json({ error: 'lead_not_found' }, { status: 404 }) }
  }

  if (!isAdmin(hubUser.role)) {
    if (hubUser.location_id !== lead.location_uuid) {
      return {
        error: NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 }),
      }
    }
  }

  return { lead }
}

// ─── POST — add a tag to a lead ──────────────────────────────────
export async function POST(req: Request) {
  const auth = await authorize()
  if (auth.error) return auth.error

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const lead_id = body.lead_id as string | undefined
  const tag_lookup_id = body.tag_lookup_id as string | undefined

  if (!lead_id || typeof lead_id !== 'string') {
    return NextResponse.json({ error: 'lead_id_required' }, { status: 400 })
  }
  if (!tag_lookup_id || typeof tag_lookup_id !== 'string') {
    return NextResponse.json({ error: 'tag_lookup_id_required' }, { status: 400 })
  }

  const locCheck = await checkLocationAccess(auth.hubUser, lead_id)
  if (locCheck.error) return locCheck.error

  // Verify the tag_lookup_id points to a valid client_tags lookup
  const { data: tagDef, error: tagDefError } = await supabaseService
    .from('lookups')
    .select('id, category')
    .eq('id', tag_lookup_id)
    .single()

  if (tagDefError || !tagDef) {
    return NextResponse.json({ error: 'tag_lookup_not_found' }, { status: 404 })
  }
  if (tagDef.category !== 'client_tags') {
    return NextResponse.json(
      { error: 'tag_lookup_wrong_category', got: tagDef.category, expected: 'client_tags' },
      { status: 400 }
    )
  }

  // Insert junction row. ON CONFLICT DO NOTHING so re-adding is idempotent.
  const { data: inserted, error: insertError } = await supabaseService
    .from('lead_tags')
    .upsert(
      {
        lead_id,
        tag_lookup_id,
        added_by: auth.hubUser.id,
      },
      { onConflict: 'lead_id,tag_lookup_id', ignoreDuplicates: true }
    )
    .select('*')
    .maybeSingle()

  if (insertError) {
    return NextResponse.json(
      { error: 'insert_failed', detail: insertError.message },
      { status: 500 }
    )
  }

  // inserted is null when the row already existed (idempotent — fetch it explicitly so caller gets the data)
  if (!inserted) {
    const { data: existing } = await supabaseService
      .from('lead_tags')
      .select('*')
      .eq('lead_id', lead_id)
      .eq('tag_lookup_id', tag_lookup_id)
      .single()
    return NextResponse.json({ lead_tag: existing, already_existed: true }, { status: 200 })
  }

  return NextResponse.json({ lead_tag: inserted }, { status: 201 })
}

// ─── DELETE — remove a tag from a lead ───────────────────────────
// DELETE /api/lead-tags?lead_id=...&tag_lookup_id=...
export async function DELETE(req: Request) {
  const auth = await authorize()
  if (auth.error) return auth.error

  const url = new URL(req.url)
  const lead_id = url.searchParams.get('lead_id')
  const tag_lookup_id = url.searchParams.get('tag_lookup_id')

  if (!lead_id) {
    return NextResponse.json({ error: 'lead_id_required' }, { status: 400 })
  }
  if (!tag_lookup_id) {
    return NextResponse.json({ error: 'tag_lookup_id_required' }, { status: 400 })
  }

  const locCheck = await checkLocationAccess(auth.hubUser, lead_id)
  if (locCheck.error) return locCheck.error

  const { error: deleteError } = await supabaseService
    .from('lead_tags')
    .delete()
    .eq('lead_id', lead_id)
    .eq('tag_lookup_id', tag_lookup_id)

  if (deleteError) {
    return NextResponse.json(
      { error: 'delete_failed', detail: deleteError.message },
      { status: 500 }
    )
  }

  return NextResponse.json({ deleted: true, lead_id, tag_lookup_id }, { status: 200 })
}