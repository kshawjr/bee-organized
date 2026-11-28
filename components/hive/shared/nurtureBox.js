// components/hive/shared/nurtureBox.js
// ─────────────────────────────────────────────────────────────
// FL-137/135 (Kevin, 2026-11-28): WHICH CLOSES ASK "NURTURE THEM?", and what
// the box says. PURE — the close screens and the server route both read it,
// so a screen can never offer a box the server ignores, or the reverse.
//
// Closed Lost by hand shows ONE box, unticked, that decides Nurturing and
// Mailchimp together (Kevin kept them joined so it stays simple for owners).
// Unticked is an answer: "no", for good — the 30-day catch-all never pulls
// that person in later.
//
// NO BOX on two reasons: Junk Lead (spam or a bad entry) and a duplicate (a
// data artifact; the real person still has their other card). Every other
// Lost reason has it — Written off included: they owe money, but the owner
// may still want to keep in touch. Closed Won never has it: Closed Won never
// reaches Nurturing by any route.
// ─────────────────────────────────────────────────────────────

/** Lost reasons that get no box, compared without case or spaces. */
export const NO_NURTURE_BOX_REASONS = ['Junk Lead', 'duplicate', 'duplicate_card', 'Duplicate']

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
const NO_BOX = new Set(NO_NURTURE_BOX_REASONS.map(norm))

/** Does a Closed Lost with this reason ask the box? */
export function nurtureBoxShows(reason) {
  const r = norm(reason)
  if (!r) return true
  if (NO_BOX.has(r)) return false
  return !/^junk/.test(r) && !/^duplicate/.test(r)
}

/** The box's words. Where Mailchimp is open it decides both; elsewhere Mailchimp is "coming soon". */
export function nurtureBoxLabel(mailchimpOpen) {
  return mailchimpOpen ? 'Add them to Nurturing and Mailchimp' : 'Add them to Nurturing'
}
export function nurtureBoxHint(mailchimpOpen) {
  return mailchimpOpen
    ? 'Leave it unticked and they never go to Nurturing or Mailchimp from here.'
    : 'Leave it unticked and they never go to Nurturing.'
}

// FL-135: someone added on the Nurturing tab. Not an enquiry (only 'manual'
// is), so they never land in the Inbox and the 35-day auto-close never sees
// them; and not a past client (the greeting's own check), so the "Send the
// welcome email" box can greet them.
export const NURTURING_ADD_SOURCE = 'nurturing_add'
