// lib/subscription-activation.ts
//
// THE single activation path for a location's subscription, plus the
// server-side "does this purchase require Stripe checkout?" gate.
//
// Two callers, one write path:
//   - POST /api/locations/[id]/complete-onboarding (the PaymentConfirmStep
//     record-only fallback, and Kevin's manual rail via super_admin)
//   - POST /api/webhooks/stripe (real payments)
// Both funnel through activateLocationSubscription() so the webhook can
// never drift from what the onboarding flip writes.
//
// Everything here is idempotent by design — the Stripe webhook retries
// on 5xx and the same checkout session can arrive via two event types,
// so every write is safe to repeat:
//   - owner seat: created only if no active owner seat exists
//   - status flip: skipped when already 'active' (started_at never re-stamped)
//   - invoice: unique partial index on stripe_payment_intent_id (see
//     migrations/stripe_webhook_events.sql) turns replays into no-ops
//   - purchased seats: keyed by checkout session id in notes; existing
//     marker row means the seat was already created

import { supabaseService } from './supabase-service'
import { buildStripePayUrl } from './stripe-links'
import { stripeConfigured } from './stripe'
import { annualRenewalFromSignup, legacyFixedRenewalDate } from './subscription-math'
import { planAddOnRows, MAX_OWNER_SEATS, type SeatPlan } from './seat-plan'

const SEAT_COLS =
  'id, location_id, tier, user_id, status, added_at, removed_at, prorated_cost, added_by, notes, is_primary, scheduled_removal_at'

// payment_source values that mean "Bee Organized/corporate pays, not the
// owner" — these locations never go through Stripe checkout. Everything
// else ('direct', 'stripe', 'none', null) is an owner-pays location.
export const NON_PAYING_SOURCES = ['prepaid_corporate', 'corporate_sponsored', 'corporate']

export type LocationBillingRow = {
  id: string
  name: string | null
  location_id: string | null // slug, used by sync_log
  subscription_status: string | null
  payment_source: string | null
  paid_through_date: string | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
}

const LOCATION_BILLING_COLS =
  'id, name, location_id, subscription_status, payment_source, paid_through_date, stripe_customer_id, stripe_subscription_id'

export async function getLocationBilling(locationId: string): Promise<LocationBillingRow | null> {
  const { data } = await supabaseService
    .from('locations')
    .select(LOCATION_BILLING_COLS)
    .eq('id', locationId)
    .maybeSingle()
  return (data as LocationBillingRow) ?? null
}

// ── Stripe id mapping (issue 161) ─────────────────────────────
// invoice.* / customer.subscription.* events carry no client_reference_id,
// so the webhook maps them back to a location by the subscription id it
// stored at activation.
export async function getLocationByStripeSubscriptionId(
  subscriptionId: string,
): Promise<LocationBillingRow | null> {
  if (!subscriptionId) return null
  const { data } = await supabaseService
    .from('locations')
    .select(LOCATION_BILLING_COLS)
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle()
  return (data as LocationBillingRow) ?? null
}

// Persist the Stripe customer/subscription ids on the location. Only writes
// the fields provided and only when they'd actually change, so a webhook
// retry is a no-op and the checkout route (which writes the customer id
// early) never clobbers a subscription id the webhook wrote.
export async function writeLocationStripeIds(
  locationId: string,
  ids: { customerId?: string | null; subscriptionId?: string | null },
): Promise<void> {
  const current = await getLocationBilling(locationId)
  const update: Record<string, any> = {}
  if (ids.customerId && current?.stripe_customer_id !== ids.customerId) {
    update.stripe_customer_id = ids.customerId
  }
  if (ids.subscriptionId && current?.stripe_subscription_id !== ids.subscriptionId) {
    update.stripe_subscription_id = ids.subscriptionId
  }
  if (Object.keys(update).length === 0) return
  const { error } = await supabaseService.from('locations').update(update).eq('id', locationId)
  if (error) throw new Error(`writeLocationStripeIds failed: ${error.message}`)
}

// Advance paid_through_date, never backward. Renewal (invoice.paid) pushes
// it out to the subscription's new period end; a replayed/older event is a
// no-op so a late-arriving duplicate can't shrink the window.
export async function advancePaidThroughDate(
  locationId: string,
  newDate: string | null,
): Promise<boolean> {
  if (!newDate || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return false
  const current = await getLocationBilling(locationId)
  if (current?.paid_through_date && current.paid_through_date >= newDate) return false
  const { error } = await supabaseService
    .from('locations')
    .update({ paid_through_date: newDate })
    .eq('id', locationId)
  if (error) throw new Error(`advancePaidThroughDate failed: ${error.message}`)
  return true
}

// Flip subscription_status (past_due on payment failure, canceled on
// subscription.deleted, active on recovery). Constrained to the values the
// locations_subscription_status_check CHECK allows.
const ALLOWED_SUB_STATUS = ['deferred', 'active', 'past_due', 'canceled'] as const
export async function setLocationSubscriptionStatus(
  locationId: string,
  status: (typeof ALLOWED_SUB_STATUS)[number],
): Promise<void> {
  if (!ALLOWED_SUB_STATUS.includes(status)) throw new Error(`invalid subscription_status ${status}`)
  const { error } = await supabaseService
    .from('locations')
    .update({ subscription_status: status })
    .eq('id', locationId)
  if (error) throw new Error(`setLocationSubscriptionStatus failed: ${error.message}`)
}

// ── The Stripe-payment gate ───────────────────────────────────
// A seat/activation purchase must go through Stripe checkout when the
// location is owner-pays AND a payment link is configured for the tier.
// No link configured (column NULL, or the tier_prices_payment_links
// migration not applied yet) → not required, the record-only flow stays
// available. This is the fail-open-to-status-quo direction on purpose:
// the gate can never lock a location out of activating before Stripe is
// set up, it can only close the free-seat path once a real link exists.
export async function getStripeRequirement(
  location: LocationBillingRow,
  tier: string,
  prefilledEmail?: string | null,
): Promise<{ required: boolean; payUrl: string | null }> {
  if (NON_PAYING_SOURCES.includes(location.payment_source || '')) {
    return { required: false, payUrl: null }
  }
  // select('*') so a pre-migration schema (no payment_link_url column)
  // yields undefined instead of a PostgREST unknown-column error.
  const { data: tierRow } = await supabaseService
    .from('tier_prices')
    .select('*')
    .eq('id', tier)
    .maybeSingle()
  const link = (tierRow as any)?.payment_link_url ?? null
  const payUrl = buildStripePayUrl(link, location.id, prefilledEmail)
  return { required: !!payUrl, payUrl }
}

// ── Owner-checkout-configured gate (issue 167) ────────────────
// True when this location CAN charge the owner through Stripe checkout —
// i.e. it is owner-pays (not a non-paying/corporate source), Stripe is
// configured server-side, AND the owner tier has a stripe_price_id. When
// this is true, only the Stripe webhook (a real payment) may activate the
// location; an owner must NOT be able to free-activate it through the
// record-only complete-onboarding path (issue 167 BUG 3). When it is false
// — non-paying source, Stripe not configured, or no owner price yet — the
// record-only / free-grant door stays open exactly as before.
export async function ownerCheckoutConfigured(location: LocationBillingRow): Promise<boolean> {
  if (NON_PAYING_SOURCES.includes(location.payment_source || '')) return false
  if (!stripeConfigured()) return false
  // select('*') tolerates a pre-migration schema (no stripe_price_id column).
  const { data: tierRow } = await supabaseService
    .from('tier_prices')
    .select('*')
    .eq('id', 'owner')
    .maybeSingle()
  return !!(tierRow as any)?.stripe_price_id
}

// issue 162: a new self-paying location's paid_through anchors to signup + 1yr
// (the same anniversary Stripe's billing_cycle_anchor produces), NOT a fixed
// March 1. Used as the activation default when the real Stripe period end
// isn't available yet.
export function annualRenewalFromSignupString(from: Date = new Date()): string {
  return annualRenewalFromSignup(from).toISOString().slice(0, 10)
}

// LEGACY-ONLY (issue 162): the fixed next-March-1 string. Retained for the
// pre-Stripe cohort; do not use as the default for new activations.
export function legacyFixedRenewalDateString(from: Date = new Date()): string {
  return legacyFixedRenewalDate(from).toISOString().slice(0, 10)
}

// ── The ONE activation function ───────────────────────────────
export type ActivationResult = {
  alreadyActive: boolean
  seat: any | null // created or claimed owner seat row (null when one already existed)
  location: { id: string; name: string | null; subscription_status: string; subscription_started_at: string | null }
}

export async function activateLocationSubscription(args: {
  locationId: string
  // Claim/create the owner seat for this user. The onboarding route
  // passes the calling owner; the webhook passes the resolved primary
  // owner (or null — an unclaimed seat still holds the paid slot).
  ownerUserId?: string | null
  proratedCostCents?: number | null
  // YYYY-MM-DD. The webhook passes next March 1; the record-only path
  // omits it (matching the pre-Stripe behavior of never writing it).
  paidThroughDate?: string | null
  seatNotes?: string | null
}): Promise<ActivationResult> {
  const { locationId, ownerUserId, proratedCostCents, paidThroughDate, seatNotes } = args

  // 1. Owner seat — ensure exactly one paid owner slot exists.
  const { data: ownerSeats, error: seatReadErr } = await supabaseService
    .from('subscription_seats')
    .select(SEAT_COLS)
    .eq('location_id', locationId)
    .eq('tier', 'owner')
    .eq('status', 'active')
    .order('added_at', { ascending: true })
  if (seatReadErr) throw new Error(`owner seat read failed: ${seatReadErr.message}`)

  let seat: any | null = null
  const existing = ownerSeats || []
  if (existing.length === 0) {
    const insertRow: Record<string, any> = {
      location_id: locationId,
      tier: 'owner',
      user_id: ownerUserId ?? null,
      added_by: ownerUserId ?? null,
    }
    if (proratedCostCents != null) insertRow.prorated_cost = proratedCostCents
    if (seatNotes) insertRow.notes = seatNotes
    const { data: inserted, error: insErr } = await supabaseService
      .from('subscription_seats')
      .insert(insertRow)
      .select(SEAT_COLS)
      .single()
    if (insErr) throw new Error(`owner seat insert failed: ${insErr.message}`)
    seat = inserted
  } else if (ownerUserId && !existing.some((s: any) => s.user_id)) {
    // A pre-allocated unclaimed owner seat exists (invite-owner path) —
    // claim the earliest one for the activating owner instead of
    // stranding it and double-counting toward the 2-owner cap.
    const { data: claimed, error: claimErr } = await supabaseService
      .from('subscription_seats')
      .update({ user_id: ownerUserId, updated_at: new Date().toISOString() })
      .eq('id', existing[0].id)
      .is('user_id', null) // guard against a concurrent claim
      .select(SEAT_COLS)
      .maybeSingle()
    if (claimErr) throw new Error(`owner seat claim failed: ${claimErr.message}`)
    seat = claimed ?? null
  }

  // 2. Location flip — only when not already active. subscription_started_at
  // is stamped once; a duplicate payment or webhook retry never re-stamps it.
  const location = await getLocationBilling(locationId)
  if (!location) throw new Error('location not found')

  if (location.subscription_status === 'active') {
    // Still honor a paid-through extension when the column is empty —
    // covers the retry-after-partial-failure case without ever moving an
    // existing date backwards.
    if (paidThroughDate && !location.paid_through_date) {
      await supabaseService
        .from('locations')
        .update({ paid_through_date: paidThroughDate })
        .eq('id', locationId)
    }
    return {
      alreadyActive: true,
      seat,
      location: {
        id: location.id,
        name: location.name,
        subscription_status: 'active',
        subscription_started_at: null,
      },
    }
  }

  const update: Record<string, any> = {
    subscription_status: 'active',
    subscription_started_at: new Date().toISOString(),
  }
  if (paidThroughDate) update.paid_through_date = paidThroughDate

  const { data: updated, error: updErr } = await supabaseService
    .from('locations')
    .update(update)
    .eq('id', locationId)
    .select('id, name, subscription_status, subscription_started_at')
    .single()
  if (updErr) throw new Error(`subscription flip failed: ${updErr.message}`)

  return { alreadyActive: false, seat, location: updated as ActivationResult['location'] }
}

// ── Comp / manual seat grants (super_admin, no payment) ───────
// The pre-Stripe "turn on a tester" lever. A super_admin grants a seat
// WITHOUT a payment; the seat carries a comp marker in `notes` so
// "who paid vs who was comped" stays answerable later.
//
// The marker rides `subscription_seats.notes` — the SAME field the
// Stripe webhook stamps "Paid via Stripe checkout (stripe_session=…)"
// into. A comp seat says "Comp/manual grant … (comp_grant admin=<id>)"
// and, unlike a paid activation, writes NO billing_invoices row (no
// money moved) and carries prorated_cost = 0. So a comp grant is
// distinguishable from a paid one three ways: the notes marker, the
// absent invoice, and the zero cost.
//
// Activation itself (subscription flip + owner seat) still goes through
// activateLocationSubscription — the ONE activation path. This helper
// only mints ADDITIONAL pool seats (the manual sibling of
// addStripePurchasedSeats), so the two never disagree.
export const MANUAL_GRANT_MARKER = 'comp_grant'

export function manualGrantSeatNote(grantedBy?: string | null, reason?: string | null): string {
  const who = grantedBy ? ` admin=${grantedBy}` : ''
  const why = reason && reason.trim() ? ` — ${reason.trim().slice(0, 200)}` : ''
  return `Comp/manual grant — no payment (${MANUAL_GRANT_MARKER}${who})${why}`
}

export async function addManuallyGrantedSeats(args: {
  locationId: string
  tier: string
  quantity: number
  grantedBy?: string | null
  reason?: string | null
}): Promise<{ seats: any[]; ownerCapHit: boolean }> {
  const { locationId, tier, quantity, grantedBy, reason } = args
  const qty = Math.max(1, Math.min(50, Math.trunc(quantity)))

  // Mirror /api/seats POST + addStripePurchasedSeats: max 2 active owner seats.
  if (tier === 'owner') {
    const { count } = await supabaseService
      .from('subscription_seats')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('tier', 'owner')
      .eq('status', 'active')
    if ((count ?? 0) + qty > 2) return { seats: [], ownerCapHit: true }
  }

  const baseRow: Record<string, any> = {
    location_id: locationId,
    tier,
    user_id: null,
    added_by: grantedBy ?? null,
    prorated_cost: 0, // comp — no charge
    notes: manualGrantSeatNote(grantedBy ?? null, reason),
  }

  const { data: seats, error } = await supabaseService
    .from('subscription_seats')
    .insert(Array.from({ length: qty }, () => ({ ...baseRow })))
    .select(SEAT_COLS)
  if (error) throw new Error(`manual seat insert failed: ${error.message}`)
  return { seats: seats || [], ownerCapHit: false }
}

// ── Seats for a paid seat plan (issue 212) ───────────────────
// activateLocationSubscription() creates (or claims) exactly ONE owner seat.
// That was the whole story before issue 212, which is why a location whose
// owner selected a co-owner and a Hive Manager activated with a single seat.
// This adds the REST of the plan — every seat beyond that first owner one —
// so the pool matches what was billed.
//
// WHERE THE PLAN COMES FROM: the caller passes a plan decoded from the Stripe
// SESSION's metadata (the webhook) or from a validated request body on a
// zero-charge activation (the prepaid / record-only path). Never from client
// state at write time — by the time Stripe calls us the browser that made the
// selection may be long gone.
//
// IDEMPOTENCY, two layers deep:
//   • `marker` is stamped into every row's notes and checked first, so a
//     webhook redelivery that got past the event-id guard (a delivery that
//     died mid-way is re-run in full) finds its own rows and no-ops.
//   • the rows go in as ONE insert, so the marker check can never see a
//     half-written batch — either every row is there or none is.
// The marker is deliberately distinct from the owner seat's
// "stripe_session=…" note: that note is written by activateLocationSubscription
// for a DIFFERENT row, and sharing the string would make this function think
// its work was already done and skip every add-on seat.
export const SEAT_PLAN_MARKER_PREFIX = 'seat_plan'

export function seatPlanMarker(kind: 'session' | 'onboarding', id: string): string {
  return `${SEAT_PLAN_MARKER_PREFIX}_${kind}=${id}`
}

export async function addSeatsForPlan(args: {
  locationId: string
  plan: SeatPlan
  // Stable per-activation id (a Stripe session id, or the location id for the
  // record-only path). Makes the whole batch replay-safe.
  marker: string
  // Annual unit price in cents per BILLING tier, so each row records the rate
  // it was actually billed at — a co-owner row is tier 'owner' carrying the
  // manager rate, which is the honest record of that seat.
  unitCentsByTier?: Record<string, number | null | undefined>
  noteLabel: string
}): Promise<{ seats: any[]; deduped: boolean; ownerCapHit: boolean }> {
  const { locationId, plan, marker, unitCentsByTier, noteLabel } = args

  const rows = planAddOnRows(plan)
  if (rows.length === 0) return { seats: [], deduped: false, ownerCapHit: false }

  // Layer 1: has this exact activation already written its seats?
  const { data: prior } = await supabaseService
    .from('subscription_seats')
    .select('id')
    .eq('location_id', locationId)
    .like('notes', `%${marker}%`)
    .limit(1)
  if (prior && prior.length > 0) return { seats: [], deduped: true, ownerCapHit: false }

  // The 2-owner cap, counted against what already exists. The plan was capped
  // at validation, but a pre-allocated owner seat (the invite-owner path) can
  // already be sitting here, so re-check against live rows before inserting.
  const ownerRows = rows.filter((r) => r.tier === 'owner').length
  if (ownerRows > 0) {
    const { count } = await supabaseService
      .from('subscription_seats')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('tier', 'owner')
      .eq('status', 'active')
    if ((count ?? 0) + ownerRows > MAX_OWNER_SEATS) {
      return { seats: [], deduped: false, ownerCapHit: true }
    }
  }

  const insertRows = rows.map((r) => {
    const row: Record<string, any> = {
      location_id: locationId,
      tier: r.tier,
      user_id: null,
      notes:
        r.tier === 'owner'
          ? `${noteLabel} — co-owner seat, billed at the ${r.billingTier} rate (${marker})`
          : `${noteLabel} (${marker})`,
    }
    const cents = unitCentsByTier?.[r.billingTier]
    if (typeof cents === 'number' && Number.isInteger(cents) && cents >= 0) {
      row.prorated_cost = cents
    }
    return row
  })

  const { data: seats, error } = await supabaseService
    .from('subscription_seats')
    .insert(insertRows)
    .select(SEAT_COLS)
  if (error) throw new Error(`seat plan insert failed: ${error.message}`)
  return { seats: seats || [], deduped: false, ownerCapHit: false }
}

// ── Stripe invoice recording ──────────────────────────────────
// Returns 'inserted' | 'duplicate'. 'duplicate' means the payment_intent
// already has a billing_invoices row (unique partial index) — the caller
// keeps going so an interrupted first delivery still converges, but skips
// the "possible duplicate payment" alerting.
export async function recordStripeInvoice(args: {
  locationId: string
  amountCents: number
  currency: string | null
  sessionId: string | null
  // issue 163: the Stripe invoice id (in_…), when the row originates from an
  // invoice event. Populates the dedicated stripe_invoice_id column so it no
  // longer sits empty while the id hides in reference_number. Checkout-session
  // rows (activation-legacy / seat purchase) carry no invoice id and leave it
  // null. Idempotency still runs off stripe_payment_intent_id, unchanged.
  invoiceId?: string | null
  paymentIntentId: string | null
  memo: string
  periodEnd?: string | null
}): Promise<'inserted' | 'duplicate' | 'skipped_zero_amount'> {
  const { locationId, amountCents, currency, sessionId, paymentIntentId, memo, periodEnd } = args
  const invoiceId = args.invoiceId ?? null
  // billing_invoices CHECKs amount_cents > 0; a 100%-coupon session is
  // recorded in stripe_webhook_events + sync_log only.
  if (!Number.isInteger(amountCents) || amountCents <= 0) return 'skipped_zero_amount'

  const { error } = await supabaseService.from('billing_invoices').insert({
    location_id: locationId,
    amount_cents: amountCents,
    currency: currency || 'usd',
    paid_at: new Date().toISOString(),
    period_end: periodEnd ?? null,
    source: 'stripe',
    payment_method: 'card',
    // reference_number is the source-agnostic human reference (a check #, wire
    // ref, etc. for manual rows). For a Stripe row the best human reference is
    // the invoice id when there is one (what shows on the customer's Stripe
    // receipt), else the checkout session id — so prefer invoiceId, fall back
    // to sessionId. The canonical machine id lives in stripe_invoice_id.
    reference_number: invoiceId ?? sessionId,
    memo,
    stripe_invoice_id: invoiceId,
    stripe_payment_intent_id: paymentIntentId,
  })
  if (error) {
    if ((error as any).code === '23505') return 'duplicate'
    throw new Error(`billing_invoices insert failed: ${error.message}`)
  }
  return 'inserted'
}

// ── Stripe-purchased seats (post-activation "+ seats") ────────
// Creates `quantity` ghost seats (user_id null) for a paid checkout —
// links are quantity-adjustable in Stripe, and the caller derives the
// count from amount_total (lib/stripe-webhook.ts deriveSeatQuantity).
// All rows carry the checkout session id in notes and are inserted in
// ONE statement, so a webhook retry finds the marker and no-ops instead
// of double-granting (all-or-nothing on the insert itself).
export async function addStripePurchasedSeats(args: {
  locationId: string
  tier: string
  quantity: number
  perSeatCents: number | null
  sessionId: string | null
}): Promise<{ seats: any[]; deduped: boolean; ownerCapHit: boolean }> {
  const { locationId, tier, quantity, perSeatCents, sessionId } = args
  const qty = Math.max(1, Math.min(50, Math.trunc(quantity)))
  const marker = sessionId ? `stripe_session=${sessionId}` : null

  if (marker) {
    const { data: prior } = await supabaseService
      .from('subscription_seats')
      .select('id')
      .eq('location_id', locationId)
      .like('notes', `%${marker}%`)
      .limit(1)
    if (prior && prior.length > 0) return { seats: [], deduped: true, ownerCapHit: false }
  }

  // Mirror /api/seats POST's owner cap (max 2 active owner seats).
  if (tier === 'owner') {
    const { count } = await supabaseService
      .from('subscription_seats')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', locationId)
      .eq('tier', 'owner')
      .eq('status', 'active')
    if ((count ?? 0) + qty > 2) return { seats: [], deduped: false, ownerCapHit: true }
  }

  const baseRow: Record<string, any> = {
    location_id: locationId,
    tier,
    user_id: null,
    notes: marker ? `Purchased via Stripe checkout (${marker})` : 'Purchased via Stripe checkout',
  }
  if (perSeatCents != null && Number.isInteger(perSeatCents) && perSeatCents >= 0) {
    baseRow.prorated_cost = perSeatCents
  }

  const { data: seats, error } = await supabaseService
    .from('subscription_seats')
    .insert(Array.from({ length: qty }, () => ({ ...baseRow })))
    .select(SEAT_COLS)
  if (error) throw new Error(`stripe seat insert failed: ${error.message}`)
  return { seats: seats || [], deduped: false, ownerCapHit: false }
}
