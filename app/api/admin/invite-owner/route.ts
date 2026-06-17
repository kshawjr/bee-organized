// app/api/admin/invite-owner/route.ts
//
// One-click "Invite Owner" for corp-sponsored launches. Replaces the
// 3-statement SQL ritual Kevin used to run by hand when onboarding a new
// franchise owner. Does ALL THREE writes in one request, with rollback if
// any later write fails, then sends the invite email via Resend.
//
//   1. UPDATE locations    — payment_source, paid_through_date,
//                            subscription_status='deferred',
//                            lifecycle_status='onboarding',
//                            subscription_plan='owner_annual', billing_notes,
//                            onboarding_state={} (fresh checklist).
//   2. INSERT subscription_seats — tier='owner', user_id=NULL, status='active',
//                            prorated_cost=0. PRE-allocating the seat is the
//                            critical fix: the accept route (/auth/invite/[token])
//                            PATCHes an existing unassigned owner seat to the new
//                            user. With no seat, accept 409s and the owner is
//                            locked out. We reuse an existing unclaimed owner
//                            seat if one is already present (idempotent on retry).
//   3. INSERT pending_invites — role='owner', tier='owner', a fresh invite_token,
//                            7-day expiry, invited_by=<this super_admin>.
//
// Rollback ordering (best effort, sequential — Supabase JS has no transaction):
//   - seat insert fails    → restore the location's prior billing fields.
//   - invite insert fails  → delete the seat we just created (only if WE
//                            created it — a reused pre-existing seat is left
//                            alone), then restore the location's prior fields.
//
// Email failure does NOT roll back — the invite row is valid and the caller
// can copy the link from the success modal. email_sent / warning surface it.
//
// Auth: super_admin only (matches /api/locations/[id]/subscription PATCH).
//
// Safety: refuses (409, requires_confirmation) when the location already has a
// CLAIMED owner seat, an outstanding owner invite, or lifecycle_status='active'
// — unless the caller resubmits with { force: true }.

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { sendEmailDirect } from '@/lib/resend'

export const runtime = 'nodejs'

// System sender for owner invites. The location has no owner yet, so its
// per-location sender fields (send_from_email/sender_name/reply_to_email) are
// still NULL — we send as the verified system sender, same as
// /api/hub_users/invite.
const INVITE_FROM_EMAIL =
  process.env.INVITE_FROM_EMAIL || 'admin@beeorganized.com'
const INVITE_FROM_NAME = process.env.INVITE_FROM_NAME || 'Kevin Shaw'
const INVITE_REPLY_TO_EMAIL =
  process.env.INVITE_REPLY_TO_EMAIL || 'admin@beeorganized.com'

const INVITE_TTL_DAYS = 7

// payment_source values the form offers. corporate_sponsored is allowed but
// flagged: the legacy billing toggle nulls paid_through_date for it, so the
// recommended default is prepaid_corporate (keeps the conversion date).
const VALID_PAYMENT_SOURCES = [
  'prepaid_corporate',
  'corporate_sponsored',
  'direct',
] as const
type PaymentSource = (typeof VALID_PAYMENT_SOURCES)[number]

// Fields we snapshot before the location UPDATE so we can restore them if a
// later write fails. Keep in sync with the update payload below.
const LOC_SNAPSHOT_COLS =
  'payment_source, paid_through_date, subscription_status, lifecycle_status, subscription_plan, billing_notes, onboarding_state'

function isValidEmail(s: unknown): s is string {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}

// Accepts 'YYYY-MM-DD' (the <input type=date> wire format). Empty/undefined is
// allowed — paid_through_date is nullable.
function isValidDateOrEmpty(s: unknown): boolean {
  if (s === undefined || s === null || s === '') return true
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatExpiry(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  } catch {
    return iso
  }
}

// Owner-flavored invite email. Mirrors the franchise template in
// /api/hub_users/invite (5-step onboarding outline) but is self-contained so
// this route never depends on that one — changing one won't silently change
// the other.
function buildOwnerInviteEmail(args: {
  inviteUrl: string
  locationName: string
  inviterName: string
  expiresAt: string
  inviteeName: string | null
}): { html: string; text: string } {
  const { inviteUrl, locationName, inviterName, expiresAt, inviteeName } = args
  const expiryFormatted = formatExpiry(expiresAt)
  const greeting = inviteeName ? `Hi ${inviteeName},` : 'Hello,'

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f7f5f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a2e2b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f5f0;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;box-shadow:0 4px 24px rgba(26,46,43,0.08);overflow:hidden;">
            <tr>
              <td style="padding:32px 32px 24px;">
                <div style="font-size:32px;margin-bottom:8px;">🐝</div>
                <h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:22px;color:#1a2e2b;">You've been invited to ${escapeHtml(locationName)}</h1>
                <p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1a2e2b;">${escapeHtml(greeting)}</p>
                <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  <strong>${escapeHtml(inviterName)}</strong> has invited you to join <strong>${escapeHtml(locationName)}</strong> as the owner on Bee Hub — the operations platform Bee Organized uses to manage clients, jobs, and your team day to day.
                </p>
                <p style="margin:0 0 6px;font-size:15px;font-weight:600;line-height:1.55;color:#1a2e2b;">What to expect during onboarding:</p>
                <p style="margin:0 0 10px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  Once you accept the invitation, we'll walk you through 5 quick steps:
                </p>
                <ol style="margin:0 0 18px;padding-left:22px;font-size:15px;line-height:1.6;color:#1a2e2b;">
                  <li>Set up your business details (name, phone, address)</li>
                  <li>Connect your Jobber account to sync existing clients</li>
                  <li>Configure drip paths for nurturing new leads</li>
                  <li>Set your email and notification preferences</li>
                  <li>Invite any team members</li>
                </ol>
                <p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  Before you start, please have your Google Business Reviews link ready.
                </p>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  Bee Hub uses Google Sign-In — no password needed. Just click the link below to get started.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
                  <tr>
                    <td style="background:#1a2e2b;border-radius:10px;">
                      <a href="${inviteUrl}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;font-family:inherit;">Accept Invitation</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 8px;font-size:12px;color:#8a9e9a;">Or paste this link into your browser:</p>
                <p style="margin:0 0 20px;font-size:12px;color:#4a5e5a;word-break:break-all;font-family:ui-monospace,Menlo,monospace;">${escapeHtml(inviteUrl)}</p>
                <p style="margin:0;font-size:12px;color:#8a9e9a;line-height:1.5;">This invitation expires on <strong>${escapeHtml(expiryFormatted)}</strong>. If you weren't expecting this email, you can safely ignore it.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px;border-top:1px solid rgba(0,0,0,0.06);">
                <p style="margin:0;font-size:11px;color:#8a9e9a;">Sent by Bee Organized · You're receiving this because ${escapeHtml(inviterName)} invited you to ${escapeHtml(locationName)}.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

  const text = [
    greeting,
    '',
    `${inviterName} has invited you to join ${locationName} as the owner on Bee Hub — the operations platform Bee Organized uses to manage clients, jobs, and your team day to day.`,
    '',
    'What to expect during onboarding:',
    '',
    "Once you accept the invitation, we'll walk you through 5 quick steps:",
    '  1. Set up your business details (name, phone, address)',
    '  2. Connect your Jobber account to sync existing clients',
    '  3. Configure drip paths for nurturing new leads',
    '  4. Set your email and notification preferences',
    '  5. Invite any team members',
    '',
    'Before you start, please have your Google Business Reviews link ready.',
    '',
    'Bee Hub uses Google Sign-In — no password needed. Just click the link below to get started.',
    '',
    'Accept the invitation here:',
    inviteUrl,
    '',
    `This invitation expires on ${expiryFormatted}.`,
    "If you weren't expecting this email, you can safely ignore it.",
    '',
    '—',
    'Bee Organized',
  ].join('\n')

  return { html, text }
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role')
    .eq('id', user.id)
    .single()
  if (!caller || caller.role !== 'super_admin') {
    return NextResponse.json(
      { error: 'forbidden — super_admin only' },
      { status: 403 }
    )
  }

  const body = await request.json().catch(() => ({}))
  const {
    location_id,
    email,
    full_name,
    payment_source,
    paid_through_date,
    billing_notes,
    force,
  } = body || {}

  // ─── Validation ───
  if (typeof location_id !== 'string' || !location_id) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'valid email required' }, { status: 400 })
  }
  if (typeof full_name !== 'string' || !full_name.trim()) {
    return NextResponse.json({ error: 'full_name required' }, { status: 400 })
  }
  if (!VALID_PAYMENT_SOURCES.includes(payment_source)) {
    return NextResponse.json(
      {
        error: `invalid payment_source — must be one of: ${VALID_PAYMENT_SOURCES.join(', ')}`,
      },
      { status: 400 }
    )
  }
  if (!isValidDateOrEmpty(paid_through_date)) {
    return NextResponse.json(
      { error: 'paid_through_date must be YYYY-MM-DD or empty' },
      { status: 400 }
    )
  }
  if (billing_notes !== undefined && billing_notes !== null && typeof billing_notes !== 'string') {
    return NextResponse.json(
      { error: 'billing_notes must be a string' },
      { status: 400 }
    )
  }

  const normalizedEmail = String(email).trim().toLowerCase()
  const trimmedName = String(full_name).trim()
  const source = payment_source as PaymentSource
  const paidThrough =
    typeof paid_through_date === 'string' && paid_through_date.trim()
      ? paid_through_date.trim()
      : null
  const notes =
    typeof billing_notes === 'string' && billing_notes.trim()
      ? billing_notes.trim()
      : null

  // ─── Load location (and snapshot fields for rollback) ───
  const { data: priorLoc, error: locFetchErr } = await supabaseService
    .from('locations')
    .select(`id, name, ${LOC_SNAPSHOT_COLS}`)
    .eq('id', location_id)
    .maybeSingle()
  if (locFetchErr) {
    console.error('[invite-owner location fetch]', locFetchErr)
    return NextResponse.json({ error: locFetchErr.message }, { status: 500 })
  }
  if (!priorLoc) {
    return NextResponse.json({ error: 'location not found' }, { status: 404 })
  }

  // ─── Refuse duplicate hub_user at this location (would double-claim) ───
  const { data: existingHubUser } = await supabaseService
    .from('hub_users')
    .select('id')
    .eq('email', normalizedEmail)
    .eq('location_id', location_id)
    .limit(1)
  if (existingHubUser && existingHubUser.length > 0) {
    return NextResponse.json(
      { error: 'A user with this email already exists at this location.' },
      { status: 409 }
    )
  }

  // ─── Owner-seat / pending-invite landscape ───
  const { data: ownerSeats, error: seatsErr } = await supabaseService
    .from('subscription_seats')
    .select('id, user_id, status')
    .eq('location_id', location_id)
    .eq('tier', 'owner')
    .eq('status', 'active')
  if (seatsErr) {
    console.error('[invite-owner owner seats fetch]', seatsErr)
    return NextResponse.json({ error: seatsErr.message }, { status: 500 })
  }
  const claimedOwnerSeat = (ownerSeats || []).find((s: any) => s.user_id)
  const unclaimedOwnerSeat = (ownerSeats || []).find((s: any) => !s.user_id)

  // Hard cap at 2 owner seats per location — enforced even with force=true
  // (a cap, not a warning). The route reuses an existing UNCLAIMED owner seat
  // when one is present (no new seat created), so the only way to exceed the
  // cap is when we'd have to CREATE a 3rd seat: i.e. 2 active seats already
  // exist and none of them is free to reuse.
  if (!unclaimedOwnerSeat && (ownerSeats || []).length >= 2) {
    return NextResponse.json(
      {
        error: 'max_owners_reached',
        message:
          'This location already has 2 owners (the maximum). Remove one before adding another.',
      },
      { status: 409 }
    )
  }

  const { data: pendingOwnerInvite } = await supabaseService
    .from('pending_invites')
    .select('id, email')
    .eq('location_id', location_id)
    .eq('tier', 'owner')
    .is('accepted_at', null)
    .limit(1)
    .maybeSingle()

  // ─── Safety gate: surface all blocking conditions at once. Caller
  //     resubmits with { force: true } to proceed. ───
  if (!force) {
    const warnings: { code: string; message: string }[] = []
    if (claimedOwnerSeat) {
      warnings.push({
        code: 'owner_exists',
        message:
          'This location already has an owner. Adding this person will make them a co-owner with full access alongside the existing owner.',
      })
    }
    if (pendingOwnerInvite) {
      warnings.push({
        code: 'invite_exists',
        message: `An owner invitation is already outstanding (${pendingOwnerInvite.email}). Continuing will create another.`,
      })
    }
    if (priorLoc.lifecycle_status === 'active') {
      warnings.push({
        code: 'already_active',
        message:
          'This location is already launched (lifecycle_status=active). Continuing resets it to the onboarding state.',
      })
    }
    if (warnings.length > 0) {
      return NextResponse.json(
        { requires_confirmation: true, warnings },
        { status: 409 }
      )
    }
  }

  // ─── Write 1: location config ───
  const { error: locUpdateErr } = await supabaseService
    .from('locations')
    .update({
      payment_source: source,
      paid_through_date: paidThrough,
      subscription_status: 'deferred',
      lifecycle_status: 'onboarding',
      subscription_plan: 'owner_annual',
      billing_notes: notes,
      onboarding_state: {},
      updated_at: new Date().toISOString(),
    })
    .eq('id', location_id)
  if (locUpdateErr) {
    console.error('[invite-owner location update]', locUpdateErr)
    return NextResponse.json({ error: locUpdateErr.message }, { status: 500 })
  }

  // Restores the location's pre-update billing fields. Used by every rollback
  // path below. Logs (doesn't throw) if the restore itself fails — at that
  // point the best we can do is leave a breadcrumb.
  async function rollbackLocation() {
    const { error: rbErr } = await supabaseService
      .from('locations')
      .update({
        payment_source: priorLoc!.payment_source,
        paid_through_date: priorLoc!.paid_through_date,
        subscription_status: priorLoc!.subscription_status,
        lifecycle_status: priorLoc!.lifecycle_status,
        subscription_plan: priorLoc!.subscription_plan,
        billing_notes: priorLoc!.billing_notes,
        onboarding_state: priorLoc!.onboarding_state,
      })
      .eq('id', location_id)
    if (rbErr) {
      console.error(
        '[invite-owner rollback location failed — manual fix needed]',
        location_id,
        rbErr
      )
    }
  }

  // ─── Write 2: owner seat (reuse an unclaimed one if present) ───
  let seatId: string
  let seatCreated = false
  if (unclaimedOwnerSeat) {
    seatId = unclaimedOwnerSeat.id
  } else {
    const { data: insertedSeat, error: seatErr } = await supabaseService
      .from('subscription_seats')
      .insert({
        location_id,
        tier: 'owner',
        user_id: null,
        status: 'active',
        prorated_cost: 0,
        added_by: caller.id,
        notes: 'Corp-sponsored owner seat',
      })
      .select('id')
      .single()
    if (seatErr || !insertedSeat) {
      console.error('[invite-owner seat insert]', seatErr)
      await rollbackLocation()
      return NextResponse.json(
        { error: seatErr?.message || 'Could not create owner seat' },
        { status: 500 }
      )
    }
    seatId = insertedSeat.id
    seatCreated = true
  }

  // ─── Write 3: pending invite ───
  const inviteToken = crypto.randomBytes(24).toString('hex')
  const expiresAt = new Date(
    Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  const { data: invite, error: inviteErr } = await supabaseService
    .from('pending_invites')
    .insert({
      location_id,
      email: normalizedEmail,
      full_name: trimmedName,
      role: 'owner',
      tier: 'owner',
      invite_token: inviteToken,
      invite_expires_at: expiresAt,
      invited_by: caller.id,
    })
    .select('id, email, full_name, role, tier, location_id, invite_expires_at, created_at')
    .single()

  if (inviteErr || !invite) {
    // Roll back in reverse order: drop the seat we created (never a reused
    // one — that pre-dates this request), then restore the location.
    if (seatCreated) {
      const { error: seatRbErr } = await supabaseService
        .from('subscription_seats')
        .delete()
        .eq('id', seatId)
      if (seatRbErr) {
        console.error(
          '[invite-owner rollback seat failed — orphan seat]',
          seatId,
          seatRbErr
        )
      }
    }
    await rollbackLocation()
    console.error('[invite-owner invite insert]', inviteErr)
    return NextResponse.json(
      { error: inviteErr?.message || 'Could not create invite' },
      { status: 500 }
    )
  }

  // ─── Invite URL ───
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
    request.nextUrl.origin
  const invite_url = `${origin}/auth/invite/${inviteToken}`

  // ─── Email (best effort — failure doesn't roll back) ───
  let email_sent = false
  let email_error: string | undefined
  try {
    const { data: inviter } = await supabaseService
      .from('hub_users')
      .select('full_name, first_name, email')
      .eq('id', caller.id)
      .single()

    const inviterName =
      inviter?.full_name?.trim() ||
      inviter?.first_name?.trim() ||
      inviter?.email ||
      'Bee Organized'
    const inviteeName = trimmedName ? trimmedName.split(/\s+/)[0] : null

    const { html, text } = buildOwnerInviteEmail({
      inviteUrl: invite_url,
      locationName: priorLoc.name || 'Bee Organized',
      inviterName,
      expiresAt,
      inviteeName,
    })

    const result = await sendEmailDirect({
      from: INVITE_FROM_EMAIL,
      fromName: INVITE_FROM_NAME,
      replyTo: INVITE_REPLY_TO_EMAIL,
      to: normalizedEmail,
      subject: `You've been invited to join ${priorLoc.name || 'Bee Organized'} on Bee Hub`,
      html,
      text,
    })

    if (result.success) {
      email_sent = true
    } else {
      email_error = result.error
      console.error('[invite-owner email send]', email_error)
    }
  } catch (err) {
    email_error = err instanceof Error ? err.message : String(err)
    console.error('[invite-owner email send] unexpected error', err)
  }

  return NextResponse.json(
    {
      success: true,
      invite,
      invite_token: inviteToken,
      invite_url,
      email_sent,
      seat_reused: !seatCreated,
      ...(email_error
        ? { warning: 'Invite created but email could not be sent.', email_error }
        : {}),
    },
    { status: 201 }
  )
}
