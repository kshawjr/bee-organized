// lib/location-close-deps.ts
// ─────────────────────────────────────────────────────────────
// The two outside calls a close makes — Stripe and Supabase auth — kept out of
// lib/location-close so its tests never load either client.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from '@/lib/supabase-service'
import { getStripe, stripeConfigured } from '@/lib/stripe'
import { BAN_DURATION, UNBAN_DURATION } from '@/lib/access-removal'
import type { CloseDeps } from '@/lib/location-close'

// Ends the subscription NOW, without a refund (prorate: false) and without a
// final invoice. What was paid stays paid; billing_invoices is untouched.
// Throws on a real failure so the close reports it out loud.
async function cancelStripeSubscription(subscriptionId: string): Promise<string> {
  if (!stripeConfigured()) throw new Error('STRIPE_SECRET_KEY not set')
  const stripe = getStripe()
  const sub = await stripe.subscriptions.retrieve(subscriptionId)
  if (sub.status === 'canceled') return 'already_canceled'
  await stripe.subscriptions.cancel(subscriptionId, { prorate: false, invoice_now: false })
  return 'canceled'
}

// Same Layer-2 ban as Remove access (app/api/hub_users/[id]/access). Never
// throws; false means "say so".
async function setAuthBan(userId: string, banned: boolean): Promise<boolean> {
  try {
    const { error } = await supabaseService.auth.admin.updateUserById(userId, {
      ban_duration: banned ? BAN_DURATION : UNBAN_DURATION,
    })
    if (error) {
      console.error(`[location-close] auth_ban_failed (banned=${banned}) for ${userId}: ${error.message}`)
      return false
    }
    return true
  } catch (e: any) {
    console.error(`[location-close] auth_ban_failed (banned=${banned}) for ${userId}: ${e?.message || e}`)
    return false
  }
}

export const liveCloseDeps: CloseDeps = { cancelStripeSubscription, setAuthBan }
