// lib/lead-notification-email.ts
// ─────────────────────────────────────────────────────────────
// B2 — internal "a new lead came in" notification.
//
// When a genuinely NEW website lead is created (intake CREATE path only —
// never the fill-empty merge/resubmit path), notify the location's effective
// recipients. resolveLeadRecipients() (B1) returns the send-ready list:
// subscribed interface users + all externals, unsubscribed users excluded,
// no-pref users defaulting to subscribed/'all'.
//
// ONE email addressed to ALL recipients — a single Resend message with every
// recipient email on the `to` line, never a per-recipient loop. Category
// ('all' | 'moving' | 'organizing') is NOT used to filter here: this send
// goes to everyone subscribed. Category-based routing/filtering is a later
// build.
//
// Sends via the SYSTEM sender (sendEmailDirect), mirroring team-invite /
// magic-link emails — a pre-launch location may not have its per-location
// send_from_email/sender_name/reply_to_email populated yet, and this is an
// internal notification, not customer-facing correspondence. Reply-To points
// at the lead's own email when we have it, so a recipient can reply straight
// to the prospect.
//
// Zero recipients → send nothing, no error, but log quietly so silent
// no-sends are visible.
// ─────────────────────────────────────────────────────────────

import { sendEmailDirect } from './resend'
import { resolveLeadRecipients } from './notification-recipients'

// System sender for lead notifications. notifications@beeorganized.com sends
// on the same verified domain (beeorganized.com) that admin@ already uses for
// invites/drips — Resend verification is domain-scoped, so any mailbox on a
// verified domain sends. Display name "Bee Hub" so recipients recognize the
// product. All three overridable via env if the sender ever changes.
const NOTIFY_FROM_EMAIL =
  process.env.LEAD_NOTIFY_FROM_EMAIL || 'notifications@beeorganized.com'
const NOTIFY_FROM_NAME =
  process.env.LEAD_NOTIFY_FROM_NAME || 'Bee Hub'
const NOTIFY_REPLY_TO_EMAIL =
  process.env.LEAD_NOTIFY_REPLY_TO_EMAIL || 'admin@beeorganized.com'

export type NewLeadForNotification = {
  id: string
  name: string
  email: string | null
  phone: string | null
  project_type: string | null
  request_details: string | null
  preferred_contact: string | null
}

export type NotifyLocation = {
  id: string
  name: string | null
}

export type NotifyResult = {
  sent: boolean
  recipientCount: number
  emailId?: string
  error?: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// A captured field renders as a row; blanks fall back to an em-dash so the
// email still reads cleanly and the owner can see what the form did/didn't
// collect.
const dash = (v: string | null | undefined): string =>
  v && v.trim() ? v.trim() : '—'

function buildLeadNotificationEmail(args: {
  lead: NewLeadForNotification
  locationName: string
}): { subject: string; html: string; text: string } {
  const { lead, locationName } = args
  const leadName = dash(lead.name)

  const subject = `New lead: ${leadName} — ${locationName}`

  const rows: [string, string][] = [
    ['Name', dash(lead.name)],
    ['Email', dash(lead.email)],
    ['Phone', dash(lead.phone)],
    ['Project type', dash(lead.project_type)],
    ['Preferred contact', dash(lead.preferred_contact)],
  ]

  const rowsHtml = rows
    .map(
      ([label, value]) => `
              <tr>
                <td style="padding:6px 12px 6px 0;font-size:14px;color:#8a9e9a;white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
                <td style="padding:6px 0;font-size:14px;color:#1a2e2b;">${escapeHtml(value)}</td>
              </tr>`,
    )
    .join('')

  const detailsHtml = lead.request_details?.trim()
    ? `<p style="margin:18px 0 6px;font-size:14px;font-weight:600;color:#1a2e2b;">What they told us</p>
                <p style="margin:0 0 8px;font-size:14px;line-height:1.55;color:#1a2e2b;white-space:pre-wrap;">${escapeHtml(lead.request_details.trim())}</p>`
    : ''

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
                <h1 style="margin:0 0 6px;font-family:Georgia,serif;font-size:22px;color:#1a2e2b;">New lead for ${escapeHtml(locationName)}</h1>
                <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#4a5e5a;">A new inquiry just came in through your website. Here's what they shared:</p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
                  ${rowsHtml}
                </table>
                ${detailsHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px;border-top:1px solid rgba(0,0,0,0.06);">
                <p style="margin:0;font-size:11px;color:#8a9e9a;">Sent by Bee Organized · You're receiving this because you're set to get new-lead notifications for ${escapeHtml(locationName)}.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

  const textLines = [
    `New lead for ${locationName}`,
    '',
    'A new inquiry just came in through your website:',
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
  ]
  if (lead.request_details?.trim()) {
    textLines.push('', 'What they told us:', lead.request_details.trim())
  }
  textLines.push(
    '',
    '—',
    `Bee Organized · new-lead notifications for ${locationName}`,
  )

  return { subject, html, text: textLines.join('\n') }
}

// Resolve the location's recipients and, if there is at least one, send ONE
// email addressed to all of them. Non-throwing: returns a result object the
// caller can log/collect as a warning. Zero recipients is a normal outcome
// (sent:false, recipientCount:0) — logged quietly, never an error.
export async function notifyNewLead(args: {
  location: NotifyLocation
  lead: NewLeadForNotification
}): Promise<NotifyResult> {
  const { location, lead } = args
  const locationName = location.name?.trim() || 'your location'

  let recipients
  try {
    recipients = await resolveLeadRecipients(location.id)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[lead-notify] resolveLeadRecipients failed', err)
    return { sent: false, recipientCount: 0, error }
  }

  // De-dupe emails (a hub_user and an external row can share an address) so a
  // single person never appears twice on the To line.
  const emails = Array.from(
    new Set(
      recipients
        .map((r) => r.email?.trim())
        .filter((e): e is string => !!e),
    ),
  )

  if (emails.length === 0) {
    // Quiet, visible no-send — a location with nobody subscribed is a real
    // (if unusual) state, not a failure.
    console.log(
      `[lead-notify] location ${location.id} (${locationName}) has zero lead-notification recipients — no email sent for lead ${lead.id}`,
    )
    return { sent: false, recipientCount: 0 }
  }

  const { subject, html, text } = buildLeadNotificationEmail({ lead, locationName })

  // ONE message to all recipients — the whole list on `to`, not a loop.
  // Reply-To is the prospect's email when captured so a recipient can reply
  // straight to them; otherwise the system inbox.
  const result = await sendEmailDirect({
    from: NOTIFY_FROM_EMAIL,
    fromName: NOTIFY_FROM_NAME,
    replyTo: lead.email?.trim() || NOTIFY_REPLY_TO_EMAIL,
    to: emails,
    subject,
    html,
    text,
  })

  if (!result.success) {
    console.error(
      `[lead-notify] send failed for lead ${lead.id} (${emails.length} recipients): ${result.error}`,
    )
    return { sent: false, recipientCount: emails.length, error: result.error }
  }

  console.log(
    `[lead-notify] sent lead ${lead.id} notification to ${emails.length} recipient(s) for location ${location.id}`,
  )
  return { sent: true, recipientCount: emails.length, emailId: result.id }
}
