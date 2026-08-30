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
// ONE email per lead — a single Resend message addressed to every recipient,
// never a per-recipient loop. The email has TWO location-scoped variants (#91),
// chosen by whether the LOCATION is on Bee Hub — NOT per recipient (that was
// #72's mistake, which produced two sends per lead):
//   • Location has ≥1 active hub_user → the Bee Hub email: "Open this lead in
//     Bee Hub" deep-link button, Bee Hub branding, the #82 "get set up" footer.
//     Account-less recipients (externals, Zoho contacts, account-less global CC)
//     land on a login they can't pass, and that is accepted — the footer points
//     them at the corporate office.
//   • Location has NONE → a clean notification with ZERO Bee Hub references: no
//     button, no product name in subject or body, signed as Bee Organized. The
//     recipients at these offices don't use Bee Hub, so the dead button and the
//     footer only confused them.
// Because the branch is on the LOCATION, everyone at one office gets the SAME
// email and each lead still produces exactly ONE send. (#82 had already
// collapsed the #72 two-variant split to a single send; #91 keeps it single and
// moves the branch from recipient to location.)
// Project-type routing (when the location's split-notifications toggle is ON)
// is applied inside resolveLeadRecipients, which is handed the lead below.
//
// GLOBAL CC (corporate oversight) — resolveGlobalCcRecipients() — is merged
// here, AFTER the gate and AFTER routing, and rides a visible CC so recipients
// can see who else received the lead. It is fail-soft end to end: losing
// corporate visibility must never cost the owner their lead alert.
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
import {
  resolveLeadRecipients,
  resolveGlobalCcRecipients,
  locationHasActiveHubUser,
  type EffectiveRecipient,
} from './notification-recipients'
import { logNotification } from './notification-log'
import { resolveNotificationsLive } from './notifications-live'
import { formatLeadAddressLabeled } from './lead-address'
import { buildBrandedShellHtml } from './drip-email-layout'

// The plain-text wordmark line — the text alternative's echo of the shell's
// gold-logo + wordmark header. Same string buildBrandedDripText uses, so a
// branded drip and a branded lead notification read identically in a text-only
// client. It is a WORDMARK, not the logo: the text alternative must NOT gain an
// image (#113), but it must stay in step with the html, which now leads with the
// brand chrome. Contains no "Bee Hub", so it is safe on the non-hub variant.
const BRAND_WORDMARK_TEXT = 'BEE ORGANIZED — Simplify Your Hive'

// The email_kind stamped on every row this module produces. Hardcoded rather
// than passed by callers: this function IS the lead notification, so deriving
// the label here means all three call sites (intake / leads / transfer) are
// correct by construction and a new caller can't mislabel its rows.
//
// TWO kinds now (#91), chosen by whether the location is on Bee Hub:
//   • 'lead_notification'          → the Bee Hub email (button + branding).
//   • 'lead_notification_non_hub'  → the clean, Bee-Hub-free email.
// 'lead_notification_non_hub' is a DELIBERATELY FRESH value: it does NOT reuse
// #72's historical 'lead_notification_no_access' (those rows were RECIPIENT-
// scoped — an account-less person at a Bee Hub location — a different thing
// from #91's LOCATION-scoped branch). So it does not collide with either
// 'lead_notification' or the untouched 'lead_notification_no_access' rows, and
// the notebook can tell all three apart. email_kind carries no CHECK
// constraint, so the new value needs no migration.
const LEAD_NOTIFICATION_KIND = 'lead_notification'
const LEAD_NOTIFICATION_NON_HUB_KIND = 'lead_notification_non_hub'

// #86 — RESUBMISSION kinds. A returning client re-submitted the website form:
// the SAME notification path as a new lead (gate, #91 hub/non-hub branch, global
// CC, dedupe), but distinguishable in the notebook and worded as a returning
// client, not a new lead. Two values, mirroring the #91 hub/non-hub split, so
// the notebook can tell a returning-client alert from a new-lead one AND tell
// which office variant went out. Both are DELIBERATELY FRESH values that reuse
// nothing above; email_kind carries no CHECK constraint, so neither needs a
// migration. Chosen HERE, never by callers, for the same by-construction reason
// the new-lead kinds are: the resubmission flag flips the copy AND the label
// together, so a caller can't ship a "returning client" email logged as a new
// lead.
const LEAD_RESUBMISSION_KIND = 'lead_resubmission'
const LEAD_RESUBMISSION_NON_HUB_KIND = 'lead_resubmission_non_hub'

// System sender for lead notifications. notifications@beeorganized.com sends
// on the same verified domain (beeorganized.com) that admin@ already uses for
// invites/drips — Resend verification is domain-scoped, so any mailbox on a
// verified domain sends. Display name "Bee Hub" so recipients recognize the
// product. All three overridable via env if the sender ever changes.
const NOTIFY_FROM_EMAIL =
  process.env.LEAD_NOTIFY_FROM_EMAIL || 'notifications@beeorganized.com'
const NOTIFY_FROM_NAME =
  process.env.LEAD_NOTIFY_FROM_NAME || 'Bee Hub'
// No-access variant (#91) signs as "Bee Organized" — the From display name is
// visible to the recipient, so a non-hub location can't be allowed to see
// "Bee Hub" there any more than in the subject or body. Same verified sender
// address (NOTIFY_FROM_EMAIL); only the display name changes.
const NOTIFY_FROM_NAME_NON_HUB =
  process.env.LEAD_NOTIFY_FROM_NAME_NON_HUB || 'Bee Organized'
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
  // The captured address, rendered as a single adaptive row (see
  // formatLeadAddressLabeled). Optional so the in-app/transfer callers that don't
  // forward it still typecheck; the row simply omits when nothing was collected.
  // zip alone is the common website-lead case, so the row's LABEL adapts (Zip vs
  // Location vs Address) rather than always saying "Address" over a bare zip.
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
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

// One line in the footer block of the BEE HUB variant, IDENTICAL for every
// recipient on that send — no conditional on whether an individual has an
// account. That sameness is what keeps each variant a single send (#82): the
// body can't diverge by audience within a location. The NON-HUB variant (#91)
// drops this line entirely — it names the product, and its recipients don't use
// Bee Hub. Copy is Kevin's, verbatim.
const NO_ACCESS_FOOTER =
  "Don't have Bee Hub access yet? Contact the corporate office to get set up."

function buildLeadNotificationEmail(args: {
  lead: NewLeadForNotification
  locationName: string
  // Absolute deep-link to the lead in Bee Hub (/clients/<id>). Null when no
  // base URL is available (e.g. a caller without a request origin) — the
  // button is simply omitted, the rest of the email is unchanged. Everyone who
  // gets the email gets the button; account-less recipients hit a login they
  // can't pass, which the footer line addresses.
  leadUrl: string | null
  // #91 — is this LOCATION on Bee Hub? Drives the WHOLE Bee Hub layer: the
  // deep-link button, the "get set up" footer, and every "Bee Hub" string. When
  // false, none of them render and nothing in subject or body names the product
  // — the recipients don't use Bee Hub. The subject already carries no product
  // name, so it is identical in both variants.
  hasHubAccess: boolean
  // #86 — is this a returning client re-submitting the website form (vs a
  // genuinely new lead)? Flips ONLY the wording — subject, heading, intro, and
  // the details-block label — so an owner reading it instantly knows this person
  // is already in their list. Everything else (field grid, the #91 hub button/
  // branding vs clean non-hub layer, global CC, footer) is identical, because a
  // resubmission alert IS a lead alert; only its framing differs. Default false
  // keeps the new-lead email byte-identical.
  resubmission: boolean
}): { subject: string; html: string; text: string } {
  const { lead, locationName, leadUrl, hasHubAccess, resubmission } = args
  const leadName = dash(lead.name)

  // Subject is name-first for both variants (mobile clients truncate ~35–40
  // chars and the name is what makes an owner open it). The resubmission subject
  // leads with "Returning client:" so the framing survives even when the tail is
  // clipped; the new-lead subject is unchanged.
  const subject = resubmission
    ? `Returning client: ${leadName} — ${locationName}`
    : `New lead: ${leadName} — ${locationName}`

  // Adaptive address row — spliced in CONDITIONALLY (not a fixed row) so it is
  // OMITTED entirely when the form collected nothing, rather than showing a dash.
  // The label + value both come from formatLeadAddressLabeled; it sits with the
  // other contact fields, after Phone. Both html and text pick it up from `rows`.
  const addr = formatLeadAddressLabeled(lead)
  const rows: [string, string][] = [
    ['Name', dash(lead.name)],
    ['Email', dash(lead.email)],
    ['Phone', dash(lead.phone)],
    ...(addr ? [[addr.label, addr.value] as [string, string]] : []),
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

  // Wording — the ONLY thing #86's resubmission flag changes. Heading, intro,
  // and the details-block label reframe a returning client; a new lead keeps the
  // original copy exactly.
  const heading = resubmission
    ? `Returning client — new request for ${locationName}`
    : `New lead for ${locationName}`
  const intro = resubmission
    ? "A client already in your list just submitted the website form again. Here's their new request:"
    : "A new inquiry just came in through your website. Here's what they shared:"
  const detailsLabel = resubmission ? 'What they told us this time' : 'What they told us'

  const detailsHtml = lead.request_details?.trim()
    ? `<p style="margin:18px 0 6px;font-size:14px;font-weight:600;color:#1a2e2b;">${escapeHtml(detailsLabel)}</p>
                <p style="margin:0 0 8px;font-size:14px;line-height:1.55;color:#1a2e2b;white-space:pre-wrap;">${escapeHtml(lead.request_details.trim())}</p>`
    : ''

  // Deep-link button → opens this exact lead in Bee Hub (/clients/<id>).
  // Recipients must be signed-in Hub users with location access; a logged-out
  // click routes through login and lands back on the lead (?next threading).
  // escapeHtml the URL too so a stray quote can't break out of the href.
  // ONLY on the Bee Hub variant (#91): a non-hub location's recipients can't
  // pass the login, so the button is dead noise — omitted entirely there.
  const buttonHtml = hasHubAccess && leadUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px;">
                  <tr>
                    <td style="border-radius:10px;background:#1a2e2b;">
                      <a href="${escapeHtml(leadUrl)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">Open this lead in Bee Hub →</a>
                    </td>
                  </tr>
                </table>`
    : ''

  // #113 — the Bee Organized branded chrome (gold bee logo + wordmark header,
  // single 600px card, teal footer band, dark-mode guard) comes from the SHARED
  // shell in drip-email-layout.ts — the same chrome the branded drips (#90) and
  // stage emails (#114) use. The shell is body-agnostic: the drip fills its card
  // slot with paragraphs, this fills it with the structured field grid + button.
  // The old header carried a 🐝 emoji; the branded header carries the gold logo,
  // so the emoji is dropped (they'd collide) — the logo is the ONE unavoidable
  // content change (#113). The footer band carries the "why you're getting this"
  // note, plus the #82 get-set-up line on the hub variant only.
  const cardContentHtml = `<h1 style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#1a2e2b;">${escapeHtml(heading)}</h1>
              <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#4a5e5a;">${escapeHtml(intro)}</p>
              <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
                ${rowsHtml}
              </table>
              ${detailsHtml}
              ${buttonHtml}`

  // Footer band content — white text on the teal band. The get-set-up line is
  // BEE-HUB-scoped (#82/#91): it names the product, so it renders ONLY on the
  // hub variant and is omitted entirely on the non-hub one (which must contain
  // ZERO Bee Hub references). The "why you're receiving this" note is identical
  // in both variants and names only Bee Organized.
  const footerBandHtml = `${hasHubAccess ? `<div style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#ffffff;">${escapeHtml(NO_ACCESS_FOOTER)}</div>
                    ` : ''}<div style="margin:0;font-size:12px;line-height:1.6;color:#ffffff;">Sent by Bee Organized · You're receiving this because you're set to get new-lead notifications for ${escapeHtml(locationName)}.</div>`

  const html = buildBrandedShellHtml(cardContentHtml, footerBandHtml)

  const textIntro = resubmission
    ? 'A client already in your list just submitted the website form again:'
    : 'A new inquiry just came in through your website:'
  // Text alternative leads with the WORDMARK (not the logo — text can't carry an
  // image, #113) so it stays in step with the html's branded header. Everything
  // below is unchanged from before the brand pass.
  const textLines = [
    BRAND_WORDMARK_TEXT,
    '',
    heading,
    '',
    textIntro,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
  ]
  if (lead.request_details?.trim()) {
    textLines.push('', `${detailsLabel}:`, lead.request_details.trim())
  }
  // Bee Hub deep-link + "get set up" footer only on the Bee Hub variant (#91).
  if (hasHubAccess && leadUrl) {
    textLines.push('', `Open this lead in Bee Hub: ${leadUrl}`)
  }
  if (hasHubAccess) {
    textLines.push('', NO_ACCESS_FOOTER)
  }
  textLines.push(
    '',
    '—',
    `Bee Organized · new-lead notifications for ${locationName}`,
  )

  return { subject, html, text: textLines.join('\n') }
}

// Resolve the location's recipients (+ global CC), dedupe, and send ONE email
// with the button to everyone. Location recipients ride the To line; global CC
// rides a visible CC. Non-throwing: returns a result object the caller can
// log/collect as a warning. Zero recipients is a normal outcome (sent:false,
// recipientCount:0) — logged quietly, never an error.
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
  // #86 — this lead is a returning client re-submitting the website form (the
  // intake SOLID-merge path), not a genuinely new lead. Flips the copy AND the
  // email_kind together (see LEAD_RESUBMISSION_KIND). Everything else — the gate,
  // recipient resolution, the #91 hub/non-hub branch, global CC, dedupe — is
  // identical, because a resubmission alert IS a lead alert. Defaults false so
  // every existing caller (new-lead create path, /api/leads POST, transfer) is
  // unchanged.
  resubmission?: boolean
}): Promise<NotifyResult> {
  const { location, lead, baseUrl, locationSlug } = args
  const resubmission = args.resubmission === true
  // Context for the outbound-mail notebook. Derived here from what this
  // function already knows, so callers can't get it wrong. The base email_kind
  // (used for the muted / zero-recipient / resolution-failure rows, which return
  // before the #91 hub lookup) is the hub-variant name for this send TYPE —
  // resubmission or new lead — mirroring how the new-lead base is the hub name.
  const logContext = {
    lead_id: lead.id,
    lead_name: lead.name,
    location_id: location.id,
    location_slug: locationSlug ?? null,
    email_kind: resubmission ? LEAD_RESUBMISSION_KIND : LEAD_NOTIFICATION_KIND,
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
    // Pass the lead so resolveLeadRecipients can guarantee the ASSIGNEE is on
    // the list (2026-08-30 rule): the handler for the lead's type — or the
    // owner when there is none — is emailed even if their notify switch is
    // off. Everyone switched on is returned regardless; the lead only ever
    // ADDS its assignee, never removes anyone.
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

  // Global CC (corporate oversight) — resolved beside, never inside, the
  // location list: it must not participate in split routing, the Zoho
  // fallback, or the never-drop backstop, and it must not be able to take the
  // location send down with it. The resolver is fail-soft by contract; the
  // try/catch is belt and braces for the same reason safeLog exists in
  // resend.ts — this rail failing must cost corporate visibility only.
  let globalCc: EffectiveRecipient[] = []
  try {
    globalCc = await resolveGlobalCcRecipients()
  } catch (err) {
    console.warn(
      '[lead-notify] global CC resolution failed — sending without global CC',
      err,
    )
  }

  // ── Collapse + place ──────────────────────────────────────────────────────
  // One person, ONE address, ONE email. Same twin-collapse rule as
  // filterRecipientsByProjectType (a hub_user entry outranks an external for a
  // shared address), extended across the global CC list. Rank decides only WHO
  // wins a collision; placement (To vs CC) is decided afterwards from the
  // surviving entry's source:
  //
  //   3  location hub_user        → To
  //   2  location external / zoho → To
  //   1  global CC                → CC
  //
  // A location recipient always outranks a global CC, so an address that is
  // both is addressed once, on the To line — never duplicated onto CC.
  // Case-INSENSITIVE on the lowercased address; the higher rank wins a
  // collision (ties keep first-seen, preserving the first-seen casing). Because
  // every address survives exactly once, the notification_log grain — one row
  // per address per send, written in sendEmailDirect — never double-logs a
  // person reachable two ways.
  const rank = (r: EffectiveRecipient): number => {
    if (r.source === 'user') return 3
    if (r.source === 'global_cc') return 1
    return 2 // 'external' | 'zoho'
  }
  const at = new Map<string, number>()
  const people: EffectiveRecipient[] = []
  for (const r of [...recipients, ...globalCc]) {
    const original = r.email?.trim()
    if (!original) continue
    const key = original.toLowerCase()
    const i = at.get(key)
    if (i === undefined) {
      at.set(key, people.length)
      people.push({ ...r, email: original })
    } else if (rank(r) > rank(people[i])) {
      people[i] = { ...r, email: original }
    }
  }

  // Location recipients on To, global CC on a visible CC.
  const to: string[] = []
  const cc: string[] = []
  for (const p of people) {
    if (p.source === 'global_cc') cc.push(p.email)
    else to.push(p.email)
  }

  if (people.length === 0) {
    // Quiet, visible no-send — a location with nobody subscribed is a real
    // (if unusual) state, not a failure.
    console.log(
      `[lead-notify] location ${location.id} (${locationName}) has zero lead-notification recipients — no email sent for lead ${lead.id}`,
    )
    // THE reason 'zero_recipients' exists as a distinct send_status, and it
    // means NOBODY — no location recipients AND no global CC. Logged exactly
    // ONCE here: this path returns before sendEmailDirect, so it is the only
    // place that can record it, and there is a single send below so it can't
    // race a resend-layer row. Without this row, "nobody is subscribed at this
    // location" would be indistinguishable in the notebook from "no lead came
    // in" — exactly the silent failure the log is meant to expose. recipient
    // stays null: there was nobody to address.
    await logNotification({
      ...logContext,
      channel: 'email',
      send_status: 'zero_recipients',
    })
    return { sent: false, recipientCount: 0 }
  }

  // ── ONE message per lead ──────────────────────────────────────────────────
  // A single Resend message addressed to the whole To line, with the global CC
  // on a visible CC — never a per-recipient loop. When the ONLY recipients are
  // global CC there is no location To line and Resend rejects an empty `to`, so
  // the CC list is promoted onto To (corporate is the only audience either way,
  // so there's nothing on the To line the CC placement was protecting). The CC
  // key is passed only when non-empty, mirroring bcc, so a global-CC-less send
  // is byte-identical to a plain to-only send.
  //
  // Reply-To is the prospect's email when captured so a recipient can reply
  // straight to them; otherwise the system inbox. The context rides along so
  // the resend-layer hook writes one RICH row per recipient. sendEmailDirect
  // does the actual logging; this module logs only the paths that never reach
  // it (muted / zero_recipients / resolution failure).
  const finalTo = to.length ? to : cc
  const finalCc = to.length ? cc : []

  // ── Which variant? (#91) ──────────────────────────────────────────────────
  // Location-scoped, resolved HERE (after the gate, after we know there IS
  // someone to send to — a muted / zero-recipient location skips the lookup
  // entirely). Everyone on this one send — To and CC, hub_user and global CC
  // alike — gets the SAME body: the global CC is corporate and knows Bee Hub,
  // but they're cc'd on a location-scoped email and get whatever that location's
  // email is. Special-casing them would mean two sends again. Fail-soft inside
  // the resolver: a read error yields NO-access (the clean email), never the
  // Bee Hub one — a failed lookup must not resurrect the confusing message.
  const hasHubAccess = await locationHasActiveHubUser(location.id)
  // #86 crosses #91: four possible kinds now, one per (resubmission × hub) cell.
  // The resubmission flag picks the row (returning-client vs new-lead), hasHubAccess
  // picks the column (Bee Hub vs clean non-hub) — same two-variant split #91 built,
  // duplicated across the two send types.
  const emailKind = resubmission
    ? (hasHubAccess ? LEAD_RESUBMISSION_KIND : LEAD_RESUBMISSION_NON_HUB_KIND)
    : (hasHubAccess ? LEAD_NOTIFICATION_KIND : LEAD_NOTIFICATION_NON_HUB_KIND)
  const fromName = hasHubAccess ? NOTIFY_FROM_NAME : NOTIFY_FROM_NAME_NON_HUB

  const { subject, html, text } = buildLeadNotificationEmail({
    lead,
    locationName,
    leadUrl,
    hasHubAccess,
    resubmission,
  })
  const result = await sendEmailDirect({
    from: NOTIFY_FROM_EMAIL,
    fromName,
    replyTo: lead.email?.trim() || NOTIFY_REPLY_TO_EMAIL,
    to: finalTo,
    ...(finalCc.length ? { cc: finalCc } : {}),
    subject,
    html,
    text,
    // logContext carries the base kind; #91 overrides it with the variant
    // actually sent so the resend-layer rows land under the right email_kind.
    ...logContext,
    email_kind: emailKind,
  })

  // recipientCount is everyone ADDRESSED (To + CC).
  if (!result.success) {
    console.error(
      `[lead-notify] send failed for lead ${lead.id} (${people.length} recipients): ${result.error}`,
    )
    return { sent: false, recipientCount: people.length, error: result.error }
  }
  console.log(
    `[lead-notify] sent lead ${lead.id} notification to ${people.length} recipient(s) for location ${location.id}`,
  )
  return { sent: true, recipientCount: people.length, emailId: result.id }
}
