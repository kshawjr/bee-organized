// app/api/admin/location-zips/resolve/route.ts
//
// POST { zip, location_uuid } — settle a conflicted zip: keep the row for
// location_uuid, delete every other location's row for that zip. After this
// the zip routes to the kept location (lib/zip-routing.ts), where before it
// went to loc_other.
//
// The kept location must ALREADY claim the zip — resolving picks between the
// existing claimants, it does not assign a new territory (that is POST on the
// parent route). A zip that is not in conflict is a 409, so a stale screen
// cannot delete a row nobody meant to touch.
//
// Auth: same corporate gate as the parent route.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { normalizeZip } from '@/lib/zip-routing'
import { requireCorporate } from '@/lib/location-zips-admin'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const gate = await requireCorporate()
  if (!gate.ok) return gate.res

  const body = await request.json().catch(() => ({}))
  const zip = normalizeZip(body?.zip)
  if (!zip) return NextResponse.json({ error: 'invalid_zip' }, { status: 400 })
  const keep = typeof body?.location_uuid === 'string' ? body.location_uuid : null
  if (!keep) return NextResponse.json({ error: 'location_uuid required' }, { status: 400 })

  const { data: rows, error } = await supabaseService
    .from('location_zips')
    .select('id, location_uuid')
    .eq('zip', zip)
  if (error) return NextResponse.json({ error: 'read_failed', detail: error.message }, { status: 500 })

  const list = Array.isArray(rows) ? rows : []
  if (!list.some((r: any) => r.location_uuid === keep)) {
    return NextResponse.json({ error: 'location_does_not_claim_zip' }, { status: 400 })
  }
  const losers = list.filter((r: any) => r.location_uuid !== keep).map((r: any) => r.id)
  if (losers.length === 0) {
    return NextResponse.json({ error: 'not_in_conflict' }, { status: 409 })
  }

  const { error: delErr } = await supabaseService
    .from('location_zips')
    .delete()
    .in('id', losers)
  if (delErr) return NextResponse.json({ error: 'delete_failed', detail: delErr.message }, { status: 500 })

  return NextResponse.json({ zip, kept: keep, removed: losers })
}
