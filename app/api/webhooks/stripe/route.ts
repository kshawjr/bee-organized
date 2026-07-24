// app/api/webhooks/stripe/route.ts
//
// Inbound webhook receiver for Stripe Payment Link checkouts
// (subscription milestone 1 — payment links only, no Stripe API calls).
//
// Flow (mirrors the Jobber receiver's shape):
//   1. Read RAW body (signature verification needs exact bytes).
//   2. Verify the Stripe-Signature header against STRIPE_WEBHOOK_SECRET
//      (lib/stripe-webhook.ts). Invalid/missing → 401, NO DB write —
//      an unverified payment webhook would be a free-seats endpoint.
//   3. Parse the event. checkout.session.completed and
//      checkout.session.async_payment_succeeded activate (when
//      payment_status='paid'); async_payment_failed alerts; everything
//      else is acknowledged + logged.
//   4. Map the payment: client_reference_id → locations.id (appended by
//      Bee Hub at click time), metadata.tier → seat tier (set by Kevin
//      on the Payment Link in the Stripe dashboard).
//   5. Idempotency, two layers: stripe_webhook_events (event-id replay
//      short-circuit, row written after successful processing) + the
//      unique billing_invoices.stripe_payment_intent_id index and
//      session-id seat markers (business-level, survives partial failures).
//   6. Activate through lib/subscription-activation.ts — the SAME
//      function the onboarding route uses. Never a parallel write path.
//   7. sync_log row (topic=STRIPE_PAYMENT …) + landed check → the admin
//      webhook dashboard and the 3-hourly Slack digest see every event;
//      successful payments also ping Slack immediately.
//
// DELIBERATE divergence from the Jobber receiver's "always 200":
// transient handler/DB failures return 500 so Stripe RETRIES (up to
// ~3 days). Retries are safe because of layer-2 idempotency. 200 is
// reserved for: processed, replay, and verified-but-unactionable events
// (unknown location, missing tier — retrying can't fix those; they get
// an error log + Slack ping instead).

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import { writeSyncLog } from '@/lib/sync-log'
import { postSlackMessage } from '@/lib/slack'
import { getPrimaryOwnerForLocation } from '@/lib/owner-resolution'
import {
  verifyStripeSignature,
  extractCheckoutSession,
  deriveSeatQuantity,
  isUuid,
  STRIPE_ACTIVATING_EVENTS,
  STRIPE_FAILURE_EVENTS,
} from '@/lib/stripe-webhook'
import {
  activateLocationSubscription,
  addStripePurchasedSeats,
  getLocationBilling,
  nextRenewalDateString,
  recordStripeInvoice,
  type LocationBillingRow,
} from '@/lib/subscription-activation'

export const runtime = 'nodejs'
export const maxDuration = 60

const VALID_TIERS = ['owner', 'manager', 'light', 'readonly']

function dollars(cents: number | null): string {
  return cents == null ? '?' : `$${(cents / 100).toFixed(2)}`
}

// sync_log wrapper with the STRIPE_PAYMENT topic token — the token
// format is load-bearing for the digest/dashboard parsers.
async function logStripeEvent(args: {
  locationSlug: string | null
  sessionId: string | null
  status: 'success' | 'error'
  detail: string
  landed?: 'landed' | 'not_landed' | 'na'
}) {
  await writeSyncLog({
    location_id: args.locationSlug,
    entity_id: args.sessionId || 'unknown_session',
    entity_type: 'payment',
    direction: 'inbound',
    status: args.status,
    message: `topic=STRIPE_PAYMENT item=${args.sessionId || 'unknown'} ${args.detail}`.slice(0, 1000),
    landed_status: args.landed ?? 'na',
  })
}

export async function POST(req: NextRequest) {
  // 1. Raw body first — Stripe signs the exact bytes.
  const rawBody = await req.text()

  // 2. Verify. Fail-closed: missing secret rejects everything.
  const signature = req.headers.get('stripe-signature')
  if (!verifyStripeSignature(rawBody, signature)) {
    console.warn('[stripe-webhook] signature_invalid')
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  // 3. Parse. Signature-valid but unparseable still gets a log row
  // (same policy as the Jobber receiver).
  let event: any
  try {
    event = JSON.parse(rawBody)
  } catch {
    await logStripeEvent({
      locationSlug: null,
      sessionId: null,
      status: 'error',
      detail: 'error=bad_json — signature-valid body failed JSON.parse',
    })
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }

  const session = extractCheckoutSession(event)
  if (!session) {
    await logStripeEvent({
      locationSlug: null,
      sessionId: null,
      status: 'error',
      detail: `error=bad_envelope type=${event?.type || 'unknown'}`,
    })
    return NextResponse.json({ ok: true, skipped: 'bad_envelope' })
  }

  const {
    eventId, eventType, sessionId, paymentIntentId, clientReferenceId,
    tier, amountTotal, currency, paymentStatus,
  } = session

  // Payment failed (async methods like bank debit) — alert, acknowledge.
  if ((STRIPE_FAILURE_EVENTS as readonly string[]).includes(eventType)) {
    const loc = isUuid(clientReferenceId) ? await getLocationBilling(clientReferenceId) : null
    await logStripeEvent({
      locationSlug: loc?.location_id ?? null,
      sessionId,
      status: 'error',
      detail: `error=async_payment_failed tier=${tier || 'unknown'} amount=${dollars(amountTotal)}`,
    })
    await postSlackMessage(
      `⚠️ Stripe payment FAILED (async): ${dollars(amountTotal)} — ${loc?.name || clientReferenceId || 'unknown location'} — ${tier || '?'} seat. No seat was granted.`,
    )
    return NextResponse.json({ ok: true, processed: false, failure: 'async_payment_failed' })
  }

  // Anything that isn't a checkout completion — acknowledge + log so a
  // widened Stripe event selection never causes retry storms.
  if (!(STRIPE_ACTIVATING_EVENTS as readonly string[]).includes(eventType)) {
    await logStripeEvent({
      locationSlug: null,
      sessionId,
      status: 'success',
      detail: `— skipped: unhandled event type=${eventType}`,
    })
    return NextResponse.json({ ok: true, skipped: 'unhandled_event_type' })
  }

  // Async payment still pending — the async_payment_succeeded event
  // arrives later and does the real work.
  if (paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
    await logStripeEvent({
      locationSlug: null,
      sessionId,
      status: 'success',
      detail: `— awaiting async payment (payment_status=${paymentStatus || 'unknown'})`,
    })
    return NextResponse.json({ ok: true, pending: true })
  }

  // 4. Layer-1 idempotency: seen this event id before → replay no-op.
  // The row is written AFTER successful processing (see bottom), so a
  // delivery that died mid-way is absent here and gets fully re-run —
  // layer-2 makes that re-run safe.
  const { data: priorEvent, error: replayReadErr } = await supabaseService
    .from('stripe_webhook_events')
    .select('event_id')
    .eq('event_id', eventId)
    .maybeSingle()
  if (replayReadErr) {
    // Most likely the stripe_webhook_events migration hasn't been applied.
    // Fail closed — Stripe retries until the table exists.
    console.error('[stripe-webhook] stripe_webhook_events read failed —', replayReadErr.message)
    return NextResponse.json(
      { error: 'events_table_unavailable', detail: 'apply migrations/stripe_webhook_events.sql' },
      { status: 500 },
    )
  }
  if (priorEvent) {
    return NextResponse.json({ ok: true, replay: true })
  }

  // 5. Map to a location.
  if (!isUuid(clientReferenceId)) {
    await logStripeEvent({
      locationSlug: null,
      sessionId,
      status: 'error',
      detail: `error=missing_client_reference_id tier=${tier || 'unknown'} amount=${dollars(amountTotal)}`,
    })
    await postSlackMessage(
      `⚠️ Stripe payment received but NOT applied: ${dollars(amountTotal)} — no client_reference_id on session ${sessionId || '?'}. Was the link opened outside Bee Hub? Apply manually via Record Payment.`,
    )
    return NextResponse.json({ ok: true, skipped: 'missing_client_reference_id' })
  }

  const location: LocationBillingRow | null = await getLocationBilling(clientReferenceId)
  if (!location) {
    await logStripeEvent({
      locationSlug: null,
      sessionId,
      status: 'error',
      detail: `error=unknown_location client_reference_id=${clientReferenceId} amount=${dollars(amountTotal)}`,
    })
    await postSlackMessage(
      `⚠️ Stripe payment received but NOT applied: ${dollars(amountTotal)} — client_reference_id ${clientReferenceId} matches no location (session ${sessionId || '?'}).`,
    )
    return NextResponse.json({ ok: true, skipped: 'unknown_location' })
  }

  // …and a tier (Kevin sets metadata.tier on each Payment Link).
  if (!tier || !VALID_TIERS.includes(tier)) {
    await logStripeEvent({
      locationSlug: location.location_id,
      sessionId,
      status: 'error',
      detail: `error=missing_or_invalid_tier tier=${tier || 'none'} amount=${dollars(amountTotal)}`,
    })
    await postSlackMessage(
      `⚠️ Stripe payment received but NOT applied: ${dollars(amountTotal)} from ${location.name || location.id} — the Payment Link has no valid \`tier\` metadata (got "${tier || 'none'}"). Fix the link in the Stripe dashboard and apply this payment via Record Payment (session ${sessionId || '?'}).`,
    )
    return NextResponse.json({ ok: true, skipped: 'missing_tier' })
  }

  // Quantity: links are quantity-adjustable in Stripe, and the session
  // payload omits line items — so seat count = amount_total ÷ the tier's
  // per-seat price (which each link's unit price must match; see
  // deriveSeatQuantity). Uneven division → 1 seat + a loud warning.
  const { data: tierRow } = await supabaseService
    .from('tier_prices')
    .select('*')
    .eq('id', tier)
    .maybeSingle()
  const annualCents = tierRow?.price_annual != null ? tierRow.price_annual * 100 : null
  const { quantity, uneven } = deriveSeatQuantity(amountTotal, annualCents)
  let amountNote = ''
  if (uneven) {
    amountNote = ` (⚠️ ${dollars(amountTotal)} doesn't divide by the ${dollars(annualCents)}/seat tier price — treated as quantity 1; check the link's unit price vs Admin > Pricing)`
  }
  if (currency && currency !== 'usd') amountNote += ` currency=${currency}`

  // 6. Business writes — idempotent, so a 500 → Stripe retry converges.
  const isActivation = location.subscription_status !== 'active' && tier === 'owner'
  try {
    if (isActivation) {
      const paidThrough = nextRenewalDateString()
      const invoiceOutcome = await recordStripeInvoice({
        locationId: location.id,
        amountCents: amountTotal ?? 0,
        currency,
        sessionId,
        paymentIntentId,
        memo: `Stripe checkout — subscription activation (owner seat)${amountNote}`,
        periodEnd: paidThrough,
      })
      const owner = await getPrimaryOwnerForLocation(location.id)
      const result = await activateLocationSubscription({
        locationId: location.id,
        ownerUserId: owner?.id ?? null,
        proratedCostCents: amountTotal,
        paidThroughDate: paidThrough,
        seatNotes: sessionId ? `Paid via Stripe checkout (stripe_session=${sessionId})` : 'Paid via Stripe checkout',
      })

      // Landed = the location actually reads back active.
      const after = await getLocationBilling(location.id)
      const landed = after?.subscription_status === 'active' ? 'landed' : 'not_landed'

      await logStripeEvent({
        locationSlug: location.location_id,
        sessionId,
        status: 'success',
        detail: `tier=owner amount=${dollars(amountTotal)} — activation${result.alreadyActive ? ' (already active)' : ''}${invoiceOutcome === 'duplicate' ? ' invoice=duplicate' : ''}${amountNote}`,
        landed,
      })
      await postSlackMessage(
        result.alreadyActive && invoiceOutcome === 'inserted'
          ? `⚠️ Stripe payment ${dollars(amountTotal)} from ${location.name || location.id} — location was ALREADY active. Possible duplicate activation payment; refund from the Stripe dashboard if so.`
          : `💰 Stripe payment: ${dollars(amountTotal)} — ${location.name || location.id} — subscription activated (paid through ${paidThrough}).${amountNote}`,
      )
    } else {
      const invoiceOutcome = await recordStripeInvoice({
        locationId: location.id,
        amountCents: amountTotal ?? 0,
        currency,
        sessionId,
        paymentIntentId,
        memo: `Stripe checkout — ${quantity} × ${tier} seat${quantity === 1 ? '' : 's'}${amountNote}`,
      })
      const seatResult = await addStripePurchasedSeats({
        locationId: location.id,
        tier,
        quantity,
        perSeatCents: annualCents ?? amountTotal,
        sessionId,
      })

      const landed = seatResult.seats.length > 0 || seatResult.deduped ? 'landed' : 'not_landed'
      const oddState =
        location.subscription_status !== 'active'
          ? ' — NOTE: location is not active; seat purchased pre-activation'
          : ''

      await logStripeEvent({
        locationSlug: location.location_id,
        sessionId,
        status: seatResult.ownerCapHit || uneven ? 'error' : 'success',
        detail: `tier=${tier} qty=${quantity} amount=${dollars(amountTotal)} — seat purchase${seatResult.deduped ? ' (replay, seats exist)' : ''}${seatResult.ownerCapHit ? ' error=owner_cap_reached' : ''}${invoiceOutcome === 'duplicate' ? ' invoice=duplicate' : ''}${oddState}${amountNote}`,
        landed,
      })

      if (seatResult.ownerCapHit) {
        await postSlackMessage(
          `⚠️ Stripe payment ${dollars(amountTotal)} from ${location.name || location.id} for OWNER seat(s), but the 2-owner cap blocks the grant. Payment recorded, NO seat created — refund or resolve manually.`,
        )
      } else if (!seatResult.deduped) {
        await postSlackMessage(
          `💰 Stripe payment: ${dollars(amountTotal)} — ${location.name || location.id} — ${quantity} ${tier} seat${quantity === 1 ? '' : 's'} added to the pool.${oddState}${amountNote}`,
        )
      }
    }
  } catch (err: any) {
    console.error(`[stripe-webhook] handler_failed session=${sessionId}`, err)
    await logStripeEvent({
      locationSlug: location.location_id,
      sessionId,
      status: 'error',
      detail: `tier=${tier} amount=${dollars(amountTotal)} error=${String(err?.message || err).slice(0, 300)}`,
    })
    // 500 on purpose — Stripe retries, and every write above is idempotent.
    return NextResponse.json({ error: 'handler_failed' }, { status: 500 })
  }

  // 7. Mark the event processed (layer-1 replay short-circuit). A 23505
  // race with a concurrent duplicate delivery is harmless — both sides
  // were idempotent. Any other failure is logged but not retried: the
  // business writes above already landed.
  const { error: eventInsertErr } = await supabaseService.from('stripe_webhook_events').insert({
    event_id: eventId,
    type: eventType,
    session_id: sessionId,
    payment_intent_id: paymentIntentId,
    location_id: location.id,
    tier,
    amount_cents: amountTotal,
    payload: event,
  })
  if (eventInsertErr && (eventInsertErr as any).code !== '23505') {
    console.error('[stripe-webhook] event audit insert failed —', eventInsertErr.message)
  }

  return NextResponse.json({ ok: true, processed: true, activation: isActivation })
}
