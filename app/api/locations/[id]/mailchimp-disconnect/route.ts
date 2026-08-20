// app/api/locations/[id]/mailchimp-disconnect/route.ts
//
// In-app "Disconnect" on the MailchimpCard (Settings → Connections). Clears the
// token, the server prefix, the account name, and the chosen audience, and
// flips BOTH mailchimp_connected and mailchimp_sync_live to false.
//
// Mirrors /api/locations/[id]/slack-disconnect and …/jobber-disconnect in shape
// and placement. The authorization rule is the Mailchimp one, not Slack's —
// resolveMailchimpTarget is the single source for it, so this route cannot
// drift from connect/callback/audiences.
//
// ── WHY sync_live IS CLEARED HERE, THE ONE PLACE THE OWNER UI TOUCHES IT ────
// Nothing in the owner UI can SET mailchimp_sync_live — it is Kevin's manual,
// per-location, fail-closed gate. But leaving it TRUE on a disconnected
// location would arm a location whose token is gone: the moment somebody
// reconnected, a sync would be live without anyone deciding it should be.
// Clearing on disconnect only ever moves the gate toward closed, which is the
// safe direction and needs no approval.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { resolveMailchimpTarget, targetFailureResponse } from '@/lib/mailchimp-oauth-guard'

export const runtime = 'nodejs'

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // The [id] in the path is a REQUEST, handled exactly like the connect route's
  // ?location_id=: honored for super_admin, ignored for admin/owner in favour
  // of their own location.
  const target = await resolveMailchimpTarget(supabase, user.id, params.id)
  if (!target.ok) {
    const fail = targetFailureResponse(target.reason)
    return NextResponse.json({ error: fail.error }, { status: fail.status })
  }

  const { data: loc, error: locErr } = await supabaseService
    .from('locations')
    .select('id, name, location_id')
    .eq('id', target.locationUuid)
    .maybeSingle()
  if (locErr || !loc) {
    return NextResponse.json({ error: 'location not found' }, { status: 404 })
  }

  const { error } = await supabaseService
    .from('locations')
    .update({
      mailchimp_access_token: null,
      mailchimp_server_prefix: null,
      mailchimp_account_name: null,
      mailchimp_list_id: null,
      mailchimp_list_name: null,
      mailchimp_connected: false,
      mailchimp_connected_at: null,
      mailchimp_sync_live: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', loc.id)

  if (error) {
    console.error('[mailchimp-disconnect] failed:', error)
    return NextResponse.json({ error: `disconnect_failed: ${error.message}` }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    message: `Disconnected ${loc.name || loc.location_id} from Mailchimp.`,
  })
}
