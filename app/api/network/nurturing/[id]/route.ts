// app/api/network/nurturing/[id]/route.ts
//
// GET /api/network/nurturing/<lead id>
//
// What opens when a Nurturing row is tapped (slice 7). READ-ONLY: GET only,
// writes nothing. A Nurturing person is a LEAD, not a partner, so this reads
// the lead's own fields, their assessments, quotes, jobs, requests,
// engagements, tags and latest touchpoints, plus the rule's verdict on them
// (lib/network/nurturing.ts) so the view can say WHY they are listed.
//
// Super admins only, the same gate as the list.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { maySeeNewNetwork } from '@/lib/network/access'
import { mayReadNetworkLocation } from '@/lib/network/route-access'
import { loadNurturePerson } from '@/lib/network/nurturing-read'

export const runtime = 'nodejs'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!maySeeNewNetwork(caller.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const id = (await params)?.id || ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'not_a_person_id' }, { status: 400 })
  }
  try {
    // The person's OWN location decides; another location's person is "not found".
    const found = await loadNurturePerson(supabaseService, id, { callerId: caller.userId, mayRead: (loc) => mayReadNetworkLocation(caller, loc) })
    if (!found) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    return NextResponse.json(found)
  } catch (err: any) {
    console.error('[network nurturing person] read failed', err)
    return NextResponse.json({ error: err?.message || 'read_failed' }, { status: 500 })
  }
}
