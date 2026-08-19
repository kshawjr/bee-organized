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
//   3. Parse the event. checkout.session.completed activates REGARDLESS of
//      payment_status (issue 313 — an ACH checkout is always 'unpaid' at this
//      moment, and waiting for the bank cost four locations a hand-written
//      UPDATE). checkout.session.async_payment_succeeded is then a
//      CONFIRMATION on an already-active location, not a trigger.
//      async_payment_failed moves the location to past_due and alerts once;
//      everything else is acknowledged + logged.
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
import {
  achFailedLine,
  achInFlightLine,
  appendBillingNote,
  clearAchInFlight,
} from '@/lib/ach-in-flight'
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

  // Payment failed (async methods like ACH bank debit) — issues 197 + 313.
  //
  // The bank transfer bounced, days after checkout.session.completed fired as
  // UNPAID.
  //
  // ISSUE 197 DECIDED: never auto-deactivate. That decision was made when a
  // location reaching this handler had been let in by HAND, if at all —
  // revoking access over a bounce that may well clear on the next attempt
  // would have punished a real, working customer for Kevin's rescue.
  //
  // ISSUE 313 CHANGES THE INPUT, so the answer moves. Every ACH payer is now
  // activated automatically, up front, on money that has not settled. Leaving
  // this path as a pure alert would mean a location with a full year of access
  // that never paid a cent and never transitions anywhere — and the audit
  // already found money landing against a placeholder with nobody noticing.
  // Instant activation without a failure transition is not generous, it is a
  // hole.
  //
  // THE TRANSITION IS past_due, and it is deliberately the gentlest one the
  // existing machine offers. The machine is past_due (14-day grace, FULL
  // access) → paused (read-only, recoverable, lifecycle_status) → inactive.
  // past_due is right for four reasons:
  //
  //   1. It is what the state MEANS. classifyBillingState maps past_due to
  //      'payment_failed' — the one billing state that already says money was
  //      attempted and lost — and the admin UI already renders it.
  //   2. It preserves Kevin's decision. He chose to let ACH payers in without
  //      waiting for the money; jumping to `paused` would revoke that access
  //      the moment a bank returns a retryable R01, which is exactly the
  //      punishment issue 197 refused to inflict. The grace window is the
  //      point: the customer keeps working while a human collects.
  //   3. It is ALREADY the transition the card rail takes for the identical
  //      event — invoice.payment_failed sets past_due. One meaning, one state,
  //      whichever way the payment was attempted.
  //   4. Recovery is free. invoice.paid and customer.subscription.updated both
  //      already flip past_due back to active, so a retry that succeeds heals
  //      the location with no new code and no human step.
  //
  // Escalation past_due → paused → inactive stays a human decision; nothing
  // automates it today and this issue does not change that. past_due puts the
  // location at the TOP of that escalator instead of inventing a state or
  // skipping to the harshest one.
  //
  // Idempotent like every other path: this runs THROUGH the replay guard and
  // records the event, so a Stripe redelivery is a silent no-op rather than a
  // second Slack ping — that is what makes the alert exactly-once.
  if ((STRIPE_FAILURE_EVENTS as readonly string[]).includes(eventType)) {
    const replay = await eventAlreadyProcessed(eventId)
    if (replay.tableError) {
      return NextResponse.json({ error: 'events_table_unavailable' }, { status: 500 })
    }
    if (replay.replay) return NextResponse.json({ ok: true, replay: true })

    const loc = isUuid(clientReferenceId) ? await getLocationBilling(clientReferenceId) : null
    const status = loc?.subscription_status ?? 'unknown'
    // Active-with-no-money is the state that needs the transition: the seat
    // exists (issue 313 granted it up front) but the payment never cleared.
    const activeWithNoMoney = loc?.subscription_status === 'active'

    // The move. Only from 'active' — a location that is already past_due,
    // canceled or still deferred is not made worse by a second bounce, and
    // re-writing past_due over canceled would resurrect a wound-down account.
    let moved = false
    if (loc && activeWithNoMoney) {
      try {
        await setLocationSubscriptionStatus(loc.id, 'past_due')
        moved = true
      } catch (e: any) {
        console.error('[stripe-webhook] issue313 past_due flip failed —', e?.message || e)
      }
      // Close the in-flight audit line with the reason it closed. Best-effort:
      // the state transition above is the load-bearing write, and losing an
      // audit line must not cost us the alert or the event record below.
      try {
        await appendBillingNote(loc.id, achFailedLine({ amountCents: amountTotal, sessionId }))
      } catch (e: any) {
        console.error('[stripe-webhook] issue313 failed-note append failed —', e?.message || e)
      }
    }

    const after = loc ? await getLocationBilling(loc.id) : null
    await logStripeEvent({
      locationSlug: loc?.location_id ?? null,
      sessionId,
      status: 'error',
      detail:
        `error=async_payment_failed tier=${tier || 'unknown'} amount=${dollars(amountTotal)} ` +
        `location_status=${status}` +
        (moved
          ? ' → past_due (14-day grace, access retained — issue 313)'
          : ' — no transition (not active); access unchanged'),
      landed: moved ? (after?.subscription_status === 'past_due' ? 'landed' : 'not_landed') : 'na',
    })

    // ONE alert, on the ops rail (lib/slack postSlackMessage — the same
    // SLACK_WEBHOOK_URL channel issue 312's stranded-checkout alert posts to).
    // Not lib/slack-bot.ts: that is the per-location OAuth bot with its own
    // interactivity contract, and this is an ops message about billing, not a
    // lead card. Exactly one, because the replay guard above means a Stripe
    // redelivery never reaches this line.
    await postSlackMessage(
      moved
        ? `🚨 ACH payment FAILED — ${loc?.name || clientReferenceId || 'unknown location'} (${dollars(amountTotal)}, ${tier || '?'} seat). They were activated up front on this transfer and it did NOT clear, so they have a year of access and we have no money. Moved to *past_due*: full access continues through the 14-day grace window, and billing now reads "payment failed". Collect payment or wind it down before the window closes.`
        : activeWithNoMoney
          ? `⚠️ ACH payment FAILED — ${loc?.name || clientReferenceId || 'unknown location'} (${dollars(amountTotal)}, ${tier || '?'} seat). The location is ACTIVE with no collected payment, but the move to past_due did NOT stick — check the location's billing status by hand.`
          : `⚠️ ACH payment FAILED — ${loc?.name || clientReferenceId || 'unknown location'} (${dollars(amountTotal)}, ${tier || '?'} seat). Location status is ${status}, so nothing was changed. They'll need to pay again to proceed.`,
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
    return NextResponse.json({
      ok: true,
      processed: moved,
      failure: 'async_payment_failed',
      moved_to: moved ? 'past_due' : null,
    })
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

  // ── ISSUE 313: an unpaid ACH checkout activates NOW ───────────
  //
  // This branch used to return here — above the replay guard and every write —
  // whenever payment_status was not 'paid'. That is what an ACH bank debit
  // ALWAYS looks like at checkout time, so every bank payer was held deferred
  // until checkout.session.async_payment_succeeded arrived, which prod has
  // measured at SIX calendar days, twice. Four locations needed a hand-written
  // UPDATE to get in; two of them four hours apart on 2026-08-19.
  //
  // KEVIN'S DECISION: they get access immediately. So the pending short-circuit
  // is gone and an unpaid session falls through into the SAME activation the
  // card path takes — subscription id, paid_through_date, seats, the
  // subscription_started_at stamp, the lot. There is no separate ACH branch to
  // drift out of sync; there is one activation path and unpaid money no longer
  // diverts around it.
  //
  // WHAT REPLACES THE PENDING ROW. The old row was issue 312's strand detector
  // and it was the only trace a pending checkout left. It is not needed as a
  // detector any more — a strand is what happens when activation does NOT run,
  // and activation now always runs — but the FACT it carried, that this money
  // has not actually arrived, still matters and is recorded two ways below:
  // an [ACH_IN_FLIGHT] audit line on locations.billing_notes (lib/ach-in-flight)
  // and the absence of a billing_invoices row until invoice.paid lands. The
  // sync_log row still gets written; it now says the location was let in on
  // money in flight rather than that nothing happened.
  const moneyInFlight = paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required'

  // KEEP THE BREADCRUMB, DROP THE RETURN — and note what that does to 312.
  //
  // The row is written HERE, before any business write, exactly where it used
  // to be, and then execution CONTINUES into activation. Writing it first is
  // the point: if activation throws below, the route 500s and Stripe retries,
  // and if every retry fails this row is the only evidence an owner completed
  // checkout. That is the residual strand — no longer "the bank is slow", but
  // "our activation is broken" — and it is worth keeping a detector for.
  //
  // Issue 312's alert needs NO change to do that job, because its selector
  // already keys on ACTIVATION rather than settlement: a pending row whose
  // location is 'active' is skipped. So the normal 313 path (activate now,
  // money later) self-suppresses on the very next check, and the alert fires
  // only when activation genuinely did not happen. 312 goes from firing on
  // every bank payer to firing on a real fault — the same code, a much better
  // signal-to-noise ratio, and not a line of it deleted.
  //
  // The wording keeps the 'awaiting async payment' token that
  // fetchPendingCheckouts matches on, and says plainly that access was granted
  // so the row is not misread as a stuck owner.
  if (moneyInFlight) {
    const pendingLocation = isUuid(clientReferenceId)
      ? await getLocationBilling(clientReferenceId)
      : null
    await logStripeEvent({
      locationSlug: pendingLocation?.location_id ?? null,
      sessionId,
      status: 'success',
      detail:
        `— awaiting async payment (payment_status=${paymentStatus || 'unknown'}) ` +
        `— activating NOW anyway (issue 313); this row stays as the backstop if activation fails` +
        (pendingLocation ? '' : ` client_reference_id=${clientReferenceId || 'none'}`),
    })
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

      // ── issue 313: this event is now a CONFIRMATION, not a trigger ──
      // Activation already happened on checkout.session.completed, days ago,
      // so there is nothing here left to activate — and this branch has always
      // been the one that does NOT activate (no seat, no flip, no re-stamp of
      // subscription_started_at), which is precisely why an already-active
      // location falls into it and is a safe no-op rather than a double
      // activation. What the event genuinely adds is the answer to the only
      // open question: the money arrived. So close the in-flight marker.
      // clearAchInFlight is a no-op when nothing was in flight, which keeps
      // the pre-313 force-activated shape (Boston, West Raleigh) unchanged.
      let clearedInFlight = false
      if (isAsyncClearing) {
        try {
          clearedInFlight = await clearAchInFlight(location.id, {
            amountCents: amountTotal,
            subscriptionId,
          })
        } catch (e: any) {
          console.error('[stripe-webhook] issue313 clear-in-flight failed —', e?.message || e)
        }
      }

      const after = await getLocationBilling(location.id)
      const landed = after?.stripe_subscription_id === subscriptionId ? 'landed' : 'not_landed'
      await logStripeEvent({
        locationSlug: location.location_id,
        sessionId,
        status: 'success',
        detail: isAsyncClearing
          ? `tier=owner — ACH cleared on already-active location (issue 197) sub=${subscriptionId} amount=${dollars(amountTotal)} — subscription id filled in, no seat, no re-activation; invoice recorded via invoice.paid${clearedInFlight ? ' payment_state=settled (was in_flight, issue 313)' : ''}`
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
        seatNotes: sessionId
          ? `Paid via Stripe checkout (stripe_session=${sessionId})${moneyInFlight ? ' — payment not yet settled at activation (issue 313)' : ''}`
          : 'Paid via Stripe checkout',
      })

      // ── issue 313: record that the money has not actually arrived ──
      // The location is now active, seated and paid-through on the strength of
      // a bank debit that has not settled. Without this line nothing anywhere
      // distinguishes it from a location whose card cleared instantly, and the
      // audit has already found money landing against a placeholder with
      // nobody noticing. See lib/ach-in-flight for why billing_notes and not a
      // new column. Failing to write it must NOT fail the activation — the
      // owner is already in, and a missing audit line is a smaller problem
      // than a 500 that makes Stripe retry a completed activation.
      if (moneyInFlight) {
        try {
          await appendBillingNote(
            location.id,
            achInFlightLine({ amountCents: amountTotal, sessionId, paymentStatus }),
          )
        } catch (e: any) {
          console.error('[stripe-webhook] issue313 in-flight note failed —', e?.message || e)
        }
      }

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
        detail: `tier=owner amount=${dollars(amountTotal)} — activation${result.alreadyActive ? ' (already active)' : ''}${hasSubscription ? ` sub=${subscriptionId}` : ''}${invoiceOutcome === 'duplicate' ? ' invoice=duplicate' : ''}${seatPlanNote}${amountNote}${moneyInFlight ? ` payment_state=in_flight (payment_status=${paymentStatus || 'unknown'}, issue 313)` : ''}`,
        landed,
      })
      await postSlackMessage(
        result.alreadyActive && !hasSubscription && invoiceOutcome === 'inserted'
          ? `⚠️ Stripe payment ${dollars(amountTotal)} from ${location.name || location.id} — location was ALREADY active. Possible duplicate activation payment; refund from the Stripe dashboard if so.`
          : moneyInFlight
            ? `🏦 Bank payment started: ${dollars(amountTotal)} — ${location.name || location.id} — activated NOW, paid through ${paidThrough}. The ACH debit has NOT settled yet (payment_status=${paymentStatus || 'unknown'}); Stripe will confirm in a few days. No hand-activation needed.${seatPlanNote}${amountNote}`
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
      // issue 313: ONE failure, ONE alert, even though a failed ACH debit on a
      // subscription fires TWO Stripe events — checkout.session.async_payment_failed
      // AND invoice.payment_failed. They carry different event ids, so the
      // layer-1 replay guard cannot collapse them; they are genuinely distinct
      // deliveries reporting the same bounce.
      //
      // Both handlers converge on past_due, which is why the STATE needs no
      // reconciling — setLocationSubscriptionStatus is idempotent and the
      // second write is a no-op. Only the notification needs it. A location
      // already sitting in past_due has, by construction, already had its
      // failure reported: nothing else writes that state. So the second event
      // updates the ledger silently instead of pinging Kevin twice about one
      // bounce, and the sync_log row still records that it arrived.
      const alreadyReported = location.subscription_status === 'past_due'
      await setLocationSubscriptionStatus(location.id, 'past_due')
      await logStripeEvent({
        locationSlug: location.location_id, sessionId: invoiceId, status: 'error',
        detail:
          `error=payment_failed sub=${subscriptionId} amount=${dollars(amountPaid)} — marked past_due` +
          (alreadyReported ? ' (already past_due — alert suppressed as a duplicate, issue 313)' : ''),
        landed: 'landed',
      })
      if (!alreadyReported) {
        await postSlackMessage(
          `⚠️ Stripe payment FAILED — ${location.name || location.id} marked past_due (${dollars(amountPaid)}). Owner must update their card or bank details in the billing portal.`,
        )
      }
    } else {
      // invoice.paid — advance the renewal window and record the payment.
      const pe = subscriptionPeriodEndUnix(sub) ?? inv.periodEnd
      const newDate = unixToDateString(pe)
      const advanced = await advancePaidThroughDate(location.id, newDate)
      // A recovered card flips past_due back to active. issue 313: this is
      // ALSO the recovery for an ACH that bounced and was moved to past_due —
      // a successful retry heals the location here with no extra code.
      if (location.subscription_status === 'past_due') {
        await setLocationSubscriptionStatus(location.id, 'active')
      }

      // issue 313: for a location activated up front on an unsettled ACH, THIS
      // is the event where the money actually arrives — it is the same handler
      // that writes the billing_invoices row, so the audit line and the ledger
      // close together. A no-op for card payments (nothing was in flight).
      try {
        await clearAchInFlight(location.id, { amountCents: amountPaid, subscriptionId })
      } catch (e: any) {
        console.error('[stripe-webhook] issue313 clear-in-flight (invoice) failed —', e?.message || e)
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
