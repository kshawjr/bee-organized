// app/api/network/nurturing/route.ts
//
// GET /api/network/nurturing?location_id=<uuid>&page=0&size=25&q=&sort=az&needs_contact=1
//
// The one read behind the NURTURING tab (Network & Nurture redesign, slice 7).
// READ-ONLY: this file has no POST, PATCH or DELETE and writes nothing.
// Everyone the rule calls Nurturing at ONE location, one page at a time.
//
// WHO MAY CALL IT: super admins only (lib/network/access.ts), the same gate
// as the new Network list. Everyone else gets 403.
//
// THE RULE is lib/network/nurturing.ts; the reads are
// lib/network/nurturing-read.ts (which also explains the slug-versus-uuid
// trap: the screen sends the locations.id uuid, leads are read by
// location_uuid, activity by the location's slug, and matched by lead_id).
//
// ONE LOCATION ONLY. The list is never built across every location: 39,600
// people is not a list anyone works through, and a person belongs to one
// location. Without location_id the route answers 400.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { maySeeNewNetwork } from '@/lib/network/access'
import { mayReadNetworkLocation } from '@/lib/network/route-access'
import { NURTURING_QUIET_DAYS, isNurtureSort, searchNurture, sortNurture } from '@/lib/network/nurturing'
import { loadNurturingList, loadNurtureTags, nurtureLocation } from '@/lib/network/nurturing-read'
import { PAGE_SIZES, clampPage } from '@/lib/network/paging'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!maySeeNewNetwork(caller.role, caller.locationId)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const p = request.nextUrl.searchParams
  const locationId = p.get('location_id') || ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(locationId)) {
    return NextResponse.json({ error: 'location_id must be one location id' }, { status: 400 })
  }
  // Another location answers like one that does not exist, as every Network
  // write route does (2026-11-21).
  if (!mayReadNetworkLocation(caller, locationId)) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
  const sizeAsked = Number(p.get('size'))
  const size = (PAGE_SIZES as readonly number[]).includes(sizeAsked) ? sizeAsked : 25
  const sort = isNurtureSort(p.get('sort')) ? (p.get('sort') as any) : 'az'
  const q = (p.get('q') || '').slice(0, 200)
  const needsOnly = p.get('needs_contact') === '1'

  try {
    const loc = await nurtureLocation(supabaseService, locationId)
    if (!loc) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
    const [list, tags] = await Promise.all([loadNurturingList(supabaseService, loc), loadNurtureTags(supabaseService, loc.id)])
    let rows = needsOnly ? list.rows.filter((r) => r.needsContactInfo) : list.rows
    rows = sortNurture(searchNurture(rows, q), sort)
    const page = clampPage(Math.floor(Number(p.get('page')) || 0), rows.length, size)
    return NextResponse.json({
      location: { id: loc.id, name: loc.name },
      quietDays: NURTURING_QUIET_DAYS,
      excluded: !!list.excluded,
      counts: list.counts,
      total: rows.length,
      page,
      size,
      sort,
      rows: rows.slice(page * size, (page + 1) * size),
      // slice 8: the tags these people can be given here (the Clients groups)
      tags,
    })
  } catch (err: any) {
    console.error('[network nurturing] read failed', err)
    return NextResponse.json({ error: err?.message || 'read_failed' }, { status: 500 })
  }
}
