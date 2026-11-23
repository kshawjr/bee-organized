// app/api/network/overview/route.ts
//
// GET /api/network/overview — how every location uses Network, one row each
// (Network & Nurture slice 9, the design's corporate overview). READ-ONLY:
// GET only, writes nothing. The counting is lib/network/overview.ts.
//
// WHO MAY CALL IT: the same gate as the rest of Network (lib/network/
// access.ts): super admins now. It shows every location, so it is for people
// who may see every location; when it is handed to corporate at the
// un-grey, that is the same list. An owner must never get it: they would see
// other locations' numbers. Everyone the gate says no to gets 403.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { maySeeNewNetwork } from '@/lib/network/access'
import { maySeeAllNetworkLocations } from '@/lib/network/route-access'
import { buildOverview } from '@/lib/network/overview'

export const runtime = 'nodejs'

export async function GET() {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!maySeeNewNetwork(caller.role, caller.locationId)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  // Every location's numbers: never for an owner, manager or lite user.
  if (!maySeeAllNetworkLocations(caller)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  try {
    const page = async (make: () => any, label: string) => {
      const out: any[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error } = await make().range(from, from + 999)
        if (error) throw new Error(`${label}: ${error.message}`)
        out.push(...(data || []))
        if ((data || []).length < 1000) return out
      }
    }
    const [locations, contacts, referred] = await Promise.all([
      page(() => supabaseService.from('locations').select('id, name, slug').order('id'), 'locations'),
      page(() => supabaseService.from('partners').select('id, location_id, network_types, partner_stage').is('deleted_at', null).order('id'), 'partners'),
      page(() => supabaseService.from('leads').select('id, name, created_at, location_uuid').eq('referred_by_kind', 'partner').not('referred_by_id', 'is', null).not('is_junk', 'is', true).order('id'), 'leads'),
    ])
    const engagements: any[] = []
    for (let i = 0; i < referred.length; i += 200) {
      const { data, error } = await supabaseService.from('engagements').select('client_id, stage, total_paid').in('client_id', referred.slice(i, i + 200).map((l: any) => l.id))
      if (error) throw new Error(`engagements: ${error.message}`)
      engagements.push(...(data || []))
    }
    return NextResponse.json(buildOverview({ locations, contacts, referred, engagements }))
  } catch (err: any) {
    console.error('[network overview] read failed', err)
    return NextResponse.json({ error: err?.message || 'read_failed' }, { status: 500 })
  }
}
