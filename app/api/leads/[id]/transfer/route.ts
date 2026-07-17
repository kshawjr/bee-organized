// app/api/leads/[id]/transfer/route.ts
//
// POST /api/leads/:id/transfer — corp/admin only.
//
// Routes a lead (in practice a loc_other global-form lead that landed
// outside any service area) to a REAL location. This is the load-bearing
// server gate: isAdmin(role). The client "Needs transfer" section and the
// card Transfer button are cosmetic — view-as flips only the client role,
// so the move itself must be re-checked here.
//
// On EVERY transfer (regardless of the destination's lifecycle):
//   • Move BOTH location columns coherently — location_id (the slug string
//     the Jobber sync + the leads_jobber_client_id_location_idx unique index
//     read) AND location_uuid (the NOT-NULL FK every drip / notification /
//     scoping read keys on). They must never diverge.
//   • Notify the DESTINATION's effective recipients (resolveLeadRecipients
//     resolves by UUID) with the standard new-lead email — the new owner
//     learns a lead just landed in their inbox.
//   • Write a 'system' touchpoint recording the move.
//
// Only when the destination is lifecycle_status === 'active':
//   • Re-enroll the drip. Ordering is load-bearing: stop the OLD drip FIRST,
//     THEN start the DESTINATION's (never against existing.location_uuid —
//     the pre-transfer value is the known trap). startDripForLead SCHEDULES
//     step 1 (next_send_at = now() for a delay-0 step) and lets the hourly
//     cron deliver it — we deliberately do NOT inline-send, mirroring
//     drip-restart, so a transfer never blasts an email synchronously.
//     After the start we VERIFY a fresh active progress row exists and
//     report if it didn't (the UNIQUE(lead_id, drip_path_id) DO-NOTHING
//     path can silently no-op a same-master-path re-enroll).
//
// A NON-active destination skips the drip entirely — no enrollment, no
// queued row that would auto-fire on later activation (per product rule,
// that's a manual start). The owner is still notified.
//
// Failures after the location move (touchpoint, notification, drip) are
// non-fatal: the move is the primary goal and it already landed, so they
// surface as `warnings` rather than flipping the response to an error.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { stopActiveDripsForLead, startDripForLead } from '@/lib/drip-lifecycle'
import { notifyNewLead } from '@/lib/lead-notification-email'

export const runtime = 'nodejs'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // ─── Auth: the load-bearing gate ──────────────────────────────
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
  if (!isAdmin(hubUser.role)) {
    return NextResponse.json({ error: 'forbidden_admin_only' }, { status: 403 })
  }

  // ─── Body ─────────────────────────────────────────────────────
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const destinationId = body?.destination_location_id
  if (!destinationId || typeof destinationId !== 'string') {
    return NextResponse.json({ error: 'destination_location_id required' }, { status: 400 })
  }

  // ─── Load the lead (service client — RLS is out-of-band; the
  // move writes with the service role, never an RLS-scoped client) ─
  const { data: existing, error: loadError } = await supabaseService
    .from('leads')
    .select('id, name, email, phone, project_type, request_details, preferred_contact, location_id, location_uuid, jobber_client_id')
    .eq('id', id)
    .single()
  if (loadError || !existing) {
    return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  }

  // ─── Resolve the destination location by UUID ─────────────────
  const { data: dest, error: destError } = await supabaseService
    .from('locations')
    .select('id, name, location_id, lifecycle_status')
    .eq('id', destinationId)
    .maybeSingle()
  if (destError) {
    return NextResponse.json(
      { error: 'destination_lookup_failed', detail: destError.message },
      { status: 500 },
    )
  }
  if (!dest) {
    return NextResponse.json({ error: 'destination_not_found' }, { status: 400 })
  }
  // loc_other is the holding pen, never a transfer target.
  if (dest.location_id === 'loc_other') {
    return NextResponse.json({ error: 'cannot_transfer_to_loc_other' }, { status: 400 })
  }
  if (dest.id === existing.location_uuid) {
    return NextResponse.json({ error: 'already_at_destination' }, { status: 400 })
  }

  const now = new Date().toISOString()

  // ─── Move BOTH location columns coherently ────────────────────
  // Dedicated write (NOT the generic PATCH allowlist, which deliberately
  // excludes the location columns) via the service client.
  const { error: moveError } = await supabaseService
    .from('leads')
    .update({
      location_id: dest.location_id,   // slug string
      location_uuid: dest.id,          // NOT-NULL FK
      updated_at: now,
    })
    .eq('id', id)
  if (moveError) {
    // The partial unique index leads_jobber_client_id_location_idx on
    // (jobber_client_id, location_id) can collide when a Jobber-linked lead
    // moves into a location that already holds the same jobber_client_id.
    // Global-form leads aren't Jobber-linked so this shouldn't fire, but
    // report it cleanly instead of 500ing.
    if ((moveError as any).code === '23505') {
      return NextResponse.json(
        {
          error: 'destination_has_linked_duplicate',
          detail: 'A Jobber-linked lead with the same client already exists at the destination.',
        },
        { status: 409 },
      )
    }
    return NextResponse.json(
      { error: 'transfer_failed', detail: moveError.message },
      { status: 500 },
    )
  }

  const warnings: string[] = []

  // ─── System touchpoint on the lead (records the move) ─────────
  try {
    const { error: tpError } = await supabaseService.from('touchpoints').insert({
      lead_id:       id,
      location_uuid: dest.id,
      kind:          'system',
      method:        'system',
      label:         'Transferred in',
      notes:         `Routed from ${existing.location_id || 'global form'} to ${dest.name}`,
      status:        'done',
      occurred_at:   now,
      user_id:       hubUser.id,
    })
    if (tpError) throw tpError
  } catch (err: any) {
    console.error('[transfer] touchpoint insert failed', err)
    warnings.push(`touchpoint_insert_failed: ${err?.message || String(err)}`)
  }

  // ─── Notify the destination's recipients (ALWAYS) ─────────────
  // Same new-lead email intake sends; recipients resolve by the DESTINATION
  // UUID. Fires whether or not the location is active — a pre-launch owner
  // still wants to know a lead just landed.
  let notifiedCount = 0
  try {
    const baseUrl =
      process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ||
      req.nextUrl?.origin ||
      null
    const notify = await notifyNewLead({
      location: { id: dest.id, name: dest.name },
      // locations.location_id is the SLUG, not the uuid (notification_log).
      locationSlug: dest.location_id,
      baseUrl,
      lead: {
        id:                existing.id,
        name:              existing.name,
        email:             existing.email,
        phone:             existing.phone,
        project_type:      existing.project_type,
        request_details:   existing.request_details,
        preferred_contact: existing.preferred_contact,
      },
    })
    notifiedCount = notify.sent ? notify.recipientCount : 0
    if (notify.error) warnings.push(`lead_notification_failed: ${notify.error}`)
  } catch (err: any) {
    console.error('[transfer] notifyNewLead threw', err)
    warnings.push(`lead_notification_failed: ${err?.message || String(err)}`)
  }

  // ─── Drip re-enroll — ONLY for an active destination ──────────
  let dripEnrolled = false
  let dripSkippedReason: string | null = null
  if (dest.lifecycle_status === 'active') {
    // resolveDripCategory (inside startDripForLead) reads project_type to
    // pick the move vs organizing path; a null project_type still routes —
    // it falls back to the organizing default — but report it rather than
    // let a silent default look like an intentional category choice.
    if (!existing.project_type) {
      warnings.push('project_type_null_drip_routed_to_default')
    }
    // (a) STOP the old drip FIRST — a different-path enrollment would
    //     otherwise leave the pre-transfer drip live and the cron would send
    //     BOTH concurrently.
    await stopActiveDripsForLead(id, 'stage_changed')
    // (b) THEN start against the DESTINATION uuid (never existing.location_uuid).
    //     startDripForLead self-gates on active + not-paused + not-opted-out
    //     and SCHEDULES step 1 (no inline blast — mirrors drip-restart).
    await startDripForLead(id, dest.id)
    // (c) VERIFY a fresh active progress row actually exists. The
    //     UNIQUE(lead_id, drip_path_id) DO-NOTHING path can silently no-op a
    //     re-enroll onto a master path the lead already carries a row for.
    //     For a global-form loc_other lead (never previously enrolled) the
    //     insert is clean; the check guards the edge and reports it.
    const { data: activeRow } = await supabaseService
      .from('lead_drip_progress')
      .select('id')
      .eq('lead_id', id)
      .is('stopped_at', null)
      .is('completed_at', null)
      .limit(1)
      .maybeSingle()
    if (activeRow) {
      dripEnrolled = true
    } else {
      warnings.push('drip_not_enrolled_after_start')
    }
  } else {
    // Non-active destination: skip the drip ENTIRELY. Do NOT seed a row that
    // would auto-fire when the location later activates — that's a manual
    // start per product rule. The owner was still notified above.
    dripSkippedReason = 'destination_not_active'
  }

  return NextResponse.json({
    success:  true,
    lead_id:  id,
    from:     { uuid: existing.location_uuid, slug: existing.location_id },
    to:       {
      uuid:             dest.id,
      slug:             dest.location_id,
      name:             dest.name,
      lifecycle_status: dest.lifecycle_status ?? null,
    },
    notified:      notifiedCount,
    drip_enrolled: dripEnrolled,
    ...(dripSkippedReason ? { drip_skipped_reason: dripSkippedReason } : {}),
    ...(warnings.length ? { warnings } : {}),
  })
}
