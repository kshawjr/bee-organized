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
//
// The FIRST sync for a location also needs `confirm: { count, list_id, flows }`
// in the body (plus `tags_ok` for any held tag the owner allowed), matching
// what the engine is about to send. Without it the engine answers reason
// 'needs_confirmation' and sends nothing. The flows refusal, the switch and
// the confirmation all live in the engine (FL-75 slice 6); this route only
// relays.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { resolveMailchimpTarget, targetFailureResponse } from '@/lib/mailchimp-oauth-guard'
import { syncWebsiteLeadsToMailchimp } from '@/lib/mailchimp-sync'

export const runtime = 'nodejs'
// 60s matches every other long route here (send-to-jobber, webhooks) — going
// higher risks the plan cap. The engine stops itself at 45 seconds and says so
// (complete: false, how many are left); pressing Sync now again carries on.
// Everyone already added is in Mailchimp by then, so nobody is added twice.
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
    const c = body?.confirm
    const confirm = c && Number.isInteger(c.count) && typeof c.list_id === 'string' && typeof c.flows === 'string'
      ? {
          count: c.count as number, listId: c.list_id as string, flows: c.flows as string,
          tagsOk: Array.isArray(c.tags_ok) ? c.tags_ok.filter((t: unknown) => typeof t === 'string').slice(0, 50) : [],
        }
      : null
    const report = await syncWebsiteLeadsToMailchimp(target.locationUuid, { confirm })
    if (report.errors.length) {
      console.error('[mailchimp-sync]', target.locationUuid, '—', report.failed, 'failed:',
        JSON.stringify(report.errors.slice(0, 10)))
    }
    console.log('[mailchimp-sync]', target.locationUuid, '—',
      `ran=${report.ran} complete=${report.complete ?? '-'} pushed=${report.pushed} already=${report.alreadyThere} failed=${report.failed} remaining=${report.remaining}`,
      report.reason ? `reason=${report.reason}` : '', report.stopReason ? `stop=${report.stopReason}` : '')
    // The full error list stays in the server log; the card gets the numbers
    // and the reason. Addresses in a browser payload help nobody.
    return NextResponse.json({
      ran: report.ran,
      reason: report.reason ?? null,
      words: report.words ?? null,
      first: report.first ?? null,
      complete: report.complete ?? null,
      stopped: report.ran && report.complete === false ? (report.stopReason || 'stopped') : null,
      pushed: report.pushed,
      already: report.alreadyThere,
      skipped: report.skipped,
      failed: report.failed,
      said_no: report.saidNo,
      held_back: report.heldBack,
      remaining: report.remaining,
      tags_held: report.tagsHeld,
      must_pause: report.mustPause ?? null,
      how_to_pause: report.howToPause ?? null,
      confirm: report.confirm
        ? {
            count: report.confirm.count, list_id: report.confirm.listId, list_name: report.confirm.listName,
            flows: report.confirm.flows, paused_flows: report.confirm.pausedFlows, held_tags: report.confirm.heldTags,
            left_out: report.confirm.leftOut,
          }
        : null,
    })
  } catch (err: any) {
    console.error('[mailchimp-sync] run failed:', err)
    return NextResponse.json({ error: 'sync_failed' }, { status: 500 })
  }
}
