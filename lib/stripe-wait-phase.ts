// lib/stripe-wait-phase.ts
// ─────────────────────────────────────────────────────────────
// issue 311 — the checkout wait screen tells the truth.
//
// StripeCheckoutWait polls /api/locations/[id]/activation-status after the
// owner returns from Stripe. Before this module it polled every 4s FOREVER —
// no deadline, no terminal state — under copy that read "usually within a few
// seconds. No need to do anything."
//
// That copy is true for a card. It is wrong by five orders of magnitude for a
// bank transfer. On 2026-08-19 a checkout.session.completed arrived with
// payment_status=unpaid (correct for a delayed payment method); the webhook
// rightly declined to activate, and the screen span on regardless. Two earlier
// ACH sessions (2026-08-05) cleared on 2026-08-11 — six calendar days later.
//
// ── WHAT THIS SCREEN CAN KNOW ABOUT THE PAYMENT METHOD: NOTHING ──
//
// It is worth being exact, because it is what forces the design below.
//
//   • The return from Stripe carries ONLY ?stripe_checkout=complete
//     (ownerCheckoutReturnUrls). No session id — so the client cannot look the
//     session up, and it is a whole-tab navigation, so no pre-checkout React
//     state survives to remember one.
//   • /api/locations/[id]/activation-status reads the LOCATION row. On the
//     pending path the webhook returns { pending: true } before it writes
//     anything at all, so subscription_status is byte-identical to "the
//     webhook has not arrived yet".
//   • The webhook DOES log the pending session to sync_log — but as
//     logStripeEvent({ locationSlug: null, … }). location_id is NULL on every
//     such row (verified in production: 3 of 3). The row is keyed by session
//     id, which is the one thing the client does not have. It is unreachable
//     from the location, by any query.
//   • Even the session's own payment_method_types would not help: it is the
//     ALLOWED set, ["card","us_bank_account"], identical on every session
//     whichever method the owner actually picked. Only payment_status
//     (paid | unpaid) distinguishes them, and it never reaches the client.
//
// So the screen cannot tell a pending ACH from a slow webhook. It must not
// pretend otherwise. The copy therefore names BOTH outcomes from the first
// frame — a card payer reads one clause and is gone in seconds; a bank-transfer
// payer learns on frame one that today is not the day, instead of watching a
// spinner for twenty minutes.
//
// ── THE DEADLINE ──
//
// The poll stops. It never claims failure — the original comment is right that
// the payment may still land, and the webhook retries for days — but "may still
// land" is a reason to stop spinning and say so, not a reason to spin forever.
// Past DEADLINE_SECONDS a card confirmation is not merely late, it is not
// coming through this poll: every observed card activation lands sub-second,
// and a Stripe delivery that failed retries minutes-to-hours later, long after
// any owner has closed the tab.
// ─────────────────────────────────────────────────────────────

// The three states of the wait, in order. Time is the only input, because
// time is the only signal there is (see above).
//
//   'confirming' — a card lands here, in seconds. Both outcomes named.
//   'settling'   — past the card window. Still polling, but now leads with
//                  the likely story: this is a bank transfer.
//   'delayed'    — the deadline. Polling STOPS. Terminal, and not a failure.
export type CheckoutWaitPhase = 'confirming' | 'settling' | 'delayed'

// A card activation is written by the webhook within a second of the return;
// the first poll fires at 3s. 20s is generous for that and short enough that a
// bank-transfer payer is not kept guessing.
export const SETTLING_AFTER_SECONDS = 20

// Poll deadline. Nothing that arrives after this arrives because we waited.
export const DEADLINE_SECONDS = 90

export function checkoutWaitPhase(elapsedSeconds: number): CheckoutWaitPhase {
  if (!(elapsedSeconds >= 0)) return 'confirming'      // NaN / negative → start
  if (elapsedSeconds >= DEADLINE_SECONDS) return 'delayed'
  if (elapsedSeconds >= SETTLING_AFTER_SECONDS) return 'settling'
  return 'confirming'
}

// The poll re-arms in every phase but the last. One predicate, so the timer
// and the copy can never disagree about whether we are still waiting.
export function isPollingPhase(phase: CheckoutWaitPhase): boolean {
  return phase !== 'delayed'
}

// Reopening checkout while a bank transfer is in flight would mint a SECOND
// session (the idempotency key buckets at 60s, so a later retry is a fresh
// session) and the owner would be charged twice — the location is not yet
// active, so nothing short-circuits the second activation. Offer it only while
// a fast card confirmation is still plausible.
export function showsReopenCheckout(phase: CheckoutWaitPhase): boolean {
  return phase === 'confirming'
}

export type CheckoutWaitCopy = {
  heading: string
  body: string
  // Secondary line, rendered in the callout. Null where there is nothing to add.
  note: string | null
}

// The copy lives HERE, not in the JSX, for two reasons: components/BeeHub.jsx
// is not type-checked, and a test that asserts on a string in a 35k-line JSX
// file asserts on a substring. As data it is checked, and it is the same object
// the screen renders.
const COPY: Record<CheckoutWaitPhase, CheckoutWaitCopy> = {
  confirming: {
    heading: 'Confirming your payment…',
    body:
      "You're back from Stripe. A card payment finishes here on its own, " +
      'usually within a few seconds. A bank transfer (ACH) takes several days ' +
      'to clear — if that is how you paid, you can leave this page now and we ' +
      'will email you the moment it lands.',
    note: null,
  },
  settling: {
    heading: 'Still confirming…',
    body:
      'This is taking longer than a card payment normally does, which usually ' +
      'means the payment is a bank transfer. Those clear in about three to ' +
      'five business days — sometimes up to a week.',
    note:
      'This is the normal pace for a bank transfer, and there is nothing more ' +
      'for you to do here. Your subscription activates by itself as soon as ' +
      'the payment clears.',
  },
  delayed: {
    heading: "We'll email you when your payment clears",
    body:
      'Your payment has not settled yet, and it will not settle while you wait ' +
      'on this screen. A bank transfer (ACH) takes about three to five ' +
      'business days to clear — sometimes up to a week. When it clears, your ' +
      'subscription activates automatically and we email you. You can safely ' +
      'close this page.',
    note:
      'Paid by card and still seeing this? That is unusual — the confirmation ' +
      'is most likely just delayed on its way to us. Your payment is safe ' +
      'either way. Contact Bee Organized and we will pick it up from here.',
  },
}

export function checkoutWaitCopy(phase: CheckoutWaitPhase): CheckoutWaitCopy {
  return COPY[phase] || COPY.confirming
}
