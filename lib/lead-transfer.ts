// lib/lead-transfer.ts
//
// THE TRANSFER ITSELF — moved out of app/api/leads/[id]/transfer/route.ts
// (20 Oct 2026) so a second caller, the Slack "accept this suggestion" button,
// can run exactly the same move. transferLead() takes the lead, the
// destination, the reason and WHO is moving it; it knows nothing about HTTP
// sessions. Each caller proves who the actor is its own way (the web route by
// the browser session, Slack by its signed request) and passes the hub_user.
// The result is the exact status + JSON body the web route has always sent.
//
// Moves a lead to a REAL location. Two kinds of lead, one function:
//   · the unrouted queue — a loc_other global-form lead that landed outside
//     any service area. What this was built for.
//   · ANY lead that already has a home (1 Oct 2026). Zip routing made
//     reassignment routine, and until then a lead sitting at the wrong
//     location could only be moved with a database update.
// The load-bearing gate is isAdmin(role), checked HERE on the actor as well as
// in the web route: the client "Needs transfer" section, the card Transfer
// button and the card's ··· item are cosmetic — view-as flips only the client
// role — and a Slack click carries no session at all, so whoever calls this,
// the move itself re-checks. An OWNER cannot move a lead out of their own
// location.
//
// WHICH LEADS MAY MOVE — lib/lead-transfer-rule. A lead that has reached
// Jobber, or has an engagement, is REFUSED (409) with nothing written: its
// Jobber record lives in the old location's own Jobber account, and its
// engagement is what the old location's reports count. Read that file before
// loosening either.
//
// ALREADY A CLIENT THERE (22 Oct 2026) — before moving, the destination is
// checked for the same person by intake's own match (exact email or phone,
// that location only, never name). One clear match: no move and no second
// record — the enquiry is attached to their record as a resubmission and the
// waiting copy is binned, flagged (attachToExistingClient). An ambiguous
// match moves as before, flagged possible_duplicate_of.
//
// A lead that already has a home additionally:
//   • OWES A REASON (400 reason_required). It is written on the transfer
//     touchpoint, beside who moved it (user_id), so the timeline says why.
//   • LOSES ITS ASSIGNEE — leads.assigned_to AND the lead_assignees rows. The
//     person who had it works at the old location. Both, because the junction
//     is the plural truth: clearing only the column leaves the old location's
//     person assigned.
//   • TAKES ITS HISTORY WITH IT — touchpoints, notes and extra contacts carry
//     a location of their own, and corporate's per-location load reads them
//     BY that location (lib/hub-scope CHILD_LOCATION_SCOPE). Left behind, the
//     lead would arrive with its timeline invisible on that load.
//
// On EVERY transfer (regardless of the destination's lifecycle):
//   • Move BOTH location columns coherently — location_id (the slug string
//     the Jobber sync + the leads_jobber_client_id_location_idx unique index
//     read) AND location_uuid (the NOT-NULL FK every drip / notification /
//     scoping read keys on). They must never diverge.
//   • Notify the DESTINATION's effective recipients (resolveLeadRecipients
//     resolves by UUID) with the standard new-lead email — the new owner
//     learns a lead just landed in their inbox.
//   • Post the destination's Slack card (19 Oct 2026) — the new-lead card with
//     one "Moved here from X — reason" line on top. Until then a transfer was
//     email-only, so an owner who lives in Slack never saw it. Same gate and
//     log row as intake's post (notifyNewLeadSlack / logSlackNotification).
//     The LOSING location is deliberately not told (Kevin, 19 Oct): nobody
//     asked, and that card's Log call button would act on the new location.
//   • Write a 'system' touchpoint recording the move. Its label is the SHARED
//     TRANSFER_IN_LABEL constant, because the 35-day auto-close reads exactly
//     this row to start the receiving owner's clock (lib/auto-close): if the
//     writer and the reader ever drifted on the string, a routed lead would
//     silently go back to counting from the original enquiry, and nothing
//     would fail.
//   • CLEAR the Inbox holds — inbox_dismissed_at and snoozed_until. A dismiss
//     means "handled in MY inbox"; the lead is now in someone ELSE's inbox,
//     where nobody has handled it. Carrying the hold over would deliver a lead
//     the receiving owner can never see.
//
// A transfer to a location with NO STAFF is allowed and deliberate (Kevin,
// 2026-09-04). It needs no special notification path: notifyNewLead above
// already reaches such a location's EXTERNALS, because resolveLeadRecipients
// counts a location as interface-managed on `users.length > 0 || externals
// .length > 0` — the same path, unchanged, that notifies an unonboarded
// location today. What it must NOT do is drip: nobody is there to answer the
// client's reply. See the drip gate below.
//
// Only when the destination is active AND STAFFED:
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

import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import {
  transferBlockFor,
  transferNeedsReason,
  TRANSFER_BLOCK_ERROR,
  TRANSFER_BLOCK_COPY,
  TRANSFER_REASON_MAX,
} from '@/lib/lead-transfer-rule'
import { stopActiveDripsForLead, startDripForLead } from '@/lib/drip-lifecycle'
import { notifyNewLead } from '@/lib/lead-notification-email'
import { notifyNewLeadSlack } from '@/lib/slack-bot'
import { logSlackNotification } from '@/lib/notification-log'
import { locationHasOperationalStaff } from '@/lib/notification-recipients'
import { TRANSFER_IN_LABEL } from '@/lib/enquiry-exit'
import { broadcastLeadMoved } from '@/lib/realtime-broadcast'
import { retireOtherCards, exitLine, actorName } from '@/lib/other-card-sync'
import { queryLeadMatches, classifyLeadMatches } from '@/components/hive/shared/clientMatch'
import { attachResubmission } from '@/lib/enquiry-resubmission'
import { isClosedLocation } from '@/lib/location-close'

// Who is moving the lead. hubUserId is stamped on the transfer touchpoint
// (user_id); role is re-checked with isAdmin before anything is read.
export type TransferActor = {
  hubUserId: string
  role: string
}

// The exact HTTP status and JSON body for the outcome. The web route sends it
// as-is; another caller (Slack) reads status/body.error to word its reply.
export type TransferOutcome = {
  status: number
  body: Record<string, any>
}

export async function transferLead(args: {
  leadId: string
  // locations.id (uuid) of the destination.
  destinationLocationId: string
  // As received — anything that isn't a string counts as no reason.
  reason: unknown
  actor: TransferActor
  // For the deep link in the notifications when no site URL env is set. The
  // web route passes its request origin; a caller without one passes null.
  requestOrigin?: string | null
}): Promise<TransferOutcome> {
  const { leadId: id, destinationLocationId, reason: rawReason, actor } = args
  const requestOrigin = args.requestOrigin ?? null

  // ─── The gate, again, on the actor (see the header) ───────────
  if (!isAdmin(actor.role)) {
    return { status: 403, body: { error: 'forbidden_admin_only' } }
  }

  // ─── Load the lead (service client — RLS is out-of-band; the
  // move writes with the service role, never an RLS-scoped client) ─
  const { data: existing, error: loadError } = await supabaseService
    .from('leads')
    .select('id, name, email, phone, project_type, request_details, preferred_contact, source, address, city, state, zip, location_id, location_uuid, assigned_to, jobber_client_id, jobber_request_id, jobber_quote_id, jobber_job_id, jobber_invoice_id, jobber_assessment_id, jobber_sync_status, possible_duplicate_of')
    .eq('id', id)
    .single()
  if (loadError || !existing) {
    return { status: 404, body: { error: 'lead_not_found' } }
  }

  // ─── Resolve the destination location by UUID ─────────────────
  const { data: dest, error: destError } = await supabaseService
    .from('locations')
    .select('id, name, location_id, lifecycle_status')
    .eq('id', destinationLocationId)
    .maybeSingle()
  if (destError) {
    return { status: 500, body: { error: 'destination_lookup_failed', detail: destError.message } }
  }
  if (!dest) {
    return { status: 400, body: { error: 'destination_not_found' } }
  }
  // loc_other is the holding pen, never a transfer target.
  if (dest.location_id === 'loc_other') {
    return { status: 400, body: { error: 'cannot_transfer_to_loc_other' } }
  }
  // A closed location has no people to work a lead (lib/location-close).
  if (isClosedLocation(dest.lifecycle_status)) {
    return { status: 400, body: { error: 'destination_closed' } }
  }
  if (dest.id === existing.location_uuid) {
    return { status: 400, body: { error: 'already_at_destination' } }
  }

  // ─── A lead that already has a home owes a reason ─────────────
  const hasHome = transferNeedsReason(existing.location_id)
  const reason = typeof rawReason === 'string' ? rawReason.trim() : ''
  if (hasHome && !reason) {
    return { status: 400, body: { error: 'reason_required' } }
  }
  if (reason.length > TRANSFER_REASON_MAX) {
    return { status: 400, body: { error: 'reason_too_long' } }
  }

  // ─── May this lead move at all? (lib/lead-transfer-rule) ──────
  // Checked for EVERY origin, the unrouted queue included: a lead that has
  // reached Jobber is no safer to move from there. FAIL CLOSED — a read that
  // errors refuses the move rather than guessing the lead is clean.
  const childTables: Array<[string, string]> = [
    ['engagements', 'client_id'],
    ['service_requests', 'lead_id'],
    ['quotes', 'lead_id'],
    ['jobs', 'lead_id'],
    ['invoices', 'lead_id'],
    ['assessments', 'lead_id'],
    ['payments', 'lead_id'],
  ]
  const childCounts = await Promise.all(
    childTables.map(([table, column]) =>
      supabaseService.from(table).select('id', { count: 'exact', head: true }).eq(column, id),
    ),
  )
  const failedCheck = childCounts.findIndex((r) => r.error)
  if (failedCheck >= 0) {
    return { status: 500, body: { error: 'transfer_check_failed', detail: `${childTables[failedCheck][0]}: ${childCounts[failedCheck].error?.message}` } }
  }
  const [engagementCount, ...jobberRecordCounts] = childCounts.map((r) => r.count ?? 0)
  const block = transferBlockFor({
    inJobber:
      !!existing.jobber_client_id || !!existing.jobber_request_id || !!existing.jobber_quote_id ||
      !!existing.jobber_job_id || !!existing.jobber_invoice_id || !!existing.jobber_assessment_id ||
      // A recorded send with no client id (4 such rows, 1 Oct 2026) still
      // means a request exists in the old location's Jobber.
      !!existing.jobber_sync_status ||
      jobberRecordCounts.some((n) => n > 0),
    engagementCount,
  })
  if (block) {
    return { status: 409, body: { error: TRANSFER_BLOCK_ERROR[block], detail: TRANSFER_BLOCK_COPY[block].long } }
  }

  // The old location's NAME, for the record. Cosmetic: a failed read falls
  // back to the slug rather than stopping a move.
  let originName: string = existing.location_id || 'global form'
  // What the Slack card says it came from. An unrouted lead came from the
  // holding pen, whose locations.name is "Other" — not its slug.
  let originLabel: string = 'Other'
  if (hasHome && existing.location_uuid) {
    const { data: origin } = await supabaseService
      .from('locations')
      .select('name')
      .eq('id', existing.location_uuid)
      .maybeSingle()
    if (origin?.name) originName = origin.name
    originLabel = originName
  }

  const now = new Date().toISOString()

  // ─── Already a client at the destination? ─────────────────────
  // The same match-or-create gate intake runs at the location a form lands
  // at, run here at the location the lead is moving TO — intake never saw
  // that location (Shirley Ann Morgan: the general form put her in Other on
  // 12 Oct, the move into Central Denver on 13 Oct made her a second record
  // there). Same vocabulary, same tiers (clientMatch): exact email (case and
  // whitespace ignored) or phone_normalized, this location only, never name.
  //   SOLID       — attach the enquiry to that record as a resubmission and
  //                 bin this copy, flagged (attachToExistingClient below).
  //   IN QUESTION — move as before, flagged possible_duplicate_of.
  // A failed match read degrades to the plain move with a warning — a
  // duplicate is recoverable, a move that silently never happens is not.
  const matchWarnings: string[] = []
  let possibleDuplicateIds: string[] = []
  try {
    const rows = await queryLeadMatches(supabaseService, {
      email: existing.email,
      phone: existing.phone,
      locationUuid: dest.id,
    })
    const verdict = classifyLeadMatches(rows.filter((r: { id: string }) => r.id !== id), { email: existing.email, phone: existing.phone }) as {
      tier: 'solid' | 'in_question' | 'none'
      match?: any
      matchedOn?: string
      matchIds?: string[]
    }
    if (verdict.tier === 'solid') {
      return await attachToExistingClient({
        existing, dest, actor, now, originLabel, requestOrigin,
        match: verdict.match,
        matchedOn: verdict.matchedOn ?? 'email',
        baseWarnings: matchWarnings,
      })
    }
    if (verdict.tier === 'in_question') possibleDuplicateIds = verdict.matchIds ?? []
  } catch (err: any) {
    console.error('[transfer] destination match failed — moving without it', err)
    matchWarnings.push(`dedup_match_failed: ${err?.message || String(err)}`)
  }

  // ─── Move BOTH location columns coherently ────────────────────
  // Dedicated write (NOT the generic PATCH allowlist, which deliberately
  // excludes the location columns) via the service client.
  const { data: moved, error: moveError } = await supabaseService
    .from('leads')
    .update({
      location_id: dest.location_id,   // slug string
      location_uuid: dest.id,          // NOT-NULL FK
      // The person who had it works at the OLD location. The junction rows —
      // the plural truth — are cleared just below.
      assigned_to: null,
      // A dismiss/snooze is a hold on the OLD owner's inbox, not a property of
      // the lead. Cleared in the SAME write that moves the location, so there
      // is no window where the lead sits at its new location still hidden.
      inbox_dismissed_at: null,
      snoozed_until: null,
      // IN QUESTION at the destination: move it, but say who it might be.
      ...(possibleDuplicateIds.length
        ? { possible_duplicate_of: withDuplicateIds(existing.possible_duplicate_of, possibleDuplicateIds) }
        : {}),
      updated_at: now,
    })
    .eq('id', id)
    // The check above and this write are two statements. A Send to Jobber
    // landing between them would link the lead after it was judged clean, so
    // the write itself refuses a lead that has gained a client id.
    .is('jobber_client_id', null)
    .select('id')
  if (moveError) {
    // The partial unique index leads_jobber_client_id_location_idx on
    // (jobber_client_id, location_id) can collide when a Jobber-linked lead
    // moves into a location that already holds the same jobber_client_id.
    // A Jobber-linked lead is refused before this write, so this shouldn't
    // fire, but report it cleanly instead of 500ing.
    if ((moveError as any).code === '23505') {
      return {
        status: 409,
        body: {
          error: 'destination_has_linked_duplicate',
          detail: 'A Jobber-linked lead with the same client already exists at the destination.',
        },
      }
    }
    return { status: 500, body: { error: 'transfer_failed', detail: moveError.message } }
  }

  if (Array.isArray(moved) && moved.length === 0) {
    return { status: 409, body: { error: 'lead_changed' } }
  }

  const warnings: string[] = [...matchWarnings]

  // The IN QUESTION flag, in words the timeline shows — intake's own trace.
  if (possibleDuplicateIds.length > 0) {
    const { error: dupTpErr } = await supabaseService.from('touchpoints').insert({
      lead_id:       id,
      location_uuid: dest.id,
      kind:          'system',
      method:        'system',
      label:         'Possible duplicate — transfer matched existing lead(s)',
      notes:         `Suspected match at ${dest.name}: ${possibleDuplicateIds.join(', ')}`,
      status:        'done',
      occurred_at:   now,
      user_id:       actor.hubUserId,
    })
    if (dupTpErr) warnings.push(`dup_touchpoint_insert_failed: ${dupTpErr.message}`)
  }

  // ─── Clear the assignee rows ──────────────────────────────────
  // Best effort like everything after the move — but a failure here is said
  // out loud, because a leftover row keeps the old location's person on a
  // lead they can no longer open.
  let assigneesCleared = 0
  try {
    const { data: gone, error: clearError } = await supabaseService
      .from('lead_assignees')
      .delete()
      .eq('lead_id', id)
      .select('hub_user_id')
    if (clearError) throw clearError
    assigneesCleared = Array.isArray(gone) ? gone.length : 0
  } catch (err: any) {
    console.error('[transfer] lead_assignees clear failed', err)
    warnings.push(`assignee_clear_failed: ${err?.message || String(err)}`)
  }

  // ─── The lead's history follows it ────────────────────────────
  // Runs BEFORE the transfer touchpoint is written, so that row is not
  // re-stamped by its own carry.
  for (const table of ['touchpoints', 'lead_notes', 'lead_contacts']) {
    try {
      const { error: carryError } = await supabaseService
        .from(table)
        .update({ location_uuid: dest.id })
        .eq('lead_id', id)
      if (carryError) throw carryError
    } catch (err: any) {
      console.error(`[transfer] ${table} carry failed`, err)
      warnings.push(`history_move_failed: ${table}: ${err?.message || String(err)}`)
    }
  }

  // ─── Tell both ends, live ─────────────────────────────────────
  // The move has committed, so every open Hive can be told directly rather
  // than waiting to notice. This exists because postgres_changes does NOT
  // carry a transfer to the destination: for an UPDATE, Supabase must be able
  // to show the row to the subscriber in BOTH its old and new state, and
  // before the move the lead sits at a location the receiving user's RLS
  // cannot see. The row event is never delivered, so the card never arrived
  // until a reload.
  //
  // Sent FIRST, before the touchpoint and the emails, because it is the part
  // a human is waiting on — an owner staring at their Inbox. The rest of this
  // handler is bookkeeping and notification that nobody is watching in real
  // time.
  //
  // BEST EFFORT, exactly like the touchpoint and the notify below: the
  // transfer is already durable, so a broadcast that fails is a warning, never
  // a 500. The lead is correct in the database and a reload still shows it.
  const broadcast = await broadcastLeadMoved({
    leadId: id,
    fromLocationUuid: existing.location_uuid ?? null,
    toLocationUuid: dest.id,
  })
  if (!broadcast) warnings.push('live_broadcast_failed')

  // ─── System touchpoint on the lead (records the move) ─────────
  try {
    const { error: tpError } = await supabaseService.from('touchpoints').insert({
      lead_id:       id,
      location_uuid: dest.id,
      kind:          'system',
      method:        'system',
      label:         TRANSFER_IN_LABEL,
      // Who moved it is user_id; WHY is here, in words the timeline shows.
      notes:         hasHome
        ? `Moved from ${originName} to ${dest.name}. Reason: ${reason}`
        : `Routed from ${existing.location_id || 'global form'} to ${dest.name}`,
      status:        'done',
      occurred_at:   now,
      user_id:       actor.hubUserId,
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
  const baseUrl =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ||
    requestOrigin ||
    null
  try {
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
        address:           existing.address ?? null,
        city:              existing.city ?? null,
        state:             existing.state ?? null,
        zip:               existing.zip ?? null,
      },
    })
    notifiedCount = notify.sent ? notify.recipientCount : 0
    if (notify.error) warnings.push(`lead_notification_failed: ${notify.error}`)
  } catch (err: any) {
    console.error('[transfer] notifyNewLead threw', err)
    warnings.push(`lead_notification_failed: ${err?.message || String(err)}`)
  }

  // ─── Slack card to the destination (ALWAYS tried) ─────────────
  // The intake card plus one "Moved here" line. notifyNewLeadSlack never
  // throws and quietly skips a location without Slack; the try/catch is the
  // same belt-and-braces intake wears. Non-fatal like everything after the
  // move: a failure is a warning and a 'failed' notification_log row.
  const slackLogContext = {
    lead_id:       existing.id,
    lead_name:     existing.name,
    location_id:   dest.id,
    location_slug: dest.location_id,
  }
  let slackPosted = false
  try {
    const slackRes = await notifyNewLeadSlack({
      locationId:   dest.id,
      locationName: dest.name,
      baseUrl,
      transfer:     { from: originLabel, reason: hasHome ? reason : null },
      lead: {
        id:                existing.id,
        name:              existing.name,
        email:             existing.email,
        phone:             existing.phone,
        project_type:      existing.project_type,
        request_details:   existing.request_details,
        preferred_contact: existing.preferred_contact,
        source:            existing.source ?? null,
        address:           existing.address ?? null,
        city:              existing.city ?? null,
        state:             existing.state ?? null,
        zip:               existing.zip ?? null,
      },
    })
    slackPosted = slackRes.ok
    if (slackRes.error) warnings.push(`slack_notification_failed: ${slackRes.error}`)
    await logSlackNotification(slackRes, slackLogContext)
  } catch (err: any) {
    console.error('[transfer] notifyNewLeadSlack threw', err)
    warnings.push(`slack_notification_failed: ${err?.message || String(err)}`)
    await logSlackNotification({ ok: false, error: err?.message || String(err) }, slackLogContext)
  }

  // ─── Other's Slack card, if it had one (lib/other-card-sync) ────
  // Edited in place to say where it went and who moved it, buttons gone —
  // whether the move came from Bee Hub or from the card itself. A lead that
  // never had a card (any franchise lead) is a no-op. Never fails the move.
  try {
    const who = await actorName(actor.hubUserId)
    await retireOtherCards({ leadId: id, resolution: 'moved', line: exitLine('moved', { dest: dest.name, who }) })
  } catch (err: any) {
    console.error('[transfer] slack card edit failed', err)
  }

  // ─── Drip re-enroll — ONLY for an active, STAFFED destination ──
  // Two independent conditions that happen to coincide in today's data (every
  // staffless location is also still onboarding). They are checked separately
  // on purpose: the moment a location activates before its owner accepts the
  // invite, `active` alone would start dripping a client whose reply lands in
  // an office with nobody in it.
  let dripEnrolled = false
  let dripSkippedReason: string | null = null
  const destinationStaffed = dest.lifecycle_status === 'active'
    ? await locationHasOperationalStaff(dest.id)
    : false
  if (dest.lifecycle_status === 'active' && destinationStaffed) {
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
    const enrol = await startDripForLead(id, dest.id)
    // (c) VERIFY a fresh active progress row actually exists. The
    //     UNIQUE(lead_id, drip_path_id) DO-NOTHING path can silently no-op a
    //     re-enroll onto a master path the lead already carries a row for.
    //     For a global-form loc_other lead (never previously enrolled) the
    //     insert is clean; the check guards the edge and reports it.
    const findActiveRow = async () => (await supabaseService
      .from('lead_drip_progress')
      .select('id')
      .eq('lead_id', id)
      .is('stopped_at', null)
      .is('completed_at', null)
      .limit(1)
      .maybeSingle()).data
    let activeRow = await findActiveRow()
    // (d) THE SAME-SEQUENCE CASE, which a lead with a home makes ordinary.
    //     Two locations that both use the shared master sequence resolve to
    //     the SAME drip_path_id, so the start above collides with the row
    //     step (a) just stopped, reports "enrolled", and leaves nothing
    //     running. Clear the lead's old rows and start once more — exactly
    //     what drip-restart does. What was already sent stays on the timeline
    //     as touchpoints; only the bookkeeping rows go.
    if (!activeRow && hasHome && enrol?.enrolled) {
      const { error: resetError } = await supabaseService
        .from('lead_drip_progress')
        .delete()
        .eq('lead_id', id)
      if (resetError) {
        warnings.push(`drip_reset_failed: ${resetError.message}`)
      } else {
        await startDripForLead(id, dest.id)
        activeRow = await findActiveRow()
      }
    }
    if (activeRow) {
      dripEnrolled = true
    } else {
      warnings.push(
        enrol && !enrol.enrolled && enrol.reason
          ? `drip_not_enrolled_after_start: ${enrol.reason}`
          : 'drip_not_enrolled_after_start',
      )
    }
  } else {
    // Skip the drip ENTIRELY. Do NOT seed a row that would auto-fire when the
    // location later activates or hires — that's a manual start per product
    // rule. The destination's recipients were still notified above.
    dripSkippedReason = dest.lifecycle_status === 'active'
      ? 'destination_has_no_staff'
      : 'destination_not_active'
  }

  return { status: 200, body: {
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
    slack_posted:  slackPosted,
    assignees_cleared: assigneesCleared,
    ...(hasHome ? { reason } : {}),
    destination_staffed: destinationStaffed,
    drip_enrolled: dripEnrolled,
    ...(dripSkippedReason ? { drip_skipped_reason: dripSkippedReason } : {}),
    ...(warnings.length ? { warnings } : {}),
  } }
}

// leads.possible_duplicate_of is JSONB holding an ARRAY of lead ids (some rows
// carry several, from intake and the Jobber import). Add to it, never replace
// it, and never list an id twice.
export function withDuplicateIds(current: unknown, add: string[]): string[] {
  const had = Array.isArray(current)
    ? current.filter((v): v is string => typeof v === 'string')
    : typeof current === 'string' && current ? [current] : []
  return Array.from(new Set([...had, ...add]))
}

// ─── The person is already a client at the destination ────────────
// No second record. The enquiry goes onto the record they already have, by
// the SAME attach a website resubmission gets (lib/enquiry-resubmission):
// empty fields filled, an open engagement surfaced or a past client's card
// founded, a "Webform resubmission" touchpoint (which reopens their Inbox
// entry), drip only if never enrolled, and the location told "returning
// client".
//
// The copy that was waiting to be moved is BINNED, flagged (Kevin, 22 Oct
// 2026): is_junk true and possible_duplicate_of naming the real record, its
// drip stopped, its Other card retired. Nothing is deleted, and Restore
// brings it back. Its location columns are left alone — it never arrived.
async function attachToExistingClient(args: {
  existing: Record<string, any>
  dest: { id: string; name: string; location_id: string; lifecycle_status: string | null }
  actor: TransferActor
  now: string
  originLabel: string
  requestOrigin: string | null
  match: Record<string, any> & { id: string }
  matchedOn: string
  baseWarnings: string[]
}): Promise<TransferOutcome> {
  const { existing, dest, actor, now, originLabel, requestOrigin, match, matchedOn } = args
  const id: string = existing.id

  // Bin the waiting copy first: if this write fails, nothing has been
  // attached and the lead is exactly where it was.
  const { data: binned, error: binError } = await supabaseService
    .from('leads')
    .update({
      is_junk: true,
      possible_duplicate_of: withDuplicateIds(existing.possible_duplicate_of, [match.id]),
      updated_at: now,
    })
    .eq('id', id)
    // Same race guard as the move: a Send to Jobber landing in between
    // means this lead is no longer a clean copy.
    .is('jobber_client_id', null)
    .select('id')
  if (binError) {
    return { status: 500, body: { error: 'transfer_failed', detail: binError.message } }
  }
  if (Array.isArray(binned) && binned.length === 0) {
    return { status: 409, body: { error: 'lead_changed' } }
  }

  const warnings: string[] = [...args.baseWarnings]

  try {
    await stopActiveDripsForLead(id, 'junk')
  } catch (err: any) {
    console.error('[transfer] binned copy drip stop failed', err)
    warnings.push(`drip_stop_failed: ${err?.message || String(err)}`)
  }

  const { error: tpError } = await supabaseService.from('touchpoints').insert({
    lead_id:       id,
    location_uuid: existing.location_uuid,
    kind:          'system',
    method:        'system',
    label:         'Already a client — added to their record',
    notes:         `Already a client at ${dest.name} (matched on ${matchedOn}). This enquiry was added to their record (${match.id}) instead of making a second one, and this copy was binned.`,
    status:        'done',
    occurred_at:   now,
    user_id:       actor.hubUserId,
  })
  if (tpError) warnings.push(`touchpoint_insert_failed: ${tpError.message}`)

  const attached = await attachResubmission({
    matched: match,
    matchedOn,
    location: dest,
    submittedName: existing.name || match.name || '',
    submission: {
      email: existing.email ?? null,
      phone: existing.phone ?? null,
      address: existing.address ?? null,
      city: existing.city ?? null,
      state: existing.state ?? null,
      zip: existing.zip ?? null,
      project_type: existing.project_type ?? null,
      message: existing.request_details ?? null,
      preferred_contact: existing.preferred_contact ?? null,
    },
    source: existing.source ?? null,
    baseWarnings: warnings,
    now,
    reqOrigin: requestOrigin,
    phoneNote: null,
    via: `transferred from ${originLabel}`,
  })

  try {
    const who = await actorName(actor.hubUserId)
    await retireOtherCards({ leadId: id, resolution: 'binned', line: `🔁 Already a client at *${dest.name}* — added to their record${who ? ` by ${who}` : ''}.` })
  } catch (err: any) {
    console.error('[transfer] slack card edit failed', err)
  }

  return { status: 200, body: {
    success:     true,
    lead_id:     id,
    attached_to: match.id,
    matched_on:  matchedOn,
    from:        { uuid: existing.location_uuid, slug: existing.location_id },
    to:          {
      uuid:             dest.id,
      slug:             dest.location_id,
      name:             dest.name,
      lifecycle_status: dest.lifecycle_status ?? null,
    },
    notified:      attached.notifiedCount,
    drip_enrolled: attached.dripEnrolled,
    ...(attached.engagementId
      ? { engagement_id: attached.engagementId, engagement_action: attached.engagementFounded ? 'founded' : 'updated' }
      : attached.foundingSkipped ? { engagement_action: 'skipped', engagement_skipped: attached.foundingSkipped } : {}),
    ...(attached.warnings.length ? { warnings: attached.warnings } : {}),
  } }
}
