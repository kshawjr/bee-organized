// app/api/locations/[id]/invoices/route.ts
//
// GET — the location's billing history. Structured billing_invoices rows
// (manual conversions today; Stripe-synced records once that integration
// lands). Powers the owner-facing BillingHistorySheet and the super_admin
// billing view.
//
// Authorization: super_admin / admin always; owner allowed only for their own
// location. Mirrors the isElevated + ownership check in
// /api/locations/[id]/jobber-disconnect.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const locationUuid = params.id
  if (!locationUuid) {
    return NextResponse.json({ error: 'location id required' }, { status: 400 })
  }

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!caller) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const isOwnerOfTargetLoc =
    caller.role === 'owner' && caller.location_id === locationUuid
  if (!isElevated(caller.role) && !isOwnerOfTargetLoc) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { data, error } = await supabaseService
    .from('billing_invoices')
    .select(
      'id, amount_cents, currency, paid_at, period_start, period_end, source, payment_method, reference_number, memo, stripe_invoice_id'
    )
    .eq('location_id', locationUuid)
    .order('paid_at', { ascending: false })
    .limit(100)

  if (error) {
    console.error('[locations invoices GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const items = (data || []).map((row) => ({
    id: row.id,
    amountCents: row.amount_cents,
    currency: row.currency,
    paidAt: row.paid_at,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    source: row.source,
    paymentMethod: row.payment_method,
    referenceNumber: row.reference_number,
    memo: row.memo,
    stripeInvoiceId: row.stripe_invoice_id,
  }))

  return NextResponse.json({ items })
}
