// app/api/leads/[id]/no-coverage/route.ts
//
// POST /api/leads/:id/no-coverage — corp/admin only.
//
// The SECOND disposition for an unroutable lead. Route (the sibling endpoint)
// says "this belongs to Boulder"; this one says "nobody covers them". It emails
// the person to tell them so, offers a mailing-list link for when we do reach
// their area, and clears the lead out of the transfer queue.
//
// AUTH is the same load-bearing gate as transfer: isAdmin(role), re-checked
// here. The Inbox section and the pill are cosmetic — view-as flips only the
// CLIENT role, so a franchise viewer under view-as still carries an elevated
// server session and the write must be re-gated server-side.
//
// KEVIN'S RULE — DISMISSED ON SEND, NOT ON CLICK. Corp has resolved this lead
// from their side the moment the email goes out. Whether the person joins the
// list is their choice and must not hold the queue open waiting on it. So the
// dismissal is here, at send time; the public page (app/mailing-list/[token])
// only records consent.
//
// ─── WRITE ORDER IS THE WHOLE DESIGN ──────────────────────────────────────
// "Dismissed on send" has an obvious failure mode: dismiss first, then fail to
// send, and the lead is now invisible AND unhelped — nobody ever told them,
// and nobody will ever see them again. So the order is:
//
//   1. mint + persist the token           (no email out, nothing hidden)
//   2. SEND                               ← the gate
//   3. only on a successful send: dismiss (inbox_dismissed_at)
//   4. touchpoint                          (non-fatal, warnings)
//
// A failed send therefore returns an error with the lead STILL VISIBLE in the
// queue: recoverable, and the operator can see that it needs recovering. The
// stored token is left in place — it is inert without an email carrying it,
// 48 hex is not guessable, and a retry simply overwrites it.
//
// The residual risk runs the SAFE direction: if step 3 fails after step 2
// succeeded, the email is out but the row stays visible. The response says so
// (dismissed:false + a warning) and the client does NOT optimistically remove
// the row, so the surface matches the database. A duplicate send is a far
// smaller harm than a silently vanished person.
//
// Post-send failures (touchpoint) are collected as `warnings` rather than
// flipping the response, mirroring the transfer route.

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { sendNoCoverageEmail, firstNameOf } from '@/lib/no-coverage-email'

export const runtime = 'nodejs'

// 45 days. Long enough that a link sitting in an inbox over a holiday still
// works, short enough that a leaked link can't mint a consent record a year
// later. Inside the 30–60 day band the product asked for.
const OPTIN_TTL_DAYS = 45

// PostgREST's shape for "you queried a column that doesn't exist yet". The
// consent columns ship in migrations/no_coverage_optin.sql, which is HELD —
// until it runs, say so plainly instead of 500ing on a cryptic string.
function isMissingColumn(err: any): boolean {
  const msg = String(err?.message || '')
  return err?.code === '42703' || /does not exist/i.test(msg)
}

// "Austin, TX" from whatever intake captured. Null when we hold nothing —
// the email then says "your area", which is true rather than blank.
function areaLabelOf(lead: { city?: string | null; state?: string | null }): string | null {
  const parts = [lead.city, lead.state].map(s => (s || '').trim()).filter(Boolean)
  return parts.length ? parts.join(', ') : null
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // ─── Auth: the load-bearing gate ──────────────────────────────
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }
  if (!isAdmin(hubUser.role)) {
    return NextResponse.json({ error: 'forbidden_admin_only' }, { status: 403 })
  }

  // ─── Load the lead (service client, same as transfer) ─────────
  const { data: existing, error: loadError } = await supabaseService
    .from('leads')
    .select('id, name, first_name, email, city, state, location_id, location_uuid, inbox_dismissed_at, marketing_consented_at')
    .eq('id', id)
    .single()
  if (loadError) {
    if (isMissingColumn(loadError)) {
      return NextResponse.json(
        {
          error: 'migration_not_applied',
          detail: 'migrations/no_coverage_optin.sql has not been run — the consent columns do not exist yet.',
        },
        { status: 503 },
      )
    }
    return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  }
  if (!existing) {
    return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  }

  // No address, no message. This is the one hard precondition: the entire
  // action is "email them", so a lead with no email address has nothing to do
  // here and must not be dismissed on the strength of a send that can't happen.
  const to = (existing.email || '').trim()
  if (!to) {
    return NextResponse.json({ error: 'lead_has_no_email' }, { status: 400 })
  }

  const now = new Date().toISOString()
  const warnings: string[] = []

  // ─── 1. Mint + persist the token ──────────────────────────────
  // Same shape as the invite rail: 24 random bytes → 48 hex chars, stored
  // alongside its expiry. The token is the ONLY key the emailed URL carries —
  // no lead id, no email, no PII in a link that lives forever in an inbox.
  const token = crypto.randomBytes(24).toString('hex')
  const expiresAt = new Date(Date.now() + OPTIN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { error: tokenError } = await supabaseService
    .from('leads')
    .update({
      optin_token: token,
      optin_token_expires_at: expiresAt,
      updated_at: now,
    })
    .eq('id', id)
  if (tokenError) {
    if (isMissingColumn(tokenError)) {
      return NextResponse.json(
        {
          error: 'migration_not_applied',
          detail: 'migrations/no_coverage_optin.sql has not been run — the consent columns do not exist yet.',
        },
        { status: 503 },
      )
    }
    // Nothing sent, nothing hidden. Fully recoverable.
    return NextResponse.json(
      { error: 'optin_token_write_failed', detail: tokenError.message },
      { status: 500 },
    )
  }

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ||
    req.nextUrl?.origin ||
    ''
  const optInUrl = `${origin}/mailing-list/${token}`

  // ─── 2. SEND — the gate ───────────────────────────────────────
  // Corporate sender via sendEmailDirect (see lib/no-coverage-email for why
  // NOT sendEmail). Every outcome, accepted or failed, lands in
  // notification_log by construction.
  const send = await sendNoCoverageEmail({
    to,
    optInUrl,
    leadId: existing.id,
    leadName: existing.name,
    firstName: firstNameOf(existing),
    areaLabel: areaLabelOf(existing),
  })

  if (!send.success) {
    // THE case this ordering exists for. The lead was never dismissed, so it
    // is still sitting in the queue where the operator can retry it.
    return NextResponse.json(
      {
        error: 'send_failed',
        detail: send.error,
        dismissed: false,
        lead_id: id,
      },
      { status: 502 },
    )
  }

  // ─── 3. Dismissed ON SEND (Kevin's rule) ──────────────────────
  // Inbox-scoped only, exactly like the ··· Dismiss action: deriveClientStatus
  // never reads this column, so the person keeps their truthful derived status
  // everywhere else.
  let dismissed = false
  const { error: dismissError } = await supabaseService
    .from('leads')
    .update({ inbox_dismissed_at: now, updated_at: now })
    .eq('id', id)
  if (dismissError) {
    // Email is out; the row stays visible. The SAFE direction — reported, not
    // swallowed, and the client leaves the row in place because of it.
    console.error('[no-coverage] dismiss write failed after a successful send', dismissError)
    warnings.push(`dismiss_write_failed_after_send: ${dismissError.message}`)
  } else {
    dismissed = true
  }

  // ─── 4. System touchpoint (non-fatal) ─────────────────────────
  try {
    const { error: tpError } = await supabaseService.from('touchpoints').insert({
      lead_id:       id,
      location_uuid: existing.location_uuid,
      kind:          'system',
      method:        'system',
      label:         'No coverage — mailing-list invite sent',
      notes:         `Told ${to} we don't serve ${areaLabelOf(existing) || 'their area'} yet, with a link to join the mailing list. Removed from the routing queue.`,
      status:        'done',
      occurred_at:   now,
      user_id:       hubUser.id,
    })
    if (tpError) throw tpError
  } catch (err: any) {
    console.error('[no-coverage] touchpoint insert failed', err)
    warnings.push(`touchpoint_insert_failed: ${err?.message || String(err)}`)
  }

  return NextResponse.json({
    success:        true,
    lead_id:        id,
    sent:           true,
    to,
    // The client removes the row ONLY on true — see the write-order note above.
    dismissed,
    optin_expires_at: expiresAt,
    ...(warnings.length ? { warnings } : {}),
  })
}
