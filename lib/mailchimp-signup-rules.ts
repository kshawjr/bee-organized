// lib/mailchimp-signup-rules.ts
//
// FL-131 (Kevin, 2026-11-27): the few facts that the ongoing Mailchimp sync
// and Bee Hub's greeting email both need. Kept in a file of its own, with no
// imports, so either side can read them without loading the other.
//
//   • A person the ongoing sync brings in is marked import_source
//     'mailchimp_signup' — NOT 'mailchimp_import' (the one-time set-up, which
//     is silent and never greeted) and NOT 'manual' (an enquiry for the Inbox).
//   • Their record's created_at is their Mailchimp join time.
//   • They are greeted 24 hours from that join time. Up to 72 hours after
//     joining they are still greeted (late, at the next hourly run); after 72
//     hours, never — the reason is saved on the record. The limit is checked
//     when the greeting is set AND again when it would be sent.

export const MAILCHIMP_SIGNUP_SOURCE = 'mailchimp_signup'

export const HOUR_MS = 60 * 60 * 1000
export const SIGNUP_GREETING_DELAY_MS = 24 * HOUR_MS
export const SIGNUP_LATE_LIMIT_MS = 72 * HOUR_MS

// Mailchimp's own "added by" (a member's source), as Jobber's connection
// writes it: 569 of Chattanooga's 666 read exactly "Jobber" (2026-11-27).
// Set when the contact is created and never changed. Compared trimmed and in
// any capitals; anything else (Typeform, Embed Form, Admin Add, Bee Hub…) is
// not Jobber.
export const JOBBER_SOURCE_NAME = 'jobber'
export function isJobberSource(source: unknown): boolean {
  return typeof source === 'string' && source.trim().toLowerCase() === JOBBER_SOURCE_NAME
}

export function isMailchimpSignup(importSource: unknown): boolean {
  return importSource === MAILCHIMP_SIGNUP_SOURCE
}

/** More than 72 hours since they joined (or no readable join time: treated as too late). */
export function signupTooLate(joinedAt: unknown, nowMs: number): boolean {
  const t = Date.parse(String(joinedAt ?? ''))
  if (!Number.isFinite(t)) return true
  return nowMs - t > SIGNUP_LATE_LIMIT_MS
}
