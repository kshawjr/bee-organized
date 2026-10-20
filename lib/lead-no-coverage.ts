// lib/lead-no-coverage.ts
//
// THE NO-COVERAGE CLOSE ITSELF — moved out of
// app/api/leads/[id]/no-coverage/route.ts (20 Oct 2026) so the Slack "Not in
// our service area" button runs exactly the same steps. closeLeadAsNoCoverage
// takes the lead and WHO is doing it; it knows nothing about HTTP sessions.
// The result is the exact status + JSON body the web route has always sent.
//
// The SECOND disposition for an unroutable lead. Route (the sibling endpoint)
// says "this belongs to Boulder"; this one says "nobody covers them". It emails
// the person to tell them so, offers a mailing-list link for when we do reach
// their area, and clears the lead out of the transfer queue.
//
// AUTH is the same load-bearing gate as transfer: isAdmin(role), checked HERE
// on the actor as well as in the web route (a Slack click has no session). The Inbox section and the pill are cosmetic — view-as flips only the
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
//   0. the served-area check               (lib/no-coverage-guard — a zip on
//      a location's list is refused; within 75 measured miles, or a customer
//      Bee Hub can't place, needs the person's confirmation)
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

import crypto from 'node:crypto'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { sendNoCoverageEmail, firstNameOf } from '@/lib/no-coverage-email'
import type { TransferActor, TransferOutcome } from '@/lib/lead-transfer'
import { checkNoCoverage, mayEmailNoCoverage, verdictWords, type NoCoverageVerdict } from '@/lib/no-coverage-guard'
import { retireOtherCards, exitLine, actorName } from '@/lib/other-card-sync'

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

export async function closeLeadAsNoCoverage(args: {
  leadId: string
  actor: TransferActor
  // For the mailing-list link when no site URL env is set. The web route
  // passes its request origin; a caller without one passes null.
  requestOrigin?: string | null
  // The person saw the nearest hive and its miles (or that Bee Hub couldn't
  // measure) and says the customer is out of range. Moves a 'confirm' or
  // 'unmeasured' verdict to sent; does nothing for 'blocked'. See
  // lib/no-coverage-guard.ts.
  confirmedOutOfRange?: boolean
}): Promise<TransferOutcome> {
  const { leadId: id, actor } = args
  const requestOrigin = args.requestOrigin ?? null
  const confirmed = args.confirmedOutOfRange === true

  // ─── The gate, again, on the actor (see the header) ───────────
  if (!isAdmin(actor.role)) {
    return { status: 403, body: { error: 'forbidden_admin_only' } }
  }

  // ─── Load the lead (service client, same as transfer) ─────────
  const { data: existing, error: loadError } = await supabaseService
    .from('leads')
    .select('id, name, first_name, email, city, state, zip, location_id, location_uuid, inbox_dismissed_at, marketing_consented_at')
    .eq('id', id)
    .single()
  if (loadError) {
    if (isMissingColumn(loadError)) {
      return { status: 503, body: {
          error: 'migration_not_applied',
          detail: 'migrations/no_coverage_optin.sql has not been run — the consent columns do not exist yet.',
        } }
    }
    return { status: 404, body: { error: 'lead_not_found' } }
  }
  if (!existing) {
    return { status: 404, body: { error: 'lead_not_found' } }
  }

  // No address, no message. This is the one hard precondition: the entire
  // action is "email them", so a lead with no email address has nothing to do
  // here and must not be dismissed on the strength of a send that can't happen.
  // ─── Served area? (lib/no-coverage-guard) — BEFORE anything is minted ──
  // The one check every door goes through. A zip on a location's list is
  // refused outright; a hive within 75 measured miles, or a customer Bee Hub
  // can't place, needs the person's confirmation. A failed check refuses:
  // "couldn't check" must never become "told someone in a territory".
  let verdict: NoCoverageVerdict
  try {
    verdict = await checkNoCoverage({ id: existing.id, zip: existing.zip ?? null, state: existing.state ?? null })
  } catch (err: any) {
    return {
      status: 503,
      body: { error: 'coverage_check_failed', detail: `Bee Hub couldn't check whether this customer is in a served area (${err?.message || err}). Nothing was sent.` },
    }
  }
  if (!mayEmailNoCoverage(verdict, confirmed)) {
    if (verdict.kind === 'blocked') {
      return { status: 409, body: { error: 'zip_claimed', detail: verdictWords(verdict), verdict } }
    }
    return { status: 409, body: { error: 'needs_confirmation', detail: verdictWords(verdict), verdict } }
  }

  const to = (existing.email || '').trim()
  if (!to) {
    return { status: 400, body: { error: 'lead_has_no_email' } }
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
      return { status: 503, body: {
          error: 'migration_not_applied',
          detail: 'migrations/no_coverage_optin.sql has not been run — the consent columns do not exist yet.',
        } }
    }
    // Nothing sent, nothing hidden. Fully recoverable.
    return { status: 500, body: { error: 'optin_token_write_failed', detail: tokenError.message } }
  }

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ||
    requestOrigin ||
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
    return { status: 502, body: {
        error: 'send_failed',
        detail: send.error,
        dismissed: false,
        lead_id: id,
      } }
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

  // ─── Other's Slack card, if it had one (lib/other-card-sync) ────
  // The email is out; the card says so and loses its buttons. Never fails.
  try {
    const who = await actorName(actor.hubUserId)
    await retireOtherCards({ leadId: id, resolution: 'no_coverage', line: exitLine('no_coverage', { to, who }) })
  } catch (err: any) {
    console.error('[no-coverage] slack card edit failed', err)
  }

  // ─── 4. System touchpoint (non-fatal) ─────────────────────────
  try {
    const { error: tpError } = await supabaseService.from('touchpoints').insert({
      lead_id:       id,
      location_uuid: existing.location_uuid,
      kind:          'system',
      method:        'system',
      label:         'No coverage — mailing-list invite sent',
      notes:         `Told ${to} we don't serve ${areaLabelOf(existing) || 'their area'} yet, with a link to join the mailing list. Removed from the routing queue.` +
        (verdict.kind === 'clear' ? '' : ` Sent after confirming they're out of range: ${verdictWords(verdict)}`),
      status:        'done',
      occurred_at:   now,
      user_id:       actor.hubUserId,
    })
    if (tpError) throw tpError
  } catch (err: any) {
    console.error('[no-coverage] touchpoint insert failed', err)
    warnings.push(`touchpoint_insert_failed: ${err?.message || String(err)}`)
  }

  return { status: 200, body: {
    success:        true,
    lead_id:        id,
    sent:           true,
    to,
    // The client removes the row ONLY on true — see the write-order note above.
    dismissed,
    optin_expires_at: expiresAt,
    verdict,
    ...(warnings.length ? { warnings } : {}),
  } }
}
