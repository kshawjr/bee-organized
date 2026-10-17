// app/api/mailchimp/status/route.ts
//
// One read-only fact for the MailchimpCard: is sending switched on for the
// caller's location yet? Without it, a connected owner looked at a card that
// said nothing about what happens next — for six weeks, in Chattanooga's case.
//
// It READS mailchimp_sync_live and returns it as { live }. It cannot set it:
// that switch stays Kevin's, by hand, per location. Same resolveMailchimpTarget
// guard as every other Mailchimp route — super_admin may name a location,
// admin/owner get their own, everyone else is refused.
//
// The token and server prefix are never selected here. This route does not
// read leads and sends nothing to Mailchimp.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { resolveMailchimpTarget, targetFailureResponse } from '@/lib/mailchimp-oauth-guard'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const requested = new URL(request.url).searchParams.get('location_id')
  const target = await resolveMailchimpTarget(supabase, user.id, requested)
  if (!target.ok) {
    const fail = targetFailureResponse(target.reason)
    return NextResponse.json({ error: fail.error }, { status: fail.status })
  }

  const { data, error } = await supabaseService
    .from('locations')
    .select('mailchimp_sync_live')
    .eq('id', target.locationUuid)
    .maybeSingle()
  if (error || !data) {
    return NextResponse.json({ error: 'location not found' }, { status: 404 })
  }

  return NextResponse.json({ live: data.mailchimp_sync_live === true })
}
