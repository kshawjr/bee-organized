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
import { sendEmail } from '@/lib/resend'

export const runtime = 'nodejs'

const VALID_TIERS = ['owner', 'manager', 'light', 'readonly'] as const
type Tier = (typeof VALID_TIERS)[number]

const INVITE_TTL_DAYS = 7

// hub_users.role enum lookup — invited team members are 'lite_user' regardless
// of seat tier (manager / light / readonly). Owner-tier seats only get created
// during onboarding co-owner flow (out of scope here).
function roleForTier(tier: Tier): string {
  if (tier === 'owner') return 'owner'
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

function buildInviteEmail(args: {
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
                <p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  <strong>${escapeHtml(inviterName)}</strong> has invited you to join <strong>${escapeHtml(locationName)}</strong> on Bee Hub —
                  the operations platform we use to manage clients, jobs, and our team day to day.
                </p>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#1a2e2b;">
                  Accept the invitation below to set up your account.
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
    `${inviterName} has invited you to join ${locationName} on Bee Hub — the operations platform we use to manage clients, jobs, and our team day to day.`,
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
  const { email, full_name, location_id, tier } = body || {}

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: 'valid email required' }, { status: 400 })
  }
  if (typeof location_id !== 'string' || !location_id) {
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }
  if (!VALID_TIERS.includes(tier)) {
    return NextResponse.json(
      { error: `invalid tier — must be one of: ${VALID_TIERS.join(', ')}` },
      { status: 400 }
    )
  }

  const isOwnerOfLocation =
    caller.role === 'owner' && caller.location_id === location_id
  if (!isElevated(caller.role) && !isOwnerOfLocation) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const normalizedEmail = String(email).trim().toLowerCase()

  // Refuse if the email is already a hub_user at this location — they'd
  // double-claim a seat on accept. (We tolerate the same email at a
  // different location; that's a separate identity story.)
  const { data: existing } = await supabaseService
    .from('hub_users')
    .select('id, location_id, email')
    .eq('email', normalizedEmail)
    .eq('location_id', location_id)
    .limit(1)
  if (existing && existing.length > 0) {
    return NextResponse.json(
      { error: 'A team member with this email already exists at this location.' },
      { status: 409 }
    )
  }

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

  // Send invite email. Failure here doesn't roll back the invite row — the
  // owner can still copy the link from the UI as a fallback. We surface the
  // outcome via email_sent / email_error so the client can adjust messaging.
  let email_sent = false
  let email_error: string | undefined
  try {
    const [{ data: location }, { data: inviter }] = await Promise.all([
      supabaseService
        .from('locations')
        .select('name')
        .eq('id', location_id)
        .single(),
      supabaseService
        .from('hub_users')
        .select('full_name, first_name, email')
        .eq('id', caller.id)
        .single(),
    ])

    const locationName = location?.name || 'Bee Hub'
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

    const result = await sendEmail({
      locationId: location_id,
      to: normalizedEmail,
      subject: `You've been invited to join ${locationName} on Bee Hub`,
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
