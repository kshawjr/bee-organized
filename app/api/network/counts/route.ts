// app/api/network/counts/route.ts
//
// GET /api/network/counts?location_id=<uuid>   (omit location_id → every location)
//
// The two numbers on the Network & Nurture tabs: "Network & Partners (100)"
// and "Nurturing Clients (5,037)". READ-ONLY: no POST, PATCH or DELETE, and
// nothing is written.
//
// COUNTED ON THE SERVER, never the length of rows a screen happened to load:
// a Supabase read stops at 1,000 rows, so a length would quietly top out.
//   · network    a head-only exact count of live partners rows (deleted_at
//                is null) at the location: the same rows /api/network/list
//                lists, so the tab and the list's "Everyone" agree.
//   · nurturing  Kevin's rule, unchanged (lib/network/nurturing.ts), worked
//                out by the same paged read the Nurturing tab uses
//                (loadNurturingList), and its count of the people it keeps.
//                Nurturing is derived from activity, so there is no column to
//                count; this is the one honest server-side number. The read
//                is cached for a minute and shared with the Nurturing tab.
//                One location only, as the Nurturing tab is: on All
//                locations it is null and the tab shows no number.
//
// WHO MAY CALL IT: the same gate, row for row, as /api/network/list.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { maySeeNewNetwork } from '@/lib/network/access'
import { mayReadNetworkLocation, maySeeAllNetworkLocations } from '@/lib/network/route-access'
import { loadNurturingList, nurtureLocation } from '@/lib/network/nurturing-read'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!maySeeNewNetwork(caller.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const locationId = request.nextUrl.searchParams.get('location_id')
  if (locationId && !UUID.test(locationId)) {
    return NextResponse.json({ error: 'location_id must be a location id' }, { status: 400 })
  }
  if (!locationId && !maySeeAllNetworkLocations(caller)) {
    return NextResponse.json({ error: 'all_locations_not_allowed' }, { status: 403 })
  }
  if (locationId && !mayReadNetworkLocation(caller, locationId)) {
    return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
  }

  try {
    let q = supabaseService.from('partners').select('id', { count: 'exact', head: true }).is('deleted_at', null)
    if (locationId) q = q.eq('location_id', locationId)
    const net = await q
    if (net.error) throw new Error(`partners count: ${net.error.message}`)

    let nurturing: number | null = null
    if (locationId) {
      const loc = await nurtureLocation(supabaseService, locationId)
      if (!loc) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
      // fresh=1 right after an Add (see loadNurturingList's refresh).
      nurturing = (await loadNurturingList(supabaseService, loc, { refresh: request.nextUrl.searchParams.get('fresh') === '1' })).counts.nurturing
    }
    return NextResponse.json({ network: net.count ?? 0, nurturing })
  } catch (err: any) {
    console.error('[network counts] read failed', err)
    return NextResponse.json({ error: err?.message || 'read_failed' }, { status: 500 })
  }
}
