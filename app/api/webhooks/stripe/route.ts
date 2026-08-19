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
  extractInvoiceEvent,
  extractSubscriptionEvent,
  deriveSeatQuantity,
  isUuid,
  STRIPE_ACTIVATING_EVENTS,
  STRIPE_FAILURE_EVENTS,
  STRIPE_INVOICE_EVENTS,
  STRIPE_SUBSCRIPTION_EVENTS,
} from '@/lib/stripe-webhook'
import {
  activateLocationSubscription,
  addSeatsForPlan,
  addStripePurchasedSeats,
  advancePaidThroughDate,
  getLocationBilling,
  getLocationByStripeSubscriptionId,
  annualRenewalFromSignupString,
  recordStripeInvoice,
  seatPlanMarker,
  setLocationSubscriptionStatus,
  writeLocationStripeIds,
  type LocationBillingRow,
} from '@/lib/subscription-activation'
import { decodeSeatPlan, planBillingLines } from '@/lib/seat-plan'
import { stripeConfigured } from '@/lib/stripe'
import {
  retrieveSubscription,
  subscriptionPeriodEndUnix,
  unixToDateString,
} from '@/lib/stripe-billing'

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

  // ── Dispatch subscription-lifecycle events (issue 161) ────────
  // Renewals + card failures (invoice.*) and cancellation / out-of-band
  // changes (customer.subscription.*) are not checkout sessions — route
  // them to their own handlers before the checkout-session extraction.
  // These previously fell through as unhandled_event_type.
  if ((STRIPE_INVOICE_EVENTS as readonly string[]).includes(event?.type)) {
    return handleInvoiceEvent(event)
  }
  if ((STRIPE_SUBSCRIPTION_EVENTS as readonly string[]).includes(event?.type)) {
    return handleSubscriptionEvent(event)
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
    tier, amountTotal, currency, paymentStatus, subscriptionId, customerId,
    seatPlan: encodedSeatPlan,
  } = session

  // Payment failed (async methods like ACH bank debit) — issue 197.
  //
  // The bank transfer bounced, days after checkout.session.completed fired
  // as UNPAID. DECISION: never auto-deactivate. An ACH failure is often
  // transient (insufficient funds today, a retryable R01), and for a
  // location Kevin already force-activated — or one a prior async success
  // activated — silently revoking access mid-work would strand a real,
  // working customer over a bounce that may clear on the next attempt.
  // So we leave the location exactly as it is and alert a human with its
  // CURRENT state, who decides whether to chase payment or wind it down.
  //
  // Idempotent like every other path: this now runs THROUGH the replay
  // guard and records the event, so a Stripe redelivery is a silent no-op
  // instead of a duplicate Slack ping. (It previously returned before the
  // layer-1 guard and re-alerted on every redelivery.)
  if ((STRIPE_FAILURE_EVENTS as readonly string[]).includes(eventType)) {
    const replay = await eventAlreadyProcessed(eventId)
    if (replay.tableError) {
      return NextResponse.json({ error: 'events_table_unavailable' }, { status: 500 })
    }
    if (replay.replay) return NextResponse.json({ ok: true, replay: true })

    const loc = isUuid(clientReferenceId) ? await getLocationBilling(clientReferenceId) : null
    const status = loc?.subscription_status ?? 'unknown'
    // Active-with-no-money is the state that needs a human: the seat exists
    // (forced or auto-activated) but the payment never cleared.
    const activeWithNoMoney = loc?.subscription_status === 'active'
    await logStripeEvent({
      locationSlug: loc?.location_id ?? null,
      sessionId,
      status: 'error',
      detail: `error=async_payment_failed tier=${tier || 'unknown'} amount=${dollars(amountTotal)} location_status=${status} — access retained, no auto-deactivation (issue 197)`,
    })
    await postSlackMessage(
      activeWithNoMoney
        ? `⚠️ Stripe ACH payment FAILED — ${loc?.name || clientReferenceId || 'unknown location'} (${dollars(amountTotal)}, ${tier || '?'} seat). This location is ACTIVE but the bank transfer did NOT clear, so it is running with no collected payment. Access is NOT being revoked automatically — decide whether to have them retry payment or wind it down.`
        : `⚠️ Stripe ACH payment FAILED — ${loc?.name || clientReferenceId || 'unknown location'} (${dollars(amountTotal)}, ${tier || '?'} seat). The location was NOT activated (status=${status}); no seat granted. They'll need to pay again to proceed.`,
    )

    // Record the event so a redelivery short-circuits at the replay guard
    // above. location_id is nullable in stripe_webhook_events, so an
    // unmapped failure still records.
    await markEventProcessed({
      event_id: eventId,
      type: eventType,
      session_id: sessionId,
      payment_intent_id: paymentIntentId,
      location_id: loc?.id ?? null,
      tier: tier ?? null,
      amount_cents: amountTotal,
      payload: event,
    })
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
  //
  // issue 312: this row is the ONLY trace a pending checkout leaves. No
  // business write happens on this path and no stripe_webhook_events row is
  // written (the replay guard is below), so nothing else in the system knows
  // an owner just paid and got nothing. That makes it the strand detector —
  // and a detector has to name who is stranded. It previously logged
  // locationSlug:null, so the row could not be joined to the owner sitting on
  // the spinner; that blindness is exactly why the strand was invisible.
  // Resolve the location here: one read, no writes, on a path that today does
  // no DB work at all. When the reference is unmappable we still say so in the
  // message — an unmappable pending session is doubly silent otherwise, since
  // this branch returns BEFORE the missing_client_reference_id alert below.
  if (paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
    const pendingLocation = isUuid(clientReferenceId)
      ? await getLocationBilling(clientReferenceId)
      : null
    await logStripeEvent({
      locationSlug: pendingLocation?.location_id ?? null,
      sessionId,
      status: 'success',
      detail:
        `— awaiting async payment (payment_status=${paymentStatus || 'unknown'})` +
        (pendingLocation ? '' : ` client_reference_id=${clientReferenceId || 'none'}`),
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
  //
  // issue 182: a subscription-mode checkout (subscriptionId present) for a
  // location that is ALREADY active, at the owner tier, is the "checkout link
  // for an active location" — the owner just put a card on file and Stripe
  // anchored the first invoice to paid_through_date. It exists ONLY to attach
  // billing to a live, already-seated location. So we persist the Stripe ids
  // and STOP: we must NOT re-run activation (subscription_started_at is already
  // stamped, the owner + manager seats already exist) and must NOT add a seat
  // (the else branch below would otherwise mint a duplicate owner ghost seat
  // and skip writing the ids entirely). The first real charge arrives later on
  // the anchor date as invoice.paid and is handled by handleInvoiceEvent, which
  // maps back to this location by the stripe_subscription_id we write here.
  //
  // This is uniquely identifiable: additional post-activation seats are added
  // as line items on the EXISTING subscription (adjustSubscriptionSeatQuantity),
  // never as a NEW subscription-mode checkout — so an active + owner + brand-new
  // subscription can only be this link, never a seat purchase.
  const isActiveSubscriptionLink =
    location.subscription_status === 'active' && tier === 'owner' && !!subscriptionId
  const isActivation = location.subscription_status !== 'active' && tier === 'owner'
  // issue 197: the SAME already-active + owner + subscription shape is reached
  // by two different events. checkout.session.completed is the issue-182
  // active-location link (card on file, $0 today). async_payment_succeeded is
  // an ACH transfer CLEARING on a location Kevin already force-activated — the
  // money actually arrived. The DB writes are identical (fill in the missing
  // subscription id; add no seat; do not re-activate), but the operator-facing
  // messaging must not tell Kevin "no charge today" when a bank payment just
  // landed. The billing_invoices row for that payment is recorded by the
  // invoice.paid handler (billing_reason=subscription_create), which maps back
  // by the subscription id written here — recording it here too would double
  // the row, since a subscription session's own payment_intent is null and so
  // can't dedup against invoice.paid's real payment_intent.
  const isAsyncClearing = eventType === 'checkout.session.async_payment_succeeded'
  try {
    if (isActiveSubscriptionLink) {
      // Resolve the customer id from the session, falling back to the
      // subscription (covers a session payload that omitted it).
      let resolvedCustomerId: string | null = customerId
      if (!resolvedCustomerId && stripeConfigured()) {
        try {
          const sub = await retrieveSubscription(subscriptionId!)
          resolvedCustomerId =
            typeof sub.customer === 'string' ? sub.customer : (sub.customer as any)?.id ?? null
        } catch (e: any) {
          console.error('[stripe-webhook] issue182 subscription retrieve failed —', e?.message || e)
        }
      }

      // Write BOTH ids (idempotent; no-op on replay). No activation, no seat,
      // no invoice row — nothing was charged today, and paid_through stays put
      // until the anchor invoice advances it.
      await writeLocationStripeIds(location.id, {
        customerId: resolvedCustomerId,
        subscriptionId,
      })

      const after = await getLocationBilling(location.id)
      const landed = after?.stripe_subscription_id === subscriptionId ? 'landed' : 'not_landed'
      await logStripeEvent({
        locationSlug: location.location_id,
        sessionId,
        status: 'success',
        detail: isAsyncClearing
          ? `tier=owner — ACH cleared on already-active location (issue 197) sub=${subscriptionId} amount=${dollars(amountTotal)} — subscription id filled in, no seat, no re-activation; invoice recorded via invoice.paid`
          : `tier=owner — subscription linked to already-active location (issue 182) sub=${subscriptionId} anchor=paid_through(${location.paid_through_date || 'n/a'}) — no activation, no seat`,
        landed,
      })
      await postSlackMessage(
        isAsyncClearing
          ? `🏦 Stripe ACH payment cleared — ${location.name || location.id} (${dollars(amountTotal)}). This location was already active; subscription is now linked and the invoice is recorded. No second seat, no re-activation.`
          : `🔗 Stripe subscription linked — ${location.name || location.id} — card on file, billing starts ${location.paid_through_date || 'its paid-through date'} (already active; no charge today).`,
      )
    } else if (isActivation) {
      // Subscription-mode checkout (issue 161): the session created via the
      // Stripe API carries a subscription + customer. Anchor paid_through to
      // the subscription's REAL period end (signup + 1yr — Stripe sets the
      // billing_cycle_anchor at checkout), persist both ids, and let
      // invoice.paid record the billing_invoices row so the same activation
      // payment is never recorded twice.
      //
      // issue 162: the default (before we read the real period end, and for
      // the legacy one-time Payment-Link path that has no subscription) is
      // signup + 1yr — the location's own anniversary — NOT a fixed March 1.
      const hasSubscription = !!subscriptionId
      let paidThrough = annualRenewalFromSignupString()
      let resolvedCustomerId: string | null = customerId
      if (hasSubscription && stripeConfigured()) {
        try {
          const sub = await retrieveSubscription(subscriptionId!)
          const pe = subscriptionPeriodEndUnix(sub)
          if (pe) paidThrough = unixToDateString(pe) || paidThrough
          if (!resolvedCustomerId) {
            resolvedCustomerId =
              typeof sub.customer === 'string' ? sub.customer : (sub.customer as any)?.id ?? null
          }
        } catch (e: any) {
          console.error('[stripe-webhook] subscription retrieve failed —', e?.message || e)
        }
      }

      // Persist the Stripe ids — the write path locations.stripe_customer_id /
      // stripe_subscription_id were waiting for (idempotent; no-op on replay).
      if (subscriptionId || resolvedCustomerId) {
        await writeLocationStripeIds(location.id, {
          customerId: resolvedCustomerId,
          subscriptionId,
        })
      }

      // Only the legacy one-time payment is recorded here; subscription
      // payments are recorded by the invoice.paid handler.
      let invoiceOutcome: 'inserted' | 'duplicate' | 'skipped_zero_amount' = 'skipped_zero_amount'
      if (!hasSubscription) {
        invoiceOutcome = await recordStripeInvoice({
          locationId: location.id,
          amountCents: amountTotal ?? 0,
          currency,
          sessionId,
          paymentIntentId,
          memo: `Stripe checkout — subscription activation (owner seat)${amountNote}`,
          periodEnd: paidThrough,
        })
      }
      const owner = await getPrimaryOwnerForLocation(location.id)
      const result = await activateLocationSubscription({
        locationId: location.id,
        ownerUserId: owner?.id ?? null,
        proratedCostCents: amountTotal,
        paidThroughDate: paidThrough,
        seatNotes: sessionId ? `Paid via Stripe checkout (stripe_session=${sessionId})` : 'Paid via Stripe checkout',
      })

      // ── issue 212: create the seats this session actually billed ──
      // activateLocationSubscription made exactly ONE owner seat. If the owner
      // bought more than that, the rest come from the plan the checkout route
      // stamped on the SESSION — not from client state, which is gone by now,
      // and not from dividing amount_total by a unit price, which cannot tell
      // a co-owner (owner seat on the manager price) from a Hive Manager.
      // Absent metadata (a pre-212 session, a Payment Link) → no add-ons, i.e.
      // exactly today's behavior.
      let seatPlanNote = ''
      const decodedPlan = decodeSeatPlan(encodedSeatPlan)
      if (decodedPlan) {
        // Price each add-on row at the rate it was billed, from the same
        // tier_prices catalog the checkout route priced the session with.
        const { data: allTierRows } = await supabaseService.from('tier_prices').select('*')
        const unitCentsByTier: Record<string, number> = {}
        for (const r of allTierRows || []) {
          const annual = (r as any)?.price_annual
          if (typeof annual === 'number') unitCentsByTier[(r as any).id] = annual * 100
        }
        try {
          const planned = await addSeatsForPlan({
            locationId: location.id,
            plan: decodedPlan,
            marker: seatPlanMarker('session', sessionId || location.id),
            unitCentsByTier,
            noteLabel: 'Purchased via Stripe checkout (issue 212 seat plan)',
          })
          const billed = planBillingLines(decodedPlan)
            .map((l) => `${l.billingTier}×${l.quantity}`)
            .join(' + ')
          seatPlanNote = planned.deduped
            ? ` seat_plan=${encodedSeatPlan} (replay — seats already created)`
            : planned.ownerCapHit
              ? ` ⚠️ seat_plan=${encodedSeatPlan} REFUSED — would exceed the 2-owner cap; seats NOT created`
              : ` seat_plan=${encodedSeatPlan} billed=[${billed}] extra_seats=${planned.seats.length}`
          if (planned.ownerCapHit) {
            await postSlackMessage(
              `⚠️ ${location.name || location.id} paid for ${encodedSeatPlan} but the extra owner seat would exceed the 2-owner cap — the seat was NOT created. Money was collected; reconcile by hand.`,
            )
          }
        } catch (e: any) {
          // The payment landed and the location is active. Returning 500 here
          // makes Stripe retry, and every write above is idempotent, so the
          // retry converges rather than double-charging or double-seating.
          console.error('[stripe-webhook] issue 212 seat plan insert failed —', e?.message || e)
          await logStripeEvent({
            locationSlug: location.location_id,
            sessionId,
            status: 'error',
            detail: `error=seat_plan_insert_failed seat_plan=${encodedSeatPlan} — ${String(e?.message || e).slice(0, 200)}`,
          })
          await postSlackMessage(
            `🚨 ${location.name || location.id} paid for ${encodedSeatPlan} but the extra seats could not be created. Stripe will retry; if this persists the owner is short seats she paid for.`,
          )
          return NextResponse.json({ error: 'seat_plan_insert_failed' }, { status: 500 })
        }
      }

      // Landed = the location actually reads back active.
      const after = await getLocationBilling(location.id)
      const landed = after?.subscription_status === 'active' ? 'landed' : 'not_landed'

      await logStripeEvent({
        locationSlug: location.location_id,
        sessionId,
        status: 'success',
        detail: `tier=owner amount=${dollars(amountTotal)} — activation${result.alreadyActive ? ' (already active)' : ''}${hasSubscription ? ` sub=${subscriptionId}` : ''}${invoiceOutcome === 'duplicate' ? ' invoice=duplicate' : ''}${seatPlanNote}${amountNote}`,
        landed,
      })
      await postSlackMessage(
        result.alreadyActive && !hasSubscription && invoiceOutcome === 'inserted'
          ? `⚠️ Stripe payment ${dollars(amountTotal)} from ${location.name || location.id} — location was ALREADY active. Possible duplicate activation payment; refund from the Stripe dashboard if so.`
          : `💰 Stripe payment: ${dollars(amountTotal)} — ${location.name || location.id} — subscription activated (paid through ${paidThrough}).${seatPlanNote}${amountNote}`,
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

// ── Shared layer-1 replay guard (issue 161) ───────────────────
// Same two-layer idempotency the checkout path uses: a seen event id
// short-circuits; the row is written only AFTER successful processing so
// a delivery that died mid-way re-runs (business writes below are idempotent).
async function eventAlreadyProcessed(
  eventId: string,
): Promise<{ replay: boolean; tableError: boolean }> {
  const { data, error } = await supabaseService
    .from('stripe_webhook_events')
    .select('event_id')
    .eq('event_id', eventId)
    .maybeSingle()
  if (error) {
    console.error('[stripe-webhook] stripe_webhook_events read failed —', error.message)
    return { replay: false, tableError: true }
  }
  return { replay: !!data, tableError: false }
}

async function markEventProcessed(row: Record<string, any>) {
  const { error } = await supabaseService.from('stripe_webhook_events').insert(row)
  if (error && (error as any).code !== '23505') {
    console.error('[stripe-webhook] event audit insert failed —', error.message)
  }
}

// ── invoice.paid / invoice.payment_failed (issue 161) ─────────
// Renewal (advance paid_through_date) and card failure (mark past_due).
// Also records the activation/renewal invoice — the ONLY place a
// subscription payment lands in billing_invoices (the checkout path defers
// to here to avoid a double row). Maps to a location by stored
// stripe_subscription_id, falling back to the subscription's
// metadata.location_id when invoice.paid races ahead of checkout completion.
async function handleInvoiceEvent(event: any) {
  const inv = extractInvoiceEvent(event)
  if (!inv) {
    await logStripeEvent({
      locationSlug: null, sessionId: null, status: 'error',
      detail: `error=bad_invoice_envelope type=${event?.type || 'unknown'}`,
    })
    return NextResponse.json({ ok: true, skipped: 'bad_envelope' })
  }
  const {
    eventId, eventType, subscriptionId, customerId,
    amountPaid, currency, paymentIntentId, billingReason, invoiceId,
  } = inv

  const replay = await eventAlreadyProcessed(eventId)
  if (replay.tableError) {
    return NextResponse.json({ error: 'events_table_unavailable' }, { status: 500 })
  }
  if (replay.replay) return NextResponse.json({ ok: true, replay: true })

  if (!subscriptionId) {
    await logStripeEvent({
      locationSlug: null, sessionId: invoiceId, status: 'success',
      detail: `— skipped: ${eventType} has no subscription (reason=${billingReason || 'n/a'})`,
    })
    return NextResponse.json({ ok: true, skipped: 'no_subscription' })
  }

  // Resolve location. Prefer the stored id; fall back to the subscription's
  // metadata.location_id (covers the first-cycle race + a not-yet-stored id).
  let location = await getLocationByStripeSubscriptionId(subscriptionId)
  let sub: any = null
  try {
    sub = await retrieveSubscription(subscriptionId)
  } catch (e: any) {
    console.error('[stripe-webhook] invoice sub retrieve failed —', e?.message || e)
  }
  if (!location) {
    const hint = sub?.metadata?.location_id
    if (isUuid(hint)) {
      location = await getLocationBilling(hint)
      if (location) {
        await writeLocationStripeIds(location.id, { subscriptionId, customerId })
      }
    }
  }
  if (!location) {
    await logStripeEvent({
      locationSlug: null, sessionId: invoiceId, status: 'error',
      detail: `error=unknown_subscription sub=${subscriptionId} ${eventType} amount=${dollars(amountPaid)}`,
    })
    await postSlackMessage(
      `⚠️ Stripe ${eventType} for subscription ${subscriptionId} matched no location (${dollars(amountPaid)}). Was it created outside Bee Hub?`,
    )
    return NextResponse.json({ ok: true, skipped: 'unknown_subscription' })
  }

  try {
    if (eventType === 'invoice.payment_failed') {
      await setLocationSubscriptionStatus(location.id, 'past_due')
      await logStripeEvent({
        locationSlug: location.location_id, sessionId: invoiceId, status: 'error',
        detail: `error=payment_failed sub=${subscriptionId} amount=${dollars(amountPaid)} — marked past_due`,
        landed: 'landed',
      })
      await postSlackMessage(
        `⚠️ Stripe payment FAILED — ${location.name || location.id} marked past_due (${dollars(amountPaid)}). Owner must update their card in the billing portal.`,
      )
    } else {
      // invoice.paid — advance the renewal window and record the payment.
      const pe = subscriptionPeriodEndUnix(sub) ?? inv.periodEnd
      const newDate = unixToDateString(pe)
      const advanced = await advancePaidThroughDate(location.id, newDate)
      // A recovered card flips past_due back to active.
      if (location.subscription_status === 'past_due') {
        await setLocationSubscriptionStatus(location.id, 'active')
      }
      let invoiceOutcome: 'inserted' | 'duplicate' | 'skipped_zero_amount' = 'skipped_zero_amount'
      if (amountPaid && amountPaid > 0) {
        invoiceOutcome = await recordStripeInvoice({
          locationId: location.id,
          amountCents: amountPaid,
          currency,
          // issue 163: this row IS a Stripe invoice — populate the dedicated
          // stripe_invoice_id column (not just reference_number). No checkout
          // session is involved here, so sessionId is null.
          sessionId: null,
          invoiceId,
          paymentIntentId,
          memo: `Stripe ${billingReason === 'subscription_create' ? 'subscription activation' : 'renewal'} (${billingReason || 'invoice.paid'})`,
          periodEnd: newDate,
        })
      }
      await logStripeEvent({
        locationSlug: location.location_id, sessionId: invoiceId, status: 'success',
        detail: `${billingReason || 'invoice.paid'} sub=${subscriptionId} amount=${dollars(amountPaid)} paid_through=${newDate || 'unchanged'}${invoiceOutcome === 'duplicate' ? ' invoice=duplicate' : ''}`,
        landed: advanced || location.paid_through_date ? 'landed' : 'not_landed',
      })
      // Slack for real money moving: the annual renewal AND mid-cycle seat
      // charges (subscription_update = the always_invoice proration when a
      // seat is added). Keep both owner-legible; don't let seat charges land
      // silently in the ledger. (issue 161)
      if (billingReason === 'subscription_cycle') {
        await postSlackMessage(
          `💰 Stripe renewal: ${dollars(amountPaid)} — ${location.name || location.id} — paid through ${newDate || '?'}.`,
        )
      } else if (billingReason === 'subscription_update') {
        await postSlackMessage(
          `💰 Stripe seat charge: ${dollars(amountPaid)} — ${location.name || location.id} — prorated mid-cycle seat.`,
        )
      }
    }
  } catch (err: any) {
    console.error(`[stripe-webhook] invoice handler_failed inv=${invoiceId}`, err)
    await logStripeEvent({
      locationSlug: location.location_id, sessionId: invoiceId, status: 'error',
      detail: `${eventType} sub=${subscriptionId} error=${String(err?.message || err).slice(0, 300)}`,
    })
    return NextResponse.json({ error: 'handler_failed' }, { status: 500 })
  }

  await markEventProcessed({
    event_id: eventId, type: eventType, session_id: invoiceId,
    payment_intent_id: paymentIntentId, location_id: location.id,
    tier: null, amount_cents: amountPaid, payload: event,
  })
  return NextResponse.json({ ok: true, processed: true })
}

// ── customer.subscription.updated / .deleted (issue 161) ──────
// deleted → cancellation (Portal or dunning) flips the location to
// 'canceled'. updated → reflect Stripe's status (past_due / recovered) and
// advance paid_through. Deliberately does NOT activate a 'deferred'
// location — activation is the checkout path's job through the shared
// activateLocationSubscription; here we only track an ALREADY-active
// subscription's lifecycle.
async function handleSubscriptionEvent(event: any) {
  const s = extractSubscriptionEvent(event)
  if (!s) {
    await logStripeEvent({
      locationSlug: null, sessionId: null, status: 'error',
      detail: `error=bad_subscription_envelope type=${event?.type || 'unknown'}`,
    })
    return NextResponse.json({ ok: true, skipped: 'bad_envelope' })
  }
  const { eventId, eventType, subscriptionId, customerId, status, periodEnd, locationHint } = s

  const replay = await eventAlreadyProcessed(eventId)
  if (replay.tableError) {
    return NextResponse.json({ error: 'events_table_unavailable' }, { status: 500 })
  }
  if (replay.replay) return NextResponse.json({ ok: true, replay: true })

  if (!subscriptionId) {
    await logStripeEvent({
      locationSlug: null, sessionId: null, status: 'success',
      detail: `— skipped: ${eventType} missing subscription id`,
    })
    return NextResponse.json({ ok: true, skipped: 'missing_subscription_id' })
  }

  let location = await getLocationByStripeSubscriptionId(subscriptionId)
  if (!location && isUuid(locationHint)) {
    location = await getLocationBilling(locationHint)
    if (location) await writeLocationStripeIds(location.id, { subscriptionId, customerId })
  }
  if (!location) {
    await logStripeEvent({
      locationSlug: null, sessionId: subscriptionId, status: 'error',
      detail: `error=unknown_subscription sub=${subscriptionId} ${eventType}`,
    })
    return NextResponse.json({ ok: true, skipped: 'unknown_subscription' })
  }

  try {
    if (eventType === 'customer.subscription.deleted') {
      await setLocationSubscriptionStatus(location.id, 'canceled')
      await logStripeEvent({
        locationSlug: location.location_id, sessionId: subscriptionId, status: 'success',
        detail: `subscription deleted sub=${subscriptionId} — marked canceled`, landed: 'landed',
      })
      await postSlackMessage(
        `🚫 Stripe subscription canceled — ${location.name || location.id} marked canceled. Access continues until paid_through (${location.paid_through_date || 'n/a'}).`,
      )
    } else {
      // updated — reflect status transitions we track, never activating a
      // deferred location out from under the activation path.
      if (status === 'past_due') {
        await setLocationSubscriptionStatus(location.id, 'past_due')
      } else if (status === 'canceled') {
        await setLocationSubscriptionStatus(location.id, 'canceled')
      } else if (status === 'active' && location.subscription_status === 'past_due') {
        await setLocationSubscriptionStatus(location.id, 'active')
      }
      const newDate = unixToDateString(periodEnd)
      if (newDate) await advancePaidThroughDate(location.id, newDate)
      await logStripeEvent({
        locationSlug: location.location_id, sessionId: subscriptionId, status: 'success',
        detail: `subscription updated sub=${subscriptionId} stripe_status=${status || '?'} paid_through=${newDate || 'unchanged'}`,
        landed: 'landed',
      })
    }
  } catch (err: any) {
    console.error(`[stripe-webhook] subscription handler_failed sub=${subscriptionId}`, err)
    await logStripeEvent({
      locationSlug: location.location_id, sessionId: subscriptionId, status: 'error',
      detail: `${eventType} sub=${subscriptionId} error=${String(err?.message || err).slice(0, 300)}`,
    })
    return NextResponse.json({ error: 'handler_failed' }, { status: 500 })
  }

  await markEventProcessed({
    event_id: eventId, type: eventType, session_id: subscriptionId,
    payment_intent_id: null, location_id: location.id,
    tier: null, amount_cents: null, payload: event,
  })
  return NextResponse.json({ ok: true, processed: true })
}
