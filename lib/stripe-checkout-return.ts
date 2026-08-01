// lib/stripe-checkout-return.ts
// ─────────────────────────────────────────────────────────────
// issue 163 — return the owner to Bee Hub after Stripe checkout.
//
// The onboarding pay step used to open Stripe's hosted checkout in a NEW
// tab (window.open). After paying, the owner was stranded on Stripe's
// success page while the tab that actually advanced sat hidden behind it.
//
// The fix makes checkout a SAME-TAB round trip: the whole tab navigates to
// Stripe and Stripe's success_url / cancel_url bring it right back to the
// onboarding route. This module holds the two seams that make that testable
// and keeps BeeHub's giant JSX free of window-handling trivia:
//
//   • navigateToStripeCheckout — one place that leaves for Stripe, in the
//     SAME tab. Nothing here ever calls window.open.
//   • payStepForCheckoutReturn — maps the ?stripe_checkout= marker Stripe
//     sends us back with onto the onboarding pay step to resume at.
//
// The webhook (checkout.session.completed / invoice.paid) stays the source
// of truth for activation. On a 'complete' return we resume at the polling
// wait step, so a return that BEATS the webhook simply keeps polling
// activation-status until it flips active — there is no race to lose.
// ─────────────────────────────────────────────────────────────

// The onboarding pay step this component is driven by. Mirrors BeeHub's
// `payStep` union — only the two values a Stripe return can land on are
// produced here.
export type PayStep =
  | 'pricing'
  | 'pay_confirm'
  | 'stripe_wait'
  | 'stripe_done'
  | 'processing'
  | 'done'

// The query-param marker Stripe's success_url / cancel_url carry us back
// with. Kept in sync with ownerCheckoutReturnUrls() in lib/stripe-billing.ts.
export const CHECKOUT_RETURN_PARAM = 'stripe_checkout'

// sessionStorage key set right before we leave for Stripe. It lets a return
// via the browser's BACK button (which carries no ?stripe_checkout= marker)
// still land the owner on the pay step instead of the pricing screen.
export const CHECKOUT_INFLIGHT_KEY = 'bee.stripe.checkout.inflight'

// Leave Bee Hub for Stripe's hosted checkout in the SAME tab. `win` is
// injectable for tests; production passes the real window. We deliberately
// use location.assign (not window.open) — one window that leaves and comes
// back is what people expect from paying online.
export function navigateToStripeCheckout(
  url: string,
  win: { location: { assign: (u: string) => void }; sessionStorage?: Storage } | undefined =
    typeof window !== 'undefined' ? (window as any) : undefined,
): void {
  if (!url || !win) return
  // Mark the trip so a browser-BACK return (no marker) still resumes the
  // pay step. Best-effort — private-mode / disabled storage just falls back
  // to the pricing screen, which is a valid pay step, not a broken one.
  try { win.sessionStorage?.setItem(CHECKOUT_INFLIGHT_KEY, '1') } catch {}
  win.location.assign(url)
}

// Map the Stripe return marker to the onboarding pay step to resume at:
//   • 'complete' → 'stripe_wait'  — poll activation-status; the webhook is
//                                   the backstop, so a fast return that beats
//                                   it just keeps polling until active.
//   • 'cancel'   → 'pay_confirm'  — abandoned on Stripe → back to the pay
//                                   step, never a broken state. Re-attempting
//                                   replays the same idempotent checkout
//                                   session (issue 161 keys), so no second
//                                   customer or subscription is created.
//   • anything else / null → null — not a Stripe return; leave payStep alone.
export function payStepForCheckoutReturn(
  marker: string | null | undefined,
): PayStep | null {
  if (marker === 'complete') return 'stripe_wait'
  if (marker === 'cancel') return 'pay_confirm'
  return null
}
