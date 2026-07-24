// lib/invite-email.ts
//
// The team-invite email: sender identity + HTML/text builder. Extracted from
// app/api/hub_users/invite/route.ts so /api/seats/buy-and-invite can send the
// identical email — route files may only export HTTP handlers, so sharing
// requires a lib module.

// System sender for invite emails. Owner invites (and corporate admin invites)
// can't use the per-location sender — a fresh location has no owner yet, so
// send_from_email/sender_name/reply_to_email are NULL until onboarding.
// Defaults point at admin@beeorganized.com, the verified Resend sender used
// by drip emails. Override via env if the sender ever changes.
export const INVITE_FROM_EMAIL =
  process.env.INVITE_FROM_EMAIL || 'admin@beeorganized.com'
export const INVITE_FROM_NAME = process.env.INVITE_FROM_NAME || 'Kevin Shaw'
export const INVITE_REPLY_TO_EMAIL =
  process.env.INVITE_REPLY_TO_EMAIL || 'admin@beeorganized.com'

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
export function buildInviteEmail(args: {
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
