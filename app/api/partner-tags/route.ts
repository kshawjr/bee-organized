// app/api/partner-tags/route.ts
//
// GET    /api/partner-tags?partner_id=... — the partner's tags, labels resolved
// POST   /api/partner-tags — add a tag to a partner
// DELETE /api/partner-tags?partner_id=...&tag_lookup_id=... — remove one
//
// Tag system step 2B — the partner mirror of /api/lead-tags. Tags are a
// junction table (partner_tags, composite PK partner_id + tag_lookup_id;
// RLS enabled with no policies — service-role only, like lead_tags).
// Definitions live in `lookups` category='partner_tags', corporate
// (location_id null) or location-owned. This route only manages the LINK
// — it never creates/deletes definitions, and it NEVER touches the dead
// partners.tags text[] column.
//
// Auth: must be a logged-in hub_user.
// Scope: super_admin/admin any partner; owner/manager only their own
//        location's. lite_user may GET (read-only role reads the record)
//        but never write.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { readOnlyWriteBlock } from '@/lib/read-only-access'

async function authorize({ write }: { write: boolean }) {
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

  if (write && hubUser.role === 'lite_user') {
    return { error: NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 }) }
  }

  return { hubUser }
}

async function checkLocationAccess(
  hubUser: { role: string; location_id: string | null },
  partner_id: string,
  { write }: { write: boolean }
) {
  const { data: partner, error: partnerError } = await supabaseService
    .from('partners')
    .select('id, location_id')
    .eq('id', partner_id)
    .single()

  if (partnerError || !partner) {
    return { error: NextResponse.json({ error: 'partner_not_found' }, { status: 404 }) }
  }

  if (!isAdmin(hubUser.role)) {
    if (hubUser.location_id !== partner.location_id) {
      return {
        error: NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 }),
      }
    }
  }

  if (write) {
    // Read-only guard — paused/inactive location (lite_user already
    // blocked in authorize()). Same rule as lead-tags.
    const roBlock = await readOnlyWriteBlock(hubUser, partner.location_id)
    if (roBlock) return { error: roBlock }
  }

  return { partner }
}

// ─── GET — the partner's tags, labels resolved ───────────────────
// The person record has no profile payload route to ride (lead tags ride
// /api/clients/[id]/profile), so this route serves the read too.
export async function GET(req: Request) {
  const auth = await authorize({ write: false })
  if (auth.error) return auth.error

  const url = new URL(req.url)
  const partner_id = url.searchParams.get('partner_id')
  if (!partner_id) {
    return NextResponse.json({ error: 'partner_id_required' }, { status: 400 })
  }

  const locCheck = await checkLocationAccess(auth.hubUser, partner_id, { write: false })
  if (locCheck.error) return locCheck.error

  const { data: junction, error: junctionError } = await supabaseService
    .from('partner_tags')
    .select('tag_lookup_id, added_at')
    .eq('partner_id', partner_id)
    .order('added_at', { ascending: true })

  if (junctionError) {
    return NextResponse.json({ error: 'read_failed', detail: junctionError.message }, { status: 500 })
  }

  const ids = (junction || []).map(r => r.tag_lookup_id)
  let tags: { id: string; label: string }[] = []
  if (ids.length > 0) {
    const { data: defs } = await supabaseService
      .from('lookups')
      .select('id, label')
      .in('id', ids)
    tags = (junction || [])
      .map(r => (defs || []).find(d => d.id === r.tag_lookup_id))
      .filter(Boolean)
      .map((d: any) => ({ id: d.id, label: d.label }))
  }

  return NextResponse.json({ tags })
}

// ─── POST — add a tag to a partner ───────────────────────────────
export async function POST(req: Request) {
  const auth = await authorize({ write: true })
  if (auth.error) return auth.error

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const partner_id = body.partner_id as string | undefined
  const tag_lookup_id = body.tag_lookup_id as string | undefined

  if (!partner_id || typeof partner_id !== 'string') {
    return NextResponse.json({ error: 'partner_id_required' }, { status: 400 })
  }
  if (!tag_lookup_id || typeof tag_lookup_id !== 'string') {
    return NextResponse.json({ error: 'tag_lookup_id_required' }, { status: 400 })
  }

  const locCheck = await checkLocationAccess(auth.hubUser, partner_id, { write: true })
  if (locCheck.error) return locCheck.error

  // Verify the tag_lookup_id points to a valid partner_tags lookup
  const { data: tagDef, error: tagDefError } = await supabaseService
    .from('lookups')
    .select('id, category, location_id')
    .eq('id', tag_lookup_id)
    .single()

  if (tagDefError || !tagDef) {
    return NextResponse.json({ error: 'tag_lookup_not_found' }, { status: 404 })
  }
  if (tagDef.category !== 'partner_tags') {
    return NextResponse.json(
      { error: 'tag_lookup_wrong_category', got: tagDef.category, expected: 'partner_tags' },
      { status: 400 }
    )
  }
  // Location scope: corporate (location_id null) or the PARTNER's own
  // location — a different location's tag can never be applied here,
  // whoever the caller is. Same shape as lead-tags.
  if (tagDef.location_id && tagDef.location_id !== locCheck.partner.location_id) {
    return NextResponse.json({ error: 'tag_lookup_wrong_location' }, { status: 403 })
  }

  // Insert junction row. ON CONFLICT DO NOTHING so re-adding is idempotent.
  const { data: inserted, error: insertError } = await supabaseService
    .from('partner_tags')
    .upsert(
      {
        partner_id,
        tag_lookup_id,
        added_by: auth.hubUser.id,
      },
      { onConflict: 'partner_id,tag_lookup_id', ignoreDuplicates: true }
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
      .from('partner_tags')
      .select('*')
      .eq('partner_id', partner_id)
      .eq('tag_lookup_id', tag_lookup_id)
      .single()
    return NextResponse.json({ partner_tag: existing, already_existed: true }, { status: 200 })
  }

  return NextResponse.json({ partner_tag: inserted }, { status: 201 })
}

// ─── DELETE — remove a tag from a partner ────────────────────────
// DELETE /api/partner-tags?partner_id=...&tag_lookup_id=...
export async function DELETE(req: Request) {
  const auth = await authorize({ write: true })
  if (auth.error) return auth.error

  const url = new URL(req.url)
  const partner_id = url.searchParams.get('partner_id')
  const tag_lookup_id = url.searchParams.get('tag_lookup_id')

  if (!partner_id) {
    return NextResponse.json({ error: 'partner_id_required' }, { status: 400 })
  }
  if (!tag_lookup_id) {
    return NextResponse.json({ error: 'tag_lookup_id_required' }, { status: 400 })
  }

  const locCheck = await checkLocationAccess(auth.hubUser, partner_id, { write: true })
  if (locCheck.error) return locCheck.error

  const { error: deleteError } = await supabaseService
    .from('partner_tags')
    .delete()
    .eq('partner_id', partner_id)
    .eq('tag_lookup_id', tag_lookup_id)

  if (deleteError) {
    return NextResponse.json(
      { error: 'delete_failed', detail: deleteError.message },
      { status: 500 }
    )
  }

  return NextResponse.json({ deleted: true, partner_id, tag_lookup_id }, { status: 200 })
}
