// app/api/mailchimp/sync/route.ts
//
// Issue 246 step 3A — the manual trigger. POST-only: this sends marketing data
// to a third party, and a GET that mutates the world is how prefetchers cause
// incidents. The "Sync now" button on the Mailchimp card is the only caller.
//
// Authorization is resolveMailchimpTarget — the SAME guard as connect/callback/
// audiences/disconnect, not a second copy of the rules: super_admin may name a
// location in the body, admin/owner get their OWN and the body is ignored,
// everyone else is refused. targetFailureResponse keeps the status codes from
// drifting per-route.
//
// The fail-closed gate (mailchimp_sync_live, connection, audience) lives in the
// ENGINE, not here — so no future caller of syncWebsiteLeadsToMailchimp can
// forget it. A gated-off location gets { pushed: 0, reason } and zero requests
// are sent to Mailchimp.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { resolveMailchimpTarget, targetFailureResponse } from '@/lib/mailchimp-oauth-guard'
import { syncWebsiteLeadsToMailchimp } from '@/lib/mailchimp-sync'

export const runtime = 'nodejs'
// 60s matches every other long route here (send-to-jobber, webhooks) — going
// higher risks the plan cap. A first-ever sync on a big location that hits the
// wall loses NOTHING: each lead stamps mailchimp_synced_at as it lands, so the
// eligibility clause shrinks with every push and clicking Sync now again picks
// up exactly the remainder.
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: any = {}
  try { body = await request.json() } catch { /* empty body is fine — owners send none */ }

  const target = await resolveMailchimpTarget(supabase, user.id, body?.location_id ?? null)
  if (!target.ok) {
    const fail = targetFailureResponse(target.reason)
    return NextResponse.json({ error: fail.error }, { status: fail.status })
  }

  try {
    const report = await syncWebsiteLeadsToMailchimp(target.locationUuid)
    if (report.errors.length) {
      console.error('[mailchimp-sync]', target.locationUuid, '—', report.failed, 'failed:',
        JSON.stringify(report.errors.slice(0, 10)))
    }
    console.log('[mailchimp-sync]', target.locationUuid, '—',
      `ran=${report.ran} pushed=${report.pushed} skipped=${report.skipped} failed=${report.failed}`,
      report.reason ? `reason=${report.reason}` : '')
    // The full error list stays in the server log; the card gets the numbers
    // and the reason. Lead ids in a browser payload help nobody.
    return NextResponse.json({
      ran: report.ran,
      reason: report.reason ?? null,
      pushed: report.pushed,
      skipped: report.skipped,
      failed: report.failed,
    })
  } catch (err: any) {
    console.error('[mailchimp-sync] run failed:', err)
    return NextResponse.json({ error: 'sync_failed' }, { status: 500 })
  }
}
