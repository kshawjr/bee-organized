// app/api/locations/[id]/record-payment/route.ts
//
// "Record Payment" — logs an arbitrary payment against a location WITHOUT
// changing its billing model. Use for the off-cycle money that doesn't fit the
// Convert-to-Direct-Billing flow: an additional seat bought mid-year, a late
// renewal, a manual adjustment, or anything else.
//
// Unlike /convert-billing this does NOT touch payment_source or
// subscription_status — it only records the payment. It writes a structured
// billing_invoices row (source='manual_other') so the owner's billing history
// shows it, and appends a brief audit line to location.billing_notes.
//
// Authorization: super_admin / admin ONLY (fail-closed 403). Owners CANNOT
// self-record. Mirrors the isElevated gate in /api/locations/[id]/convert-billing.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'

export const runtime = 'nodejs'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

// Allowed reason categories → human-readable labels used in the memo + audit line.
const REASON_LABELS: Record<string, string> = {
  additional_seat: 'Additional seat',
  renewal: 'Renewal',
  adjustment: 'Adjustment',
  other: 'Other',
}

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

  // Reason — required, must be one of the allowed categories.
  const reason = typeof body.reason === 'string' ? body.reason : ''
  if (!REASON_LABELS[reason]) {
    return NextResponse.json(
      { error: 'invalid reason — expected one of: additional_seat, renewal, adjustment, other' },
      { status: 400 }
    )
  }

  // Payment date — required, valid YYYY-MM-DD, not in the future.
  const today = new Date().toISOString().slice(0, 10)
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
  const paymentDate = body.payment_date

  // Amount — required positive number. Accept "100" or "100.00" (strip $/commas).
  const rawAmount =
    typeof body.amount === 'string'
      ? body.amount
      : typeof body.amount === 'number'
      ? String(body.amount)
      : ''
  const amount = Number(rawAmount.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: 'invalid amount — expected a positive number' },
      { status: 400 }
    )
  }

  // Optional free-text fields.
  const memo = typeof body.memo === 'string' ? body.memo.trim() : ''
  const paymentMethod =
    typeof body.payment_method === 'string' ? body.payment_method.trim() : ''
  const referenceNumber =
    typeof body.reference_number === 'string' ? body.reference_number.trim() : ''

  // Load the current row (service client; elevated-only access already enforced).
  const { data: loc, error: locErr } = await supabaseService
    .from('locations')
    .select('id, name, location_id, billing_notes')
    .eq('id', locationUuid)
    .maybeSingle()
  if (locErr) {
    console.error('[record-payment] load error', locErr)
    return NextResponse.json({ error: locErr.message }, { status: 500 })
  }
  if (!loc) {
    return NextResponse.json({ error: 'location not found' }, { status: 404 })
  }

  const reasonLabel = REASON_LABELS[reason]
  const amountStr = amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

  // Structured invoice row. paid_at uses the supplied date (UTC start-of-day)
  // unless it's today, in which case keep the precise current timestamp so the
  // ordering stays stable for same-day records.
  const amountCents = Math.round(amount * 100)
  const invoiceMemo = `Reason: ${reasonLabel}.${memo ? ` ${memo}` : ''}`
  const { data: invoice, error: invoiceErr } = await supabaseService
    .from('billing_invoices')
    .insert({
      location_id: loc.id,
      amount_cents: amountCents,
      currency: 'usd',
      paid_at:
        paymentDate !== today
          ? `${paymentDate}T00:00:00Z`
          : new Date().toISOString(),
      source: 'manual_other',
      payment_method: paymentMethod || null,
      reference_number: referenceNumber || null,
      memo: invoiceMemo,
      recorded_by: caller.id,
    })
    .select(
      'id, amount_cents, currency, paid_at, source, payment_method, reference_number, memo, recorded_by'
    )
    .single()
  if (invoiceErr) {
    console.error('[record-payment] invoice insert error', invoiceErr)
    return NextResponse.json({ error: invoiceErr.message }, { status: 500 })
  }

  // Append a brief audit line to billing_notes, preserving prior notes beneath.
  const auditLine =
    `Payment recorded: $${amountStr} on ${paymentDate} — ${reasonLabel}.` +
    (memo ? ` ${memo}` : '')
  const prior = (loc.billing_notes || '').trim()
  const newBillingNotes = prior
    ? `${auditLine}\n\n--- Previous notes ---\n${prior}`
    : auditLine

  const { error: notesErr } = await supabaseService
    .from('locations')
    .update({
      billing_notes: newBillingNotes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', locationUuid)

  // The invoice row is the source of truth for the payment; if the notes update
  // fails we surface a warning rather than failing the request.
  const warnings: string[] = []
  if (notesErr) {
    console.error('[record-payment] billing_notes update error', notesErr)
    warnings.push('billing_notes_update_failed')
  }

  return NextResponse.json({
    success: true,
    invoice,
    // billing_notes echoed back (best-effort) so the caller can reflect the new
    // audit line locally without a refetch. Null if the notes update failed.
    location: { id: loc.id, billing_notes: notesErr ? null : newBillingNotes },
    ...(warnings.length ? { warnings } : {}),
  })
}
