// app/api/pending_invites/[id]/resend/route.ts
//
// Rotate an outstanding invite — generate a new invite_token, extend
// invite_expires_at by another 7 days, and re-send the invitation email.
// Rotating the token (vs. just re-sending the existing one) means a
// previously-leaked link stops working: the user is asking for a fresh
// invitation, and that should be exactly what they get.
//
// Uses the system sender (see app/api/hub_users/invite/route.ts and
// docs/invite-emails.md) — owner invites go out before the owner has
// onboarded, so the location's send_from_email/sender_name/reply_to_email
// aren't usable. Corporate (admin-tier) invites have no location at all.
//
// Auth: super_admin/admin OR the owner of the invite's location.
// Corporate (location-less) invites: super_admin only.

import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { sendEmailDirect } from '@/lib/resend'

export const runtime = 'nodejs'

const INVITE_TTL_DAYS = 7

// Mirror of the constants in app/api/hub_users/invite/route.ts so both
// routes stay aligned. Override via env if the sender ever changes.
const INVITE_FROM_EMAIL =
  process.env.INVITE_FROM_EMAIL || 'admin@beeorganized.com'
const INVITE_FROM_NAME = process.env.INVITE_FROM_NAME || 'Kevin Shaw'
const INVITE_REPLY_TO_EMAIL =
  process.env.INVITE_REPLY_TO_EMAIL || 'admin@beeorganized.com'

function isElevated(role: string) {
  return role === 'super_admin' || role === 'admin'
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

// locationName is null for corporate (admin-tier) invites — same convention
// as buildInviteEmail in app/api/hub_users/invite/route.ts. Corporate
// invites drop the "join <location>" framing and skip the 5-step franchise
// onboarding outline.
function buildResendEmail(args: {
  inviteUrl: string
  locationName: string | null
  inviterName: string
  expiresAt: string
}): { html: string; text: string } {
  const { inviteUrl, locationName, inviterName, expiresAt } = args
  const expiryFormatted = formatExpiry(expiresAt)
  const isCorporate = !locationName

  const headline = isCorporate
    ? 'Another invitation to Bee Hub'
    : `Another invitation to ${escapeHtml(locationName!)}`
  const intro = isCorporate
    ? `<strong>${escapeHtml(inviterName)}</strong> re-sent your invitation to join Bee Hub — the operations platform Bee Organized uses to manage clients, jobs, and your team day to day. The previous invite link is no longer valid — use the one below.`
    : `<strong>${escapeHtml(inviterName)}</strong> re-sent your invitation to join <strong>${escapeHtml(locationName!)}</strong> on Bee Hub — the operations platform Bee Organized uses to manage clients, jobs, and your team day to day. The previous invite link is no longer valid — use the one below.`

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
              <li>Configure drip paths for nurturing new leads</li>
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
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;box-shadow:0 4px 24px rgba(26,46,43,0.08);overflow:hidden;">
          <tr><td style="padding:32px 32px 24px;">
            <div style="font-size:32px;margin-bottom:8px;">🐝</div>
            <h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:22px;color:#1a2e2b;">${headline}</h1>
            <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#1a2e2b;">
              ${intro}
            </p>
            ${onboardingBlockHtml}
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr><td style="background:#1a2e2b;border-radius:10px;">
                <a href="${inviteUrl}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;font-family:inherit;">Accept Invitation</a>
              </td></tr>
            </table>
            <p style="margin:0 0 8px;font-size:12px;color:#8a9e9a;">Or paste this link into your browser:</p>
            <p style="margin:0 0 20px;font-size:12px;color:#4a5e5a;word-break:break-all;font-family:ui-monospace,Menlo,monospace;">${escapeHtml(inviteUrl)}</p>
            <p style="margin:0;font-size:12px;color:#8a9e9a;line-height:1.5;">This invitation expires on <strong>${escapeHtml(expiryFormatted)}</strong>.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`

  const introText = isCorporate
    ? `${inviterName} re-sent your invitation to join Bee Hub — the operations platform Bee Organized uses to manage clients, jobs, and your team day to day. The previous invite link is no longer valid — use the one below.`
    : `${inviterName} re-sent your invitation to join ${locationName} on Bee Hub — the operations platform Bee Organized uses to manage clients, jobs, and your team day to day. The previous invite link is no longer valid — use the one below.`

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
        '  3. Configure drip paths for nurturing new leads',
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
    introText,
    ...onboardingText,
    '',
    inviteUrl,
    '',
    `This invitation expires on ${expiryFormatted}.`,
    '',
    '—',
    'Bee Organized',
  ].join('\n')

  return { html, text }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const inviteId = params.id
  if (!inviteId) {
    return NextResponse.json({ error: 'id required' }, { status: 400 })
  }

  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
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

  const { data: invite, error: inviteErr } = await supabaseService
    .from('pending_invites')
    .select('id, location_id, email, full_name, tier, accepted_at')
    .eq('id', inviteId)
    .maybeSingle()
  if (inviteErr) {
    console.error('[pending_invites resend fetch]', inviteErr)
    return NextResponse.json({ error: inviteErr.message }, { status: 500 })
  }
  if (!invite) {
    return NextResponse.json({ error: 'invite not found' }, { status: 404 })
  }
  if (invite.accepted_at) {
    return NextResponse.json(
      { error: 'invite already accepted — cannot resend' },
      { status: 409 }
    )
  }

  const isCorporateInvite = invite.tier === 'admin' || !invite.location_id
  if (isCorporateInvite) {
    if (caller.role !== 'super_admin') {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  } else {
    const isOwnerOfLocation =
      caller.role === 'owner' && caller.location_id === invite.location_id
    if (!isElevated(caller.role) && !isOwnerOfLocation) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  }

  const newToken = crypto.randomBytes(24).toString('hex')
  const newExpiresAt = new Date(
    Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000
  ).toISOString()

  const { data: updated, error: updateErr } = await supabaseService
    .from('pending_invites')
    .update({
      invite_token: newToken,
      invite_expires_at: newExpiresAt,
    })
    .eq('id', inviteId)
    .select('id, email, full_name, role, tier, location_id, invite_token, invite_expires_at, created_at')
    .single()
  if (updateErr) {
    console.error('[pending_invites resend update]', updateErr)
    return NextResponse.json({ error: updateErr.message }, { status: 500 })
  }

  const origin =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ||
    request.nextUrl.origin
  const invite_url = `${origin}/auth/invite/${newToken}`

  let email_sent = false
  let email_error: string | undefined
  try {
    const inviterPromise = supabaseService
      .from('hub_users')
      .select('full_name, first_name, email')
      .eq('id', caller.id)
      .single()
    const locationPromise = invite.location_id
      ? supabaseService
          .from('locations')
          .select('name')
          .eq('id', invite.location_id)
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
    const { html, text } = buildResendEmail({
      inviteUrl: invite_url,
      locationName,
      inviterName,
      expiresAt: newExpiresAt,
    })
    const result = await sendEmailDirect({
      from: INVITE_FROM_EMAIL,
      fromName: INVITE_FROM_NAME,
      replyTo: INVITE_REPLY_TO_EMAIL,
      to: invite.email,
      subject: locationName
        ? `Another invitation to ${locationName} on Bee Hub`
        : `Another invitation to Bee Hub`,
      html,
      text,
    })
    if (result.success) {
      email_sent = true
    } else {
      email_error = result.error
    }
  } catch (err) {
    email_error = err instanceof Error ? err.message : String(err)
    console.error('[pending_invites resend email]', err)
  }

  return NextResponse.json({
    invite: updated,
    invite_url,
    email_sent,
    ...(email_error ? { email_error } : {}),
  })
}
