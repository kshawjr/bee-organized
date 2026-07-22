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
// recipient email on the `to` line, never a per-recipient loop. Project-type
// routing (when the location's split-notifications toggle is ON) is applied
// inside resolveLeadRecipients, which is handed the lead below; this module
// just fans one message out to whoever it returns.
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
//
// GATED on the location's notifications_live flag (lib/notifications-live.ts).
// The gate lives HERE rather than at the call sites so all three — intake,
// /api/leads POST, and transfer — are covered by construction and a fourth
// caller can't be added without it. Muted is a logged outcome, never a silent
// return; see the gate block below.
// ─────────────────────────────────────────────────────────────

import { sendEmailDirect } from './resend'
import { resolveLeadRecipients } from './notification-recipients'
import { logNotification } from './notification-log'
import { resolveNotificationsLive } from './notifications-live'

// The email_kind stamped on every row this module produces. Hardcoded rather
// than passed by callers: this function IS the lead notification, so deriving
// the label here means all three call sites (intake / leads / transfer) are
// correct by construction and a new caller can't mislabel its rows.
const LEAD_NOTIFICATION_KIND = 'lead_notification'

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
  // The location's notifications_live gate said no. Distinct from sent:false
  // with an error — nothing failed, nothing was attempted. Carries no `error`,
  // so existing callers (which warn only on `error`) stay quiet without change.
  muted?: boolean
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
  // Absolute deep-link to the lead in Bee Hub (/clients/<id>). Null when no
  // base URL is available (e.g. a caller without a request origin) — the
  // button is simply omitted, the rest of the email is unchanged.
  leadUrl: string | null
}): { subject: string; html: string; text: string } {
  const { lead, locationName, leadUrl } = args
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

  // Deep-link button → opens this exact lead in Bee Hub (/clients/<id>).
  // Recipients must be signed-in Hub users with location access; a logged-out
  // click routes through login and lands back on the lead (?next threading).
  // escapeHtml the URL too so a stray quote can't break out of the href.
  const buttonHtml = leadUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;">
                  <tr>
                    <td style="border-radius:10px;background:#1a2e2b;">
                      <a href="${escapeHtml(leadUrl)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">Open this lead in Bee Hub →</a>
                    </td>
                  </tr>
                </table>`
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
                ${buttonHtml}
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
  if (leadUrl) {
    textLines.push('', `Open this lead in Bee Hub: ${leadUrl}`)
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
  // Absolute origin of the Hub (no trailing slash), used to build the
  // "open this lead" deep-link → `${baseUrl}/clients/${lead.id}`. The caller
  // (intake route) derives it as NEXT_PUBLIC_SITE_URL || request origin. When
  // absent the email still sends, just without the button.
  baseUrl?: string | null
  // The location's human-readable slug (locations.location_id — a slug, NOT the
  // uuid). Purely for the notification_log row, so the admin screen can show
  // "boulder-01" without joining. Sits beside `location` rather than inside it
  // so the caller-side shape of `location` stays exactly as it was.
  locationSlug?: string | null
}): Promise<NotifyResult> {
  const { location, lead, baseUrl, locationSlug } = args
  // Context for the outbound-mail notebook. Derived here from what this
  // function already knows, so callers can't get it wrong.
  const logContext = {
    lead_id: lead.id,
    lead_name: lead.name,
    location_id: location.id,
    location_slug: locationSlug ?? null,
    email_kind: LEAD_NOTIFICATION_KIND,
  }
  const locationName = location.name?.trim() || 'your location'
  const leadUrl = baseUrl
    ? `${baseUrl.replace(/\/$/, '')}/clients/${lead.id}`
    : null

  // ── The notifications_live gate ─────────────────────────────────────────
  // FIRST, before resolveLeadRecipients — deliberately. Two reasons:
  //  1) A muted location must not have its recipients resolved at all. For the
  //     44 onboarding locations resolveLeadRecipients falls through to Zoho
  //     (none of them have hub_users owners), so gating after would fire a Zoho
  //     API call per lead purely to compute a list we've already decided not to
  //     use.
  //  2) 'muted' is a statement about the LOCATION, not about its recipients.
  //     The 44 all have seeded recipients — that is precisely why the flag,
  //     and not the recipient list, is what silences them. Checking recipients
  //     first would let a recipient-resolution failure mask the mute in the log.
  const gate = await resolveNotificationsLive(location.id)
  if (!gate.live) {
    console.log(
      `[lead-notify] location ${location.id} (${locationName}) is not notifications_live ` +
        `(${gate.reason}) — no email sent for lead ${lead.id}`,
    )
    // Recorded, not skipped. An intentionally-muted location and a broken one
    // look identical from the outside — silence — and the ONLY thing that tells
    // them apart is this row. gate.reason rides in `error` so the notebook
    // distinguishes 'muted' (Kevin hasn't flipped it: expected) from
    // 'read_failed' (the column is missing: the 6 live locations are dark and
    // someone needs to run the migration).
    await logNotification({
      ...logContext,
      channel: 'email',
      send_status: 'muted',
      error: gate.error ? `${gate.reason}: ${gate.error}` : gate.reason,
    })
    // No `error` on the result: nothing failed, so no caller should warn.
    return { sent: false, recipientCount: 0, muted: true }
  }

  let recipients
  try {
    // Pass the lead so resolveLeadRecipients can route by project type when the
    // location's split-notifications toggle is ON (unassigned types → whole
    // team; never-drop to the whole team if the filter empties). When the
    // toggle is OFF, this is a no-op and every subscribed recipient is returned.
    recipients = await resolveLeadRecipients(location.id, {
      project_type: lead.project_type,
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.error('[lead-notify] resolveLeadRecipients failed', err)
    // Never reached sendEmailDirect, so the resend-layer hook can't see this —
    // log it here or a lead whose recipients failed to resolve leaves NO trace
    // in the notebook, which reads identically to "no email was ever due".
    await logNotification({
      ...logContext,
      channel: 'email',
      send_status: 'failed',
      error,
    })
    return { sent: false, recipientCount: 0, error }
  }

  // De-dupe emails (a hub_user and an external row can share an address) so a
  // single person never appears twice on the To line. Case-INSENSITIVE: the
  // uniqueness key is the lowercased address, but the first-seen ORIGINAL casing
  // is what we actually send — so 'A@x.com' and 'a@x.com' collapse to one
  // recipient without mangling how the address is displayed.
  const seenEmail = new Set<string>()
  const emails: string[] = []
  for (const r of recipients) {
    const original = r.email?.trim()
    if (!original) continue
    const key = original.toLowerCase()
    if (seenEmail.has(key)) continue
    seenEmail.add(key)
    emails.push(original)
  }

  if (emails.length === 0) {
    // Quiet, visible no-send — a location with nobody subscribed is a real
    // (if unusual) state, not a failure.
    console.log(
      `[lead-notify] location ${location.id} (${locationName}) has zero lead-notification recipients — no email sent for lead ${lead.id}`,
    )
    // THE reason 'zero_recipients' exists as a distinct send_status. This path
    // returns before sendEmailDirect, so it is the only place that can record
    // it. Without this row, "nobody is subscribed at this location" would be
    // indistinguishable in the notebook from "no lead came in" — and that is
    // exactly the silent failure the log is meant to expose. recipient stays
    // null: there was nobody to address.
    await logNotification({
      ...logContext,
      channel: 'email',
      send_status: 'zero_recipients',
    })
    return { sent: false, recipientCount: 0 }
  }

  const { subject, html, text } = buildLeadNotificationEmail({ lead, locationName, leadUrl })

  // ONE message to all recipients — the whole list on `to`, not a loop.
  // Reply-To is the prospect's email when captured so a recipient can reply
  // straight to them; otherwise the system inbox.
  // The context rides along so the resend-layer hook writes one RICH row per
  // recipient (lead + location resolved) instead of the bare rows system mail
  // produces. sendEmailDirect does the actual logging — this module logs only
  // the paths that never reach it.
  const result = await sendEmailDirect({
    from: NOTIFY_FROM_EMAIL,
    fromName: NOTIFY_FROM_NAME,
    replyTo: lead.email?.trim() || NOTIFY_REPLY_TO_EMAIL,
    to: emails,
    subject,
    html,
    text,
    ...logContext,
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
