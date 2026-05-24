// app/api/seats/buy-and-invite/route.ts
//
// PAUSED — subscription deferred. The combined "buy a seat + send the
// invite" flow is the only path that mints NEW seats from the UI, so it
// stays disabled until the subscription system ships. All locations are
// covered by Bee Organized through March 2027; team invites that consume
// PRE-ALLOCATED unclaimed seats still go through /api/hub_users/invite.
//
// The previous implementation lives in git history (last live commit:
// before the subscription-deferral commit). Restore it by reverting this
// file, removing the SubscriptionDeferredBanner from BeeHub.jsx, and
// re-enabling the "+ Pre-buy seats" CTA in Settings → Billing.

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function POST(_request: NextRequest) {
  return NextResponse.json(
    {
      error:
        'Seat purchase not available. Subscription system in development — locations are currently covered by corporate sponsorship.',
      code: 'subscription_deferred',
    },
    { status: 503 }
  )
}
