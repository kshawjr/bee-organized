// app/api/webhooks/resend/route.ts
//
// Inbound webhook receiver for Resend delivery events — Half B of the outbound-
// mail notebook. Half A (migrations/notification_log.sql) already reserved
// delivery_status / delivery_updated_at (with a CHECK matching Resend's values)
// and indexed resend_message_id NOT-unique so this route can find and update the
// N rows of a message by its id. NO migration is part of this change.
//
// THE GAP THIS CLOSES (#104, building on #73). A send-time 422 (invalid /
// mistyped address) is already caught synchronously and stops the drip
// (lib/drip-send.ts, stopped_reason='invalid_recipient'). But a valid-LOOKING
// address whose mailbox doesn't exist is ACCEPTED by Resend at send time —
// returns an id, the drip advances — and bounces asynchronously, here. This
// route is the other half of that policy.
//
// Flow (mirrors the Stripe/Jobber receivers' shape):
//   1. Read the RAW body — Svix signs the exact bytes.
//   2. Verify the svix-* headers against RESEND_WEBHOOK_SECRET
//      (lib/resend-webhook.ts). Invalid/missing → 401, NO DB write.
//   3. Every mapped event → update notification_log.delivery_status +
//      delivery_updated_at for ALL rows sharing this resend_message_id.
//   4. Hard bounce (email.bounced, bounce.type='Permanent') or complaint
//      (email.complained) → TERMINAL: stop the client's drip.
//      'Transient'/'Undetermined' bounce → delivery_status only, stop nothing.
//   5. Return 200 on any verified event — actionable or not — so Resend does
//      not retry-storm. 401 is reserved for signature failure. A genuine DB
//      failure returns 500 so Resend retries (every write here is idempotent).
//
// THE CORRECTNESS TRAP (named in the #104 scout). The drip stop is GATED on the
// bounced row's email_kind === 'drip'. A bounce on a 'lead_notification' row
// means an INTERNAL recipient's mailbox is dead (a staffer's address) — that
// must update delivery_status but must NEVER silence the client's drip. Pinned
// by lib/resend-webhook-drip-stop.test.ts.
//
// fetchCache='force-no-store' (#95/#96): the notification_log / lead_drip_progress
// reads below run on near-constant predicates and would otherwise be served from
// a frozen Next.js Data Cache, so a bounce could act on stale rows.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { recordDripTouchpoint } from '@/lib/drip-send'
import {
  verifyResendSignature,
  extractResendEvent,
  deliveryStatusForEvent,
  isHardBounce,
  isComplaint,
} from '@/lib/resend-webhook'

export const runtime = 'nodejs'
export const fetchCache = 'force-no-store'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type LogRow = {
  id: string
  lead_id: string | null
  location_id: string | null
  email_kind: string | null
}

export async function POST(req: NextRequest) {
  // 1. Raw body first — Svix signs the exact bytes.
  const rawBody = await req.text()

  // 2. Verify. Fail-closed: missing secret or bad signature → 401, no write.
  const ok = verifyResendSignature(rawBody, {
    id: req.headers.get('svix-id'),
    timestamp: req.headers.get('svix-timestamp'),
    signature: req.headers.get('svix-signature'),
  })
  if (!ok) {
    console.warn('[resend-webhook] signature_invalid')
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  // 3. Parse. Signature-valid but unparseable is essentially impossible (Svix
  // signs the exact bytes), so ack it rather than invite a retry storm.
  let event: any
  try {
    event = JSON.parse(rawBody)
  } catch {
    console.error('[resend-webhook] signature-valid body failed JSON.parse')
    return NextResponse.json({ ok: true, skipped: 'bad_json' })
  }

  const evt = extractResendEvent(event)
  if (!evt || !evt.messageId) {
    // No message id → nothing in the notebook to reconcile against.
    return NextResponse.json({ ok: true, skipped: 'no_message_id' })
  }

  const deliveryStatus = deliveryStatusForEvent(evt.type)
  if (!deliveryStatus) {
    // email.sent (already 'accepted' at send time), email.failed, or any event
    // we don't track. Acknowledged so a widened dashboard selection is inert.
    return NextResponse.json({ ok: true, skipped: 'unhandled_event_type', type: evt.type })
  }

  const nowIso = new Date().toISOString()

  try {
    // ── Read the rows for this message id BEFORE updating ────────────────────
    // We need lead_id + email_kind to decide the drip stop, and a read failure
    // must fail the whole delivery (500 → Resend retries) rather than silently
    // skip the stop. resend_message_id is indexed, not unique: a multi-recipient
    // send returns several rows here — that's expected (see the migration grain).
    const { data: rows, error: readErr } = await supabaseService
      .from('notification_log')
      .select('id, lead_id, location_id, email_kind')
      .eq('resend_message_id', evt.messageId)
    if (readErr) {
      console.error('[resend-webhook] notification_log read failed —', readErr.message)
      return NextResponse.json({ error: 'log_read_failed' }, { status: 500 })
    }

    // ── Update delivery_status on EVERY row for this message id ───────────────
    // Idempotent: a Svix redelivery re-sets the same value. Applies to all
    // recipients of the message, drip and lead_notification alike — a bounced
    // internal recipient correctly reads 'bounced'; only the drip STOP below is
    // gated. SCOPE: updating by message id, not per-recipient — see the note at
    // the bottom of this file.
    const { error: updateErr } = await supabaseService
      .from('notification_log')
      .update({ delivery_status: deliveryStatus, delivery_updated_at: nowIso })
      .eq('resend_message_id', evt.messageId)
    if (updateErr) {
      console.error('[resend-webhook] notification_log update failed —', updateErr.message)
      return NextResponse.json({ error: 'log_update_failed' }, { status: 500 })
    }

    // ── Terminal? Stop the client's drip ─────────────────────────────────────
    const hard = isHardBounce(evt)
    const complaint = isComplaint(evt)
    if (!hard && !complaint) {
      // Delivered / opened / clicked / deferred / soft bounce — recorded, no stop.
      return NextResponse.json({ ok: true, processed: true, delivery_status: deliveryStatus })
    }

    const stoppedReason = complaint ? 'spam_complaint' : 'hard_bounce'
    const stopLabel = complaint ? 'Drip stopped — spam complaint' : 'Drip stopped — email bounced'

    // THE GATE: only a bounce on the email sent TO THE CLIENT (email_kind='drip')
    // stops a drip. A dead staffer mailbox on a 'lead_notification' row updates
    // delivery_status (done above) and stops nothing. Dedupe lead_ids so two
    // drip rows for one message can't double-process.
    const dripLeadIds = Array.from(
      new Set(
        (rows as LogRow[] | null || [])
          .filter(r => r.email_kind === 'drip' && r.lead_id)
          .map(r => r.lead_id as string),
      ),
    )

    let stopped = 0
    for (const leadId of dripLeadIds) {
      // Stop ONLY currently-active drips — same active predicate as sendDripStep.
      // The .select() returns the rows actually flipped: zero means the drip was
      // already stopped/paused/completed (a redelivery, or #73 already stopped
      // it), so we write NO touchpoint and record no second stop. This is the
      // idempotency seam — the touchpoint rides the transition, not the event.
      const { data: flipped, error: stopErr } = await supabaseService
        .from('lead_drip_progress')
        .update({ stopped_at: nowIso, stopped_reason: stoppedReason })
        .eq('lead_id', leadId)
        .is('stopped_at', null)
        .is('paused_at', null)
        .is('completed_at', null)
        .select('id')
      if (stopErr) {
        console.error('[resend-webhook] drip stop failed —', { leadId, error: stopErr.message })
        return NextResponse.json({ error: 'drip_stop_failed' }, { status: 500 })
      }
      if (flipped && flipped.length > 0) {
        stopped += flipped.length
        // Timeline trace — WITHOUT this the async stop is invisible on the
        // record, unlike the send-time 422 stop. location_id comes off the drip
        // row in the notebook; a null location (shouldn't happen for a drip) just
        // skips the best-effort touchpoint rather than crashing the insert.
        const locId = (rows as LogRow[]).find(r => r.lead_id === leadId && r.location_id)?.location_id
        if (locId) {
          await recordDripTouchpoint(leadId, locId, { status: 'failed', label: stopLabel })
        }
      }
    }

    return NextResponse.json({
      ok: true,
      processed: true,
      delivery_status: deliveryStatus,
      terminal: true,
      reason: stoppedReason,
      drips_stopped: stopped,
    })
  } catch (err: any) {
    // Unexpected throw — 500 so Resend retries; every write above is idempotent.
    console.error('[resend-webhook] handler_failed —', err?.message || err)
    return NextResponse.json({ error: 'handler_failed' }, { status: 500 })
  }
}

// ── SCOPE NOTE: multi-recipient attribution (deferred, #104) ─────────────────
// A lead notification puts every recipient on one To line, so one message id
// maps to several notification_log rows. This route updates delivery_status for
// ALL of them on any delivery event — it does NOT yet attribute a bounce to the
// single address that bounced. To narrow it we need the specific bounced
// recipient from the payload: Resend's bounce envelope carries data.to, but
// whether that is the one bounced address or an echo of the full original To
// list is unresolved (it needs a live probe against a two-recipient send with
// one bounced@resend.dev address). Once confirmed, the update key becomes
// (resend_message_id, recipient=<bounced addr>). This affects DISPLAY ACCURACY
// on lead-notification rows only — never the drip stop, which is single-
// recipient by construction (drips send to exactly lead.email).
