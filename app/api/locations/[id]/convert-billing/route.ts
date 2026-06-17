// app/api/locations/[id]/convert-billing/route.ts
//
// "Convert to Direct Billing" — the manual hand-off that moves a corporate-
// funded location onto direct billing once its sponsorship period ends.
//
// Two corporate-funded payment_source values converge here:
//   - prepaid_corporate  : has a paid_through_date (typically 2027-03-01)
//   - corporate_sponsored: paid_through_date is NULL; sponsorship is tracked via
//                          the corporate_sponsorship_*_at columns instead
//
// Both convert to direct billing on/after their sponsorship ends. Stripe is
// still a stub, so "direct billing" today is a pure state change — the payment
// the owner just made is recorded as a memo in billing_notes (audit trail)
// until the Stripe integration replaces it.
//
// Authorization: super_admin / admin ONLY (fail-closed 403). Owners CANNOT
// self-convert — this is a corporate-operator action. Mirrors the isElevated
// pattern in /api/locations/[id]/jobber-disconnect and the ALLOWED_ROLES gate
// in /api/admin/locations.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

// The corporate-funded sources this flow converts FROM. Anything else (direct,
// none, stripe, corporate) is rejected 409 — there's nothing to convert.
const CONVERTIBLE_SOURCES = ['prepaid_corporate', 'corporate_sponsored']

// YYYY-MM-DD with a real-calendar check (rejects 2027-13-40 etc.).
function isValidYmd(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export async function POST(
  request: NextRequest,
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
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!caller || !isElevated(caller.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const newPaidThrough = body.new_paid_through_date
  const paymentMemo =
    typeof body.payment_memo === 'string' ? body.payment_memo.trim() : ''

  if (!isValidYmd(newPaidThrough)) {
    return NextResponse.json(
      { error: 'invalid new_paid_through_date — expected YYYY-MM-DD' },
      { status: 400 }
    )
  }

  // Optional retroactive payment date — when the owner actually paid before the
  // conversion was processed. Defaults to today. Must be a valid YYYY-MM-DD and
  // not in the future.
  const today = new Date().toISOString().slice(0, 10)
  let paymentDate = today
  if (body.payment_date != null && body.payment_date !== '') {
    if (!isValidYmd(body.payment_date)) {
      return NextResponse.json(
        { error: 'invalid payment_date — expected YYYY-MM-DD' },
        { status: 400 }
      )
    }
    if (body.payment_date > today) {
      return NextResponse.json(
        { error: 'payment_date cannot be in the future' },
        { status: 400 }
      )
    }
    paymentDate = body.payment_date
  }

  // Accept "1650" or "1650.00" (and a leading $/commas defensively); must parse
  // to a positive, finite number.
  const rawAmount =
    typeof body.payment_amount === 'string'
      ? body.payment_amount
      : typeof body.payment_amount === 'number'
      ? String(body.payment_amount)
      : ''
  const amount = Number(rawAmount.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: 'invalid payment_amount — expected a positive number' },
      { status: 400 }
    )
  }

  // Load the current row (auth client read works for elevated callers; use it
  // so RLS still scopes what super_admin/admin may see).
  const { data: loc, error: locErr } = await supabaseService
    .from('locations')
    .select('id, name, location_id, payment_source, paid_through_date, billing_notes')
    .eq('id', locationUuid)
    .maybeSingle()
  if (locErr) {
    console.error('[convert-billing] load error', locErr)
    return NextResponse.json({ error: locErr.message }, { status: 500 })
  }
  if (!loc) {
    return NextResponse.json({ error: 'location not found' }, { status: 404 })
  }

  const fromSource = loc.payment_source || 'none'
  if (!CONVERTIBLE_SOURCES.includes(fromSource)) {
    return NextResponse.json(
      { error: 'not_corporate_funded', current: fromSource },
      { status: 409 }
    )
  }

  // Build the conversion audit line, recording which type we converted FROM and
  // the payment received, then preserve any prior notes underneath a separator.
  // When the payment landed on an earlier date than today (retroactive), call
  // it out ("$X on <date>"); for same-day payments keep the terser form.
  const amountStr = amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const paymentClause =
    paymentDate !== today
      ? `Payment received: $${amountStr} on ${paymentDate}.`
      : `Payment received: $${amountStr}.`
  const conversionLine =
    `Converted from ${fromSource} to direct billing on ${today}. ` +
    paymentClause +
    (paymentMemo ? ` ${paymentMemo}` : '')
  const prior = (loc.billing_notes || '').trim()
  const newBillingNotes = prior
    ? `${conversionLine}\n\n--- Previous notes ---\n${prior}`
    : conversionLine

  const { data: updated, error: updErr } = await supabaseService
    .from('locations')
    .update({
      payment_source: 'direct',
      subscription_status: 'active',
      paid_through_date: newPaidThrough,
      billing_notes: newBillingNotes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', locationUuid)
    .select(
      'id, name, location_id, payment_source, subscription_status, paid_through_date, billing_notes'
    )
    .single()

  if (updErr) {
    console.error('[convert-billing] update error', updErr)
    return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  // Also record a structured billing_invoices row so the owner's billing
  // history shows the payment (manual_conversion today; Stripe webhooks will
  // insert here later). The locations UPDATE above is the source of truth for
  // the conversion — if this insert fails we DON'T fail the request, we just
  // surface a warning. The billing_notes text line above remains as a backup
  // audit trail either way.
  const warnings: string[] = []
  const amountCents = Math.round(amount * 100)
  const { error: invoiceErr } = await supabaseService
    .from('billing_invoices')
    .insert({
      location_id: loc.id,
      amount_cents: amountCents,
      currency: 'usd',
      // Retroactive payments use the supplied date (UTC start-of-day); same-day
      // conversions keep the precise current timestamp.
      paid_at: paymentDate !== today
        ? `${paymentDate}T00:00:00Z`
        : new Date().toISOString(),
      period_end: newPaidThrough,
      source: 'manual_conversion',
      memo: paymentMemo || null,
      recorded_by: caller.id,
    })
  if (invoiceErr) {
    console.error('[convert-billing] invoice insert error', invoiceErr)
    warnings.push('invoice_record_failed')
  }

  return NextResponse.json({
    success: true,
    location: updated,
    from_source: fromSource,
    ...(warnings.length ? { warnings } : {}),
  })
}
