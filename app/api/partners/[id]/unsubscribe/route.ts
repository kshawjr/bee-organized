// app/api/partners/[id]/unsubscribe/route.ts
//
// POST — someone at the location marks a Network contact unsubscribed by hand
// ("they asked us to stop"). Partner emails, slice 2. No screen calls it yet
// (the contact sheet button is a later slice).
//
// Recorded as an OWNER's mark ('owner', with who and when), which a super
// admin can later reverse (./reverse). It is never recorded as the partner's
// own unsubscribe: only the partner pressing the button on their link can do
// that. The database function decides and re-checks who may do it (owner or
// manager of that location, admin, super admin); a direct write to the
// contact's unsubscribe columns is refused by the database.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { loadCaller, canWriteLocation } from '@/lib/crm'
import { supabaseService } from '@/lib/supabase-service'
import { markPartnerUnsubscribed } from '@/lib/network/partner-unsubscribe'

export const runtime = 'nodejs'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const caller = await loadCaller(await createServerSupabaseClient())
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: row } = await supabaseService.from('partners').select('id, location_id').eq('id', id).maybeSingle()
  // A contact the caller may not edit answers exactly like a missing one.
  if (!row || !canWriteLocation(caller, (row as any).location_id)) {
    return NextResponse.json({ error: 'partner_not_found' }, { status: 404 })
  }

  const outcome = await markPartnerUnsubscribed(id, caller.userId)
  if (outcome === 'unsubscribed' || outcome === 'already') return NextResponse.json({ ok: true, outcome })
  if (outcome === 'not_found' || outcome === 'not_allowed') return NextResponse.json({ error: 'partner_not_found' }, { status: 404 })
  return NextResponse.json({ error: 'mark_failed' }, { status: 500 })
}
