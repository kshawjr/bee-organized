// app/api/locations/[id]/zips/route.ts
//
// GET — one location's territory: its zips, which of them another location
// also claims (a conflict: leads from it go to loc_other, not here), and
// whether the location is live (a not-live location's zips go to loc_other
// too — lib/zip-routing ROUTE_ONLY_TO_ACTIVE).
//
// READ ONLY. There is deliberately no POST/PATCH/DELETE here: every change to
// a territory goes through app/api/admin/location-zips (+ ./resolve), which
// refuses anyone but corporate. Kevin's ruling: corporate edits, owners view.
//
// Who may read (lib/territory-access): corporate, any location; an owner or
// manager of THIS location. `can_edit` in the response is the server's
// answer to "may this caller change it" — the panel shows controls only when
// it is true, and the write routes check again regardless.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { territoryEditableServer, territoryViewableServer } from '@/lib/territory-access'
import { fetchAllLocationZips } from '@/lib/location-zips-admin'
import { ROUTE_ONLY_TO_ACTIVE, ZIP_FALLBACK_SLUG } from '@/lib/zip-routing'

export const runtime = 'nodejs'

const IN_CHUNK = 200 // zips per .in() — keeps the request URL short

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const locationId = params?.id
  if (!locationId) return NextResponse.json({ error: 'location id required' }, { status: 400 })

  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!caller || !territoryViewableServer(caller.role, caller.location_id, locationId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const canEdit = territoryEditableServer(caller.role)

  const { data: location, error: locErr } = await supabaseService
    .from('locations')
    .select('id, name, location_id, lifecycle_status')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr) return NextResponse.json({ error: 'location_lookup_failed', detail: locErr.message }, { status: 500 })
  if (!location) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })

  // This location's rows — paged, like the corporate list.
  const own = await fetchAllLocationZips((q) => q.eq('location_uuid', locationId))
  if ('error' in own) return NextResponse.json({ error: 'zips_read_failed', detail: own.error }, { status: 500 })
  const zips = own.rows.map((r: any) => ({ id: r.id, zip: r.zip, location_uuid: r.location_uuid }))

  // Every claimant of those zips, to find the ones another location shares.
  const zipList = Array.from(new Set(zips.map((z) => z.zip)))
  const claimRows: any[] = []
  for (let i = 0; i < zipList.length; i += IN_CHUNK) {
    const chunk = zipList.slice(i, i + IN_CHUNK)
    const res = await fetchAllLocationZips((q) => q.in('zip', chunk))
    if ('error' in res) return NextResponse.json({ error: 'zips_read_failed', detail: res.error }, { status: 500 })
    claimRows.push(...res.rows)
  }
  const byZip = new Map<string, Set<string>>()
  for (const r of claimRows) {
    if (!byZip.has(r.zip)) byZip.set(r.zip, new Set())
    byZip.get(r.zip)!.add(r.location_uuid)
  }
  const conflictZips = zipList.filter((z) => (byZip.get(z)?.size ?? 0) > 1).sort()

  // Names for the locations on the other side of each conflict.
  const otherIds = Array.from(new Set(conflictZips.flatMap((z) => Array.from(byZip.get(z)!)))).filter((id) => id !== locationId)
  const names = new Map<string, string>([[location.id, location.name]])
  if (otherIds.length) {
    const { data: others } = await supabaseService.from('locations').select('id, name').in('id', otherIds)
    for (const o of others || []) names.set(o.id, o.name)
  }
  const conflicts = conflictZips.map((zip) => ({
    zip,
    claimants: Array.from(byZip.get(zip)!)
      .map((id) => ({ location_uuid: id, name: names.get(id) || 'Another location' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }))

  // Corporate moves zips between locations, so it gets the picker list.
  let locations: any[] | undefined
  if (canEdit) {
    const { data } = await supabaseService
      .from('locations')
      .select('id, name, location_id, lifecycle_status')
      .order('name', { ascending: true })
    locations = (data || []).filter((l: any) => l.location_id !== ZIP_FALLBACK_SLUG)
  }

  return NextResponse.json({
    location: { id: location.id, name: location.name, slug: location.location_id, lifecycle_status: location.lifecycle_status },
    zips,
    count: zipList.length,
    conflicts,
    not_live_routes_to_other: ROUTE_ONLY_TO_ACTIVE && location.lifecycle_status !== 'active',
    can_edit: canEdit,
    ...(locations ? { locations } : {}),
  })
}
