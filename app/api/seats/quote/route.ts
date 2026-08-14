// app/api/seats/quote/route.ts
//
// issue 223 — WHAT WILL THIS SEAT COST, AND WILL IT ACTUALLY BE CHARGED?
//
// The seat modals told owners "no card will be charged" and then charged
// them. Fixing the words needed a source for two facts the client could not
// legitimately know before confirming:
//
//   the figure   — issue 217 moved this to the server precisely so the
//                  browser would stop doing money math. The confirm screen
//                  must not recompute it client-side; that is the class of
//                  bug issue 216 fixed and issue 217 closed for good. So it
//                  asks.
//   the outcome  — whether the charge will actually happen, which depends on
//                  the location's payment_source, whether it has a live
//                  Stripe subscription, and whether the tier is priced at $0.
//                  All three are server facts.
//
// READ-ONLY, AND THE SAME DERIVATION AS THE WRITE. This calls
// quoteSeatPurchase — the identical function /api/seats POST and
// /api/seats/buy-and-invite call to decide what to record and charge — and
// previewSeatPurchaseBilling, which walks the quote's billingLines through
// the same gate the charging path uses (see resolveSeatBillingGate). Nothing
// here reimplements a decision. A preview that reasoned separately would
// just be a new way for the screen and the server to disagree, which is the
// bug, not the fix.
//
// It writes nothing and calls Stripe not at all.
//
// Auth mirrors POST /api/seats, not GET: this exposes what a location would
// be charged, so it is gated as a billing read — elevated roles, or the
// owner of the location in question.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { quoteSeatPurchase, seatCostResponse } from '@/lib/seat-cost'
import { previewSeatPurchaseBilling } from '@/lib/seat-stripe-sync'

export const runtime = 'nodejs'

const VALID_TIERS = ['owner', 'manager', 'light', 'readonly'] as const
type Tier = (typeof VALID_TIERS)[number]

// GET /api/seats/quote?location_id=<uuid>&tier=<tier>&quantity=<n>
export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const role = hubUser.role as string
  const callerLocationId = hubUser.location_id as string | null

  const params = request.nextUrl.searchParams
  const locationId = params.get('location_id')
  const tier = params.get('tier') as Tier | null
  const quantityRaw = params.get('quantity')

  if (!locationId) {
    return NextResponse.json({ error: 'location_id query param required' }, { status: 400 })
  }
  if (!tier || !VALID_TIERS.includes(tier)) {
    return NextResponse.json(
      { error: `tier must be one of ${VALID_TIERS.join(', ')}` },
      { status: 400 },
    )
  }

  const quantity = quantityRaw == null ? 1 : Number(quantityRaw)
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
    return NextResponse.json(
      { error: 'quantity must be an integer between 1 and 50' },
      { status: 400 },
    )
  }

  const isElevated = role === 'super_admin' || role === 'admin'
  const isOwnerOfLocation = role === 'owner' && callerLocationId === locationId
  if (!isElevated && !isOwnerOfLocation) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  try {
    const quote = await quoteSeatPurchase({ locationId, tier, quantity })
    const billing = await previewSeatPurchaseBilling({
      locationId,
      lines: quote.billingLines,
    })

    return NextResponse.json({
      cost: seatCostResponse(quote),
      billing: {
        will_charge: billing.willCharge,
        reason: billing.reason,
        lines: billing.lines,
      },
    })
  } catch (err: any) {
    // A quote that cannot be produced must not read as a free seat. The
    // client shows its own "we couldn't work out the cost" state and blocks
    // the purchase rather than falling back to a cheerful default.
    console.error('[seats quote] issue 223 —', err?.message || err)
    return NextResponse.json({ error: 'could not quote this seat' }, { status: 500 })
  }
}
