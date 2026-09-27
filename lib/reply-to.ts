// lib/reply-to.ts
// ─────────────────────────────────────────────────────────────
// ONE rule for "is this reply-to address usable?", shared by every place that
// sets one (Settings, onboarding, PATCH /api/locations/[id]) and by the send
// path that uses one (lib/resend.ts → lib/drip-send.ts).
//
// Why it exists (Dawn Knapp, Dallas, 2026-09): Dallas's reply_to_email was
// "jackie@beeorganized.com,dknapp@beeorganized.com" — two addresses in a field
// Resend takes ONE of. Resend rejected every send with "Invalid `reply_to`
// field" (a 422 validation_error, the same type a mistyped CLIENT address
// gets), so the drip engine read it as the client's fault: it stopped each
// lead's drip for good as 'invalid_recipient' and told the owner "invalid email
// address". All ten client addresses were fine. Ten days of looking at client
// records followed.
//
// The field takes one address, and stays that way: two owners who both want
// replies share one inbox (Kevin, 2026-09-26). So a list is refused with that
// reason rather than accepted.
//
// Pure and import-free: BeeHub.jsx (client) and the API route (server) both
// import it, so the Settings row refuses exactly what the server refuses.
// ─────────────────────────────────────────────────────────────

// What the owner is told when a send fails on the LOCATION's reply-to. It names
// whose setting is wrong and where to fix it — never the client's address.
export const LOCATION_REPLY_TO_BROKEN = 'Your location’s reply-to address is not valid — check Settings.'

// SendResult.errorName for a send refused on the reply-to (by our own check, or
// by Resend). Distinct from Resend's 'validation_error' on purpose: that one
// means a bad RECIPIENT and stops the lead's drip; this one is the location's
// setting and must never touch the lead.
export const REPLY_TO_INVALID = 'reply_to_invalid'

// Same shape rule the project-type sender route already applies (EMAIL_RE).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// null when the value is one usable address; otherwise the reason, in owner
// words. Blank is refused too: sendEmail refuses to send without a reply-to,
// so a cleared field silently holds every email the location sends.
export function replyToProblem(value: string | null | undefined): string | null {
  const v = String(value ?? '').trim()
  if (!v) return 'A reply-to address is required — without one, no emails can send.'
  const count = (v.match(/@/g) || []).length
  if (count > 1 || /[,;]/.test(v)) {
    return `Only one reply-to address is allowed${count > 1 ? ` — this has ${count}` : ''}. For two people, use one shared inbox.`
  }
  if (!EMAIL_RE.test(v)) return 'That reply-to address is not valid. Enter one address, like replies@yourbusiness.com.'
  return null
}

// Resend's own wording when it refuses the reply-to ("Invalid `reply_to`
// field. …"), or our own pre-send refusal (which leads with
// LOCATION_REPLY_TO_BROKEN). A backstop for any value our rule lets through
// but Resend does not. Deliberately narrow: our "missing required field
// (…, replyTo, …)" message also mentions replyTo and must NOT match.
export function isReplyToRejection(message: string | null | undefined): boolean {
  const m = String(message ?? '')
  return /invalid\s+`?reply_?to`?/i.test(m) || m.startsWith(LOCATION_REPLY_TO_BROKEN)
}

// The reply-to the onboarding location step SAVES: what the owner typed or,
// left blank, their Send From address — as the field's hint promises. Saving
// it blank used to leave the location unable to send anything at all.
export function onboardingReplyTo(form: { replyToEmail?: string | null; sendFromEmail?: string | null } | null | undefined): string {
  return String(form?.replyToEmail || '').trim() || String(form?.sendFromEmail || '').trim()
}
