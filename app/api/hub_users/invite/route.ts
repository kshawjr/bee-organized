// app/api/hub_users/invite/route.ts
//
// Create a pending team invite. Generates a one-time invite_token, stores
// the invitee's email + tier + role on a pending_invites row, and returns
// the shareable invite URL. The seat is NOT pre-claimed — that happens
// when the invitee accepts via /auth/invite/[token] and the accept route
// PATCHes one available subscription_seats row to user_id = auth.uid().
//
// Auth: super_admin/admin OR the owner of the target location.
// RLS backstops via pending_invites policies (see invite_tokens.sql).

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { sendEmailDirect } from '@/lib/resend'

export const runtime = 'nodejs'

// System sender for invite emails. Owner invites (and corporate admin invites)
// can't use the per-location sender — a fresh location has no owner yet, so
// send_from_email/sender_name/reply_to_email are NULL until onboarding.
// Defaults point at admin@beeorganized.com, the verified Resend sender used
// by drip emails. Override via env if the sender ever changes.
const INVITE_FROM_EMAIL =
  process.env.INVITE_FROM_EMAIL || 'admin@beeorganized.com'
const INVITE_FROM_NAME = process.env.INVITE_FROM_NAME || 'Kevin Shaw'
const INVITE_REPLY_TO_EMAIL =
  process.env.INVITE_REPLY_TO_EMAIL || 'admin@beeorganized.com'

// 'admin' is the corporate-invite tier — no location, no subscription_seat
// claim, role becomes 'admin' in hub_users. Franchise tiers (owner/manager/
// light/readonly) all require a location_id and claim one seat at accept.
const VALID_TIERS = ['owner', 'manager', 'light', 'readonly', 'admin'] as const
type Tier = (typeof VALID_TIERS)[number]

const INVITE_TTL_DAYS = 7

// hub_users.role enum lookup. Carve-outs from the default 'lite_user':
//   tier='owner'   → role='owner'   (full location access)
//   tier='manager' → role='manager' (operational lead: leads + CRM + feedback
//                    for their location, but no billing/team/drip/Jobber config)
//   tier='admin'   → role='admin'   (corporate, no location)
// Worker Bee (light) and Honey Watcher (readonly) are the genuine read-only
// tiers and stay 'lite_user'. super_admin is intentionally not invitable here;
// promotions are a manual Supabase touch.
function roleForTier(tier: Tier): string {
  if (tier === 'owner') return 'owner'
  if (tier === 'manager') return 'manager'
  if (tier === 'admin') return 'admin'
  return 'lite_user'
}

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
}

function isValidEmail(s: string): boolean {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
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
      year: 'numeric', month: 'long', day: 'numeric',
    })
  } catch {
    return iso
  }
}

// locationName is null for corporate (admin-tier) invites — those have no
// location, so the email drops the "join <location>" framing and skips the
// 5-step franchise onboarding outline.
function buildInviteEmail(args: {
  inviteUrl: string
  locationName: string | null
  inviterName: string
  expiresAt: string
  inviteeName: string | null
}): { html: string; text: string } {
  const { inviteUrl, locationName, inviterName, expiresAt, inviteeName } = args
  const expiryFormatted = formatExpiry(expiresAt)
  const greeting = inviteeName ? `Hi ${inviteeName},` : 'Hello,'
  const isCorporate = !locationName

  const headline = isCorporate
    ? 'You\'ve been invited to Bee Hub'
    : `You've been invited to ${escapeHtml(locationName!)}`
  const intro = isCorporate
    ? `<strong>${escapeHtml(inviterName)}</strong> has invited you to join Bee Hub — the operations platform Bee Organized uses to manage clients, jobs, and your team day to day.`
    : `<strong>${escapeHtml(inviterName)}</strong> has invited you to join <strong>${escapeHtml(locationName!)}</strong> on Bee Hub — the operations platform Bee Organized uses to manage clients, jobs, and your team day to day.`
  const footerLocation = isCorporate ? 'Bee Hub' : escapeHtml(locationName!)

  const onboardingBlockHtml = isCorporate
    ? `<p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  Once you accept, you'll set up your account. Bee Hub uses Google Sign-In — no password needed.
                </p>`
    : `<p style="margin:0 0 6px;font-size:15px;font-weight:600;line-height:1.55;color:#1a2e2b;">What to expect during onboarding:</p>
                <p style="margin:0 0 10px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  Once you accept the invitation, we'll walk you through 5 quick steps:
                </p>
                <ol style="margin:0 0 18px;padding-left:22px;font-size:15px;line-height:1.6;color:#1a2e2b;">
                  <li>Set up your business details (name, phone, address)</li>
                  <li>Connect your Jobber account to sync existing clients</li>
                  <li>Set up the emails new leads receive automatically</li>
                  <li>Set your email and notification preferences</li>
                  <li>Invite any team members</li>
                </ol>
                <p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  Before you start, please have your Google Business Reviews link ready.
                </p>
                <p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  <strong>Estimated time:</strong> 15 minutes.
                </p>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  Bee Hub uses Google Sign-In — no password needed. Just click the link below to get started.
                </p>`

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
                <h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:22px;color:#1a2e2b;">${headline}</h1>
                <p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1a2e2b;">${escapeHtml(greeting)}</p>
                <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  ${intro}
                </p>
                ${onboardingBlockHtml}
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
                <p style="margin:0;font-size:11px;color:#8a9e9a;">Sent by Bee Organized · You're receiving this because ${escapeHtml(inviterName)} invited you to ${footerLocation}.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

  const introText = isCorporate
    ? `${inviterName} has invited you to join Bee Hub — the operations platform Bee Organized uses to manage clients, jobs, and your team day to day.`
    : `${inviterName} has invited you to join ${locationName} on Bee Hub — the operations platform Bee Organized uses to manage clients, jobs, and your team day to day.`

  const onboardingText = isCorporate
    ? [
        '',
        'Once you accept, you\'ll set up your account. Bee Hub uses Google Sign-In — no password needed.',
      ]
    : [
        '',
        'What to expect during onboarding:',
        '',
        'Once you accept the invitation, we\'ll walk you through 5 quick steps:',
        '  1. Set up your business details (name, phone, address)',
        '  2. Connect your Jobber account to sync existing clients',
        '  3. Set up the emails new leads receive automatically',
        '  4. Set your email and notification preferences',
        '  5. Invite any team members',
        '',
        'Before you start, please have your Google Business Reviews link ready.',
        '',
        'Estimated time: 15 minutes.',
        '',
        'Bee Hub uses Google Sign-In — no password needed. Just click the link below to get started.',
      ]

  const text = [
    greeting,
    '',
    introText,
    ...onboardingText,
    '',
    'Accept the invitation here:',
    inviteUrl,
    '',
    `This invitation expires on ${expiryFormatted}.`,
    'If you weren\'t expecting this email, you can safely ignore it.',
    '',
    '—',
    'Bee Organized',
  ].join('\n')

  return { html, text }
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: caller } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!caller) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const { email, full_name, tier } = body || {}
  // tier='admin' invites are location-less corporate invites; everything
  // else (owner/manager/light/readonly) is franchise and requires a location.
  const isCorporateTier = tier === 'admin'
  const location_id: string | null = isCorporateTier
    ? null
    : (typeof body?.location_id === 'string' ? body.location_id : null)

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'valid email required' }, { status: 400 })
  }
  if (!VALID_TIERS.includes(tier)) {
    return NextResponse.json(
      { error: `invalid tier — must be one of: ${VALID_TIERS.join(', ')}` },
      { status: 400 }
    )
  }
  if (tier === 'light') {
    return NextResponse.json(
      { error: 'tier_unavailable', message: 'Worker Bee tier is currently unavailable. Use Honey Watcher for read-only access.' },
      { status: 503 }
    )
  }
  if (!isCorporateTier && !location_id) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }

  // Authorization:
  //   - Corporate (admin) invites: super_admin only. Existing admins can't
  //     invite more admins — privilege escalation is intentionally a
  //     super_admin touch.
  //   - Franchise invites: super_admin/admin OR owner of the target location.
  if (isCorporateTier) {
    if (caller.role !== 'super_admin') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  } else {
    const isOwnerOfLocation =
      caller.role === 'owner' && caller.location_id === location_id
    if (!isElevated(caller.role) && !isOwnerOfLocation) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  const normalizedEmail = String(email).trim().toLowerCase()

  // Duplicate check.
  //   - Corporate invites: refuse if the email is ANY existing hub_user. A
  //     single human shouldn't accept a corporate invite while already
  //     holding a franchise seat (or vice versa) — the accept route would
  //     overwrite their location/role.
  //   - Franchise invites: refuse only if the email already holds a seat at
  //     this location (same email at a different location is a separate
  //     identity story we tolerate).
  let dupeQuery = supabaseService
    .from('hub_users')
    .select('id, location_id, email')
    .eq('email', normalizedEmail)
    .limit(1)
  if (!isCorporateTier && location_id) {
    dupeQuery = dupeQuery.eq('location_id', location_id)
  }
  const { data: existing } = await dupeQuery
  if (existing && existing.length > 0) {
    return NextResponse.json(
      {
        error: isCorporateTier
          ? 'A user with this email already exists.'
          : 'A team member with this email already exists at this location.',
      },
      { status: 409 }
    )
  }

  // Seat availability is a franchise-tier concept. Corporate invites don't
  // claim a subscription_seats row, so we skip the gate.
  if (!isCorporateTier && location_id) {
    // Available seats at the requested tier (subtract pending invites at the
    // same tier — we don't pre-claim seats, but counts must reflect outstanding
    // reservations so two invites can't be issued against one slot).
    const { data: seatsAtTier, error: seatsErr } = await supabaseService
      .from('subscription_seats')
      .select('id, user_id, status')
      .eq('location_id', location_id)
      .eq('tier', tier)
      .eq('status', 'active')
    if (seatsErr) {
      console.error('[invite seats fetch]', seatsErr)
      return NextResponse.json({ error: seatsErr.message }, { status: 500 })
    }
    const availableSeats = (seatsAtTier || []).filter((s: any) => !s.user_id).length

    const { count: pendingCount, error: pendingErr } = await supabaseService
      .from('pending_invites')
      .select('id', { count: 'exact', head: true })
      .eq('location_id', location_id)
      .eq('tier', tier)
      .is('accepted_at', null)
    if (pendingErr) {
      console.error('[invite pending count]', pendingErr)
      return NextResponse.json({ error: pendingErr.message }, { status: 500 })
    }

    if (availableSeats - (pendingCount || 0) < 1) {
      return NextResponse.json(
        {
          error:
            'No available seats at this tier. Add more seats before inviting.',
          code: 'no_available_seats',
        },
        { status: 409 }
      )
    }
  }

  const inviteToken = crypto.randomBytes(24).toString('hex')
  const expiresAt = new Date(
    Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  const { data: invite, error: insertErr } = await supabaseService
    .from('pending_invites')
    .insert({
      location_id,
      email: normalizedEmail,
      full_name: typeof full_name === 'string' && full_name.trim() ? full_name.trim() : null,
      role: roleForTier(tier as Tier),
      tier,
      invite_token: inviteToken,
      invite_expires_at: expiresAt,
      invited_by: caller.id,
    })
    .select('id, email, full_name, role, tier, location_id, invite_token, invite_expires_at, created_at')
    .single()

  if (insertErr) {
    console.error('[invite insert]', insertErr)
    return NextResponse.json({ error: insertErr.message }, { status: 500 })
  }

  // Build the absolute invite URL from the request origin so prod / preview
  // / local each get the right host. NEXT_PUBLIC_SITE_URL is the override
  // for fronted-by-proxy deploys where request origin doesn't match.
  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
    request.nextUrl.origin
  const invite_url = `${origin}/auth/invite/${inviteToken}`

  // Send invite email via the system sender. We can't use the per-location
  // sender here because owner invites go out *before* the owner has
  // onboarded, so the location's send_from_email/sender_name/reply_to_email
  // are still NULL. Corporate (admin-tier) invites have no location at all.
  // Failure here doesn't roll back the invite row — the inviter can still
  // copy the link from the UI as a fallback. email_sent / email_error
  // surface the outcome so the client can adjust messaging.
  let email_sent = false
  let email_error: string | undefined
  try {
    const inviterPromise = supabaseService
      .from('hub_users')
      .select('full_name, first_name, email')
      .eq('id', caller.id)
      .single()
    const locationPromise = location_id
      ? supabaseService
          .from('locations')
          .select('name')
          .eq('id', location_id)
          .single()
      : Promise.resolve({ data: null as { name: string | null } | null })

    const [{ data: location }, { data: inviter }] = await Promise.all([
      locationPromise,
      inviterPromise,
    ])

    const locationName = location?.name ?? null
    const inviterName =
      inviter?.full_name?.trim() ||
      inviter?.first_name?.trim() ||
      inviter?.email ||
      'Your team'
    const inviteeName =
      typeof full_name === 'string' && full_name.trim()
        ? full_name.trim().split(/\s+/)[0]
        : null

    const { html, text } = buildInviteEmail({
      inviteUrl: invite_url,
      locationName,
      inviterName,
      expiresAt: expiresAt,
      inviteeName,
    })

    const result = await sendEmailDirect({
      from: INVITE_FROM_EMAIL,
      fromName: INVITE_FROM_NAME,
      replyTo: INVITE_REPLY_TO_EMAIL,
      to: normalizedEmail,
      subject: locationName
        ? `You've been invited to join ${locationName} on Bee Hub`
        : `You've been invited to join Bee Hub`,
      html,
      text,
    })

    if (result.success) {
      email_sent = true
    } else {
      email_error = result.error
      console.error('[invite email send]', email_error)
    }
  } catch (err) {
    email_error = err instanceof Error ? err.message : String(err)
    console.error('[invite email send] unexpected error', err)
  }

  return NextResponse.json(
    { invite, invite_url, email_sent, ...(email_error ? { email_error } : {}) },
    { status: 201 }
  )
}
