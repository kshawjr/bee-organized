// app/api/admin/location-zips/route.ts
//
// The zip list that routes global-form leads (migrations/location_zips.sql,
// lib/zip-routing.ts). Corporate owns it here, so a conflict or a new
// territory is an edit, not a migration.
//
//   GET                                   → every row + the locations to pick from
//   POST   { zip, location_uuid }         → add a zip to a location
//   PATCH  { id, location_uuid }          → move a row to another location
//   DELETE ?id=<row id>                   → remove a row
//   (resolve a conflict: POST ./resolve)
//
// Adding a zip another location already has is ALLOWED and answered with
// `conflict: true` — the zip then routes to loc_other until one row goes.
// That mirrors the rule: a conflict is data, never silently overwritten.
//
// Auth: super_admin OR admin (the "corporate" tier) — same fail-closed check
// as /api/admin/locations. The table has RLS on and no policy; everything
// goes through supabaseService after this gate.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { normalizeZip, ZIP_FALLBACK_SLUG } from '@/lib/zip-routing'
import { requireCorporate, loadTargetLocation, fetchAllLocationZips } from '@/lib/location-zips-admin'

export const runtime = 'nodejs'

async function otherClaimants(zip: string, excludeRowId: string | null) {
  const { data } = await supabaseService
    .from('location_zips')
    .select('id, location_uuid')
    .eq('zip', zip)
  return (Array.isArray(data) ? data : []).filter((r: any) => r.id !== excludeRowId)
}

export async function GET() {
  const gate = await requireCorporate()
  if (!gate.ok) return gate.res

  const [zipsRes, locsRes] = await Promise.all([
    fetchAllLocationZips(),
    supabaseService
      .from('locations')
      .select('id, name, location_id, lifecycle_status')
      .order('name', { ascending: true }),
  ])
  if ('error' in zipsRes) {
    return NextResponse.json({ error: 'zips_read_failed', detail: zipsRes.error }, { status: 500 })
  }
  if (locsRes.error) {
    return NextResponse.json({ error: 'locations_read_failed', detail: locsRes.error.message }, { status: 500 })
  }
  const locations = (locsRes.data || []).filter((l: any) => l.location_id !== ZIP_FALLBACK_SLUG)
  return NextResponse.json({ zips: zipsRes.rows, total: zipsRes.total, locations })
}

export async function POST(request: NextRequest) {
  const gate = await requireCorporate()
  if (!gate.ok) return gate.res

  const body = await request.json().catch(() => ({}))
  const zip = normalizeZip(body?.zip)
  if (!zip) return NextResponse.json({ error: 'invalid_zip' }, { status: 400 })

  const target = await loadTargetLocation(body?.location_uuid)
  if ('error' in target) {
    return NextResponse.json({ error: target.error }, { status: target.error === 'location_lookup_failed' ? 500 : 400 })
  }

  const existing = await otherClaimants(zip, null)
  if (existing.some((r: any) => r.location_uuid === target.location.id)) {
    return NextResponse.json({ error: 'already_assigned' }, { status: 409 })
  }

  const { data, error } = await supabaseService
    .from('location_zips')
    .insert({ zip, location_uuid: target.location.id, updated_by: gate.userId })
    .select('id, zip, location_uuid, updated_at')
    .single()
  if (error || !data) {
    return NextResponse.json({ error: 'insert_failed', detail: error?.message }, { status: 500 })
  }
  return NextResponse.json({ row: data, conflict: existing.length > 0 }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const gate = await requireCorporate()
  if (!gate.ok) return gate.res

  const body = await request.json().catch(() => ({}))
  const id = typeof body?.id === 'string' ? body.id : null
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { data: row, error: rowErr } = await supabaseService
    .from('location_zips')
    .select('id, zip, location_uuid')
    .eq('id', id)
    .maybeSingle()
  if (rowErr) return NextResponse.json({ error: 'read_failed', detail: rowErr.message }, { status: 500 })
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const target = await loadTargetLocation(body?.location_uuid)
  if ('error' in target) {
    return NextResponse.json({ error: target.error }, { status: target.error === 'location_lookup_failed' ? 500 : 400 })
  }
  if (target.location.id === row.location_uuid) {
    return NextResponse.json({ row, conflict: false })
  }

  const others = await otherClaimants(row.zip, row.id)
  if (others.some((r: any) => r.location_uuid === target.location.id)) {
    return NextResponse.json({ error: 'already_assigned' }, { status: 409 })
  }

  const { data, error } = await supabaseService
    .from('location_zips')
    .update({ location_uuid: target.location.id, updated_by: gate.userId, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, zip, location_uuid, updated_at')
    .single()
  if (error || !data) {
    return NextResponse.json({ error: 'update_failed', detail: error?.message }, { status: 500 })
  }
  return NextResponse.json({ row: data, conflict: others.length > 0 })
}

export async function DELETE(request: NextRequest) {
  const gate = await requireCorporate()
  if (!gate.ok) return gate.res

  const id = request.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { data, error } = await supabaseService
    .from('location_zips')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) return NextResponse.json({ error: 'delete_failed', detail: error.message }, { status: 500 })
  if (!Array.isArray(data) || data.length === 0) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  return NextResponse.json({ deleted: id })
}
