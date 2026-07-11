// app/api/engagements/[id]/reopen/route.ts
//
// POST /api/engagements/:id/reopen — RESURRECT a Closed LOST engagement.
//
// Option B (re-derive): reopening does NOT restore a stored pre-close
// stage and never an arbitrary default — it clears the terminal fields
// (closed_at / closed_reason / closed_note) and RE-DERIVES the correct
// open stage from the engagement's actual child records via the SAME
// live-mode authority the webhook/import/drift paths use
// (deriveEngagementStage). A live quote and no job ⇒ Estimate; a booked
// job in flight ⇒ Job in Progress; and so on. Because it lands exactly
// where live derivation says, a subsequent drift-recovery pass agrees and
// can't re-close it (forward-only rank check → no-op).
//
// Also clears engagements.nurture_started_at (a reopened deal is actively
// worked, not nurturing) to restore nurture eligibility. Drips are
// governed by the LEAD stage machine, not engagements — closing an
// engagement never stopped them, so reopen has nothing to un-stop there;
// the lead's Activate-Drips / drip-resume control remains the drip path.
//
// SCOPE: Closed LOST only. Closed Won is settled money and stays out of
// scope (409). Server-validated exactly like the stage/junk hardening —
// browser gates aren't enforcement; every rule is re-checked here.
//
// Auth mirrors the sibling engagement routes: logged-in hub_user;
// super_admin/admin any location, everyone else scoped to their own
// (hub_users.location_id === engagement.location_uuid). lite_user blocked.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { writeSyncLog } from '@/lib/sync-log'
import { deriveEngagementStage } from '@/lib/engagements'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }
  if (hubUser.role === 'lite_user') {
    return NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 })
  }

  const { data: engagement, error: engError } = await supabaseService
    .from('engagements')
    .select('id, stage, client_id, location_uuid, closed_reason')
    .eq('id', id)
    .maybeSingle()
  if (engError || !engagement) {
    return NextResponse.json({ error: 'engagement_not_found' }, { status: 404 })
  }

  if (!isAdmin(hubUser.role) && hubUser.location_id !== engagement.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  // Closed LOST only — enforced server-side, never trusting the UI.
  if (engagement.stage === 'Closed Won') {
    return NextResponse.json(
      { error: 'reopen_won_out_of_scope', message: 'Closed Won engagements are settled money — reopening is out of scope', current: engagement.stage },
      { status: 409 },
    )
  }
  if (engagement.stage !== 'Closed Lost') {
    return NextResponse.json(
      { error: 'reopen_requires_closed_lost', message: 'Only a Closed Lost engagement can be reopened', current: engagement.stage },
      { status: 409 },
    )
  }

  // Re-derive from the actual records (live mode — the webhook/drift
  // authority). Same child shape deriveEngagementStage consumes.
  const [srRes, quotesRes, jobsRes, invoicesRes] = await Promise.all([
    supabaseService.from('service_requests').select('requested_at, created_at').eq('engagement_id', id).order('requested_at', { ascending: true, nullsFirst: false }).limit(1),
    supabaseService.from('quotes').select('status, sent_at, approved_at, created_at').eq('engagement_id', id),
    supabaseService.from('jobs').select('status, completed_at, scheduled_start, created_at').eq('engagement_id', id),
    supabaseService.from('invoices').select('status, paid_at, issued_at, created_at').eq('engagement_id', id),
  ])
  const derived = deriveEngagementStage({
    sr: srRes.data?.[0] ?? null,
    quotes: quotesRes.data ?? [],
    jobs: jobsRes.data ?? [],
    invoices: invoicesRes.data ?? [],
  }, { mode: 'live' })

  const nowIso = new Date().toISOString()
  // Set exactly what live derivation produced: for the common reopen
  // (stale quote, no job) that's an open stage with the terminal fields
  // cleared to null; in the rare case the records actually prove a
  // paid-in-full win, derivation yields Closed Won and its own
  // reason/closed_at (the honest outcome — this deal wasn't lost).
  const patch: Record<string, any> = {
    stage: derived.stage,
    stage_entered_at: nowIso,
    closed_at: derived.closed_at ?? null,
    closed_reason: derived.closed_reason ?? null,
    closed_note: null,
    nurture_started_at: null,
    updated_at: nowIso,
  }

  const { error: updateError } = await supabaseService
    .from('engagements')
    .update(patch)
    .eq('id', id)
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  // Trail: a stage_change touchpoint + a sync_log breadcrumb, both
  // fail-safe (the reopen already committed).
  await supabaseService.from('touchpoints').insert({
    lead_id: engagement.client_id,
    location_uuid: engagement.location_uuid,
    engagement_id: id,
    kind: 'stage_change',
    label: `Reopened: Closed Lost → ${derived.stage}`,
    user_id: hubUser.id,
    occurred_at: nowIso,
  })

  const { data: clientLead } = await supabaseService
    .from('leads')
    .select('location_id, name')
    .eq('id', engagement.client_id)
    .maybeSingle()
  await writeSyncLog({
    location_id: clientLead?.location_id || 'unknown',
    entity_id: id,
    entity_type: 'engagement',
    status: 'success',
    message:
      `[engagement:reopen] Closed Lost → ${derived.stage} (re-derived from records) ` +
      `for client "${clientLead?.name || engagement.client_id}"`,
  })

  return NextResponse.json({
    id,
    reopened: true,
    stage: derived.stage,
    prev_stage: 'Closed Lost',
  })
}
