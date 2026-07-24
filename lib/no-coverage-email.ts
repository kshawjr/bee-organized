// lib/no-coverage-email.ts
//
// The "we're not in your area yet" email, plus its mailing-list opt-in link.
//
// WHY sendEmailDirect AND NOT sendEmail — two independent reasons, either one
// sufficient:
//
//   1. VOICE. This message speaks for Bee Organized the brand, not for a
//      franchise. The lead has no location — that is the entire reason this
//      email exists — so there is no franchise identity to send as. The
//      corporate sender (INVITE_FROM_EMAIL, the same verified Resend identity
//      the invite rail uses) is the only honest From line here.
//
//   2. OBSERVABILITY. sendEmail's three pre-send guards — missing arg,
//      location lookup failed, location missing sender config — all RETURN
//      BEFORE they reach sendEmailDirect, and sendEmailDirect is the ONLY
//      place notification_log is written. A send that dies in one of those
//      guards therefore leaves NO row in the notebook: it vanishes. Unrouted
//      leads sit at loc_other, which near-certainly has no sender config, so
//      sendEmail would fail guard #3 on essentially every one of these — and
//      fail invisibly. The direct rail records every outcome, accepted or
//      failed, by construction.
//
// The NotificationContext carries lead_id + email_kind:'no_coverage_optin' so
// the notebook can be filtered to this rail. email_kind is unconstrained TEXT
// (see notification-log.ts) — no CHECK to widen, no migration needed for it.
//
// COMPLIANCE POSTURE. This first email is TRANSACTIONAL: it is the reply to an
// inquiry the person themselves submitted, so it needs no prior consent. The
// link inside it is an offer, not a subscription — nothing is pre-checked and
// nothing is opted into by receiving this. The CLICK is the consent act, and
// only the click writes marketing_consented_at.

import { sendEmailDirect } from './resend'
import type { SendResult } from './resend'
// The message itself lives in a PURE module so the confirm modal's preview and
// this send can never drift — see lib/no-coverage-copy.
import { buildNoCoverageEmail } from './no-coverage-copy'
export { buildNoCoverageEmail, firstNameOf } from './no-coverage-copy'

// Same corporate sender trio as the invite rail (app/api/hub_users/invite).
// Kept in lockstep deliberately: it is the one Resend-verified identity that
// isn't tied to a location.
const FROM_EMAIL = process.env.INVITE_FROM_EMAIL || 'admin@beeorganized.com'
const FROM_NAME = process.env.INVITE_FROM_NAME || 'Bee Organized'
const REPLY_TO = process.env.INVITE_REPLY_TO_EMAIL || 'admin@beeorganized.com'

export const NO_COVERAGE_EMAIL_KIND = 'no_coverage_optin'
export const NO_COVERAGE_CONSENT_SOURCE = 'no_coverage_optin_email'

// The send itself. Returns sendEmailDirect's SendResult verbatim — the caller
// branches on it and MUST NOT dismiss the lead unless it succeeded.
export async function sendNoCoverageEmail(args: {
  to: string
  optInUrl: string
  leadId: string
  leadName?: string | null
  firstName?: string | null
  areaLabel?: string | null
}): Promise<SendResult & { subject: string; text: string }> {
  const { subject, html, text } = buildNoCoverageEmail({
    optInUrl: args.optInUrl,
    firstName: args.firstName,
    areaLabel: args.areaLabel,
  })

  const result = await sendEmailDirect({
    from: FROM_EMAIL,
    fromName: FROM_NAME,
    replyTo: REPLY_TO,
    to: args.to,
    subject,
    html,
    text,
    // Context colors the notification_log row and nothing else. location_id is
    // deliberately omitted: an unrouted lead HAS no location, and stamping
    // loc_other's uuid here would file a corporate send under a location.
    lead_id: args.leadId,
    lead_name: args.leadName ?? null,
    email_kind: NO_COVERAGE_EMAIL_KIND,
  })

  return { ...result, subject, text }
}
