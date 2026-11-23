// lib/mailchimp-rules.ts
// ─────────────────────────────────────────────────────────────────────────────
// FL-75 slice 1 — the shared Mailchimp rules. PURE: no database, no network,
// no Mailchimp calls. Nothing in the app calls this yet; slices 4–10 will, so
// that every screen and every send answers "who may go to Mailchimp" and
// "is this the same person" the SAME way.
//
// Kevin's rulings this file encodes (2026-11-23):
//
//   WHO — everyone with an email, by default. NOT "website leads only" (that
//   is today's Sync now engine, which stays untouched until the slice that
//   replaces it, and which this file does not import). Out: no usable email, in the Recycle Bin,
//   "no marketing emails" (opted out or unsubscribed), or on the shared
//   unsubscribe list. Archived people are in, but start unticked. The owner
//   can untick anyone.
//
//   UNSUBSCRIBE COUNTS EVERYWHERE — an unsubscribe at one location stops
//   marketing at EVERY location, by email address, across owners' accounts.
//   156 non-junk email addresses sit at more than one location today, so this
//   is not hypothetical. The list itself is slice 2; here it is an input
//   (`suppressed`: a set of emailKey() values), and a lead on it is out no
//   matter what its own row says.
//
//   MATCHING — email first. Phone only ever PROPOSES a match: the owner
//   confirms each one, and records are never joined automatically on phone.
//   Name is never used, not even as a tie-breaker.
//
// ── WHY NOT marketingSendBlockReason ────────────────────────────────────────
// lib/marketing-consent.ts also refuses 'no_consent' (no marketing_consented_
// at). That gate is for emails BEE HUB sends. Kevin's rule for Mailchimp is
// everyone by default, owner can switch off — so a missing consent stamp does
// NOT keep someone out here. The opt-out and unsubscribe checks are the same
// two columns, read the same way.
//
// ── WHAT THIS FILE DOES NOT DECIDE ──────────────────────────────────────────
// • Kevin's live switch (mailchimp_sync_live) and the first-sync count
//   confirmation. Those stay in the sending code, where a bare request cannot
//   get round them. A lead being "eligible" here sends nothing by itself.
// • Holding a NEW request until it is sent to Jobber or its card is closed
//   (slice 9). That needs the card's state, which is not a lead column.
// ─────────────────────────────────────────────────────────────────────────────

import { parsePhone } from './phone'

// ── Email key ────────────────────────────────────────────────
// Trimmed + lowercased — the same shape Mailchimp hashes (MD5 of the
// lowercased address), so a Bee Hub key and a Mailchimp member always agree.
// Returns null for anything that is not one plausible address: blank, no @,
// spaces inside, two addresses in one field, nothing after the @'s dot.
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

export function emailKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  if (!s || !EMAIL_RE.test(s)) return null
  return s
}

// ── Phone key, for matching only ─────────────────────────────
// Only a readable US number counts (lib/phone.ts kinds 'us' and 'multi' —
// multi uses its FIRST number, same as the rest of the app). Foreign, stubs
// and junk return null: a phone match on "4" or on a +44 number we cannot
// read is how two strangers get offered as one person.
export function matchPhoneKey(raw: unknown): string | null {
  const p = parsePhone(raw)
  if (p.kind !== 'us' && p.kind !== 'multi') return null
  return p.key.length >= 10 ? p.key : null
}

// ── Eligibility ──────────────────────────────────────────────
export type MailchimpLeadFields = {
  email?: string | null
  is_junk?: boolean | null
  marketing_opt_out?: boolean | null
  marketing_unsubscribed_at?: string | null
  archived_at?: string | null
}

// Ineligible = never offered, not even unticked. The owner cannot tick
// these people in: either there is nothing to send to, the record is being
// deleted, or the PERSON said no.
export type MailchimpIneligibleReason =
  | 'no_email'          // blank or not a usable address
  | 'junk'              // in the Recycle Bin
  | 'opted_out'         // "no marketing emails" set on this record
  | 'unsubscribed'      // unsubscribed via a Bee Hub email
  | 'unsubscribed_elsewhere' // on the shared unsubscribe list (any location)

// Eligible = offered to the owner. `tickedByDefault` is what the review list
// starts with; the owner's tick or untick is a separate input (see
// mailchimpIncluded). Archived people are eligible but start UNTICKED —
// Kevin's ruling 2026-11-23, see ARCHIVED below.
export type MailchimpEligibility =
  | { eligible: true; emailKey: string; tickedByDefault: boolean; archivedAt: string | null }
  | { eligible: false; reason: MailchimpIneligibleReason }

// ── ARCHIVED (Kevin, 2026-11-23) — note for the slice 5 review screen ──────
// Archived (leads.archived_at) is NOT the Recycle Bin (is_junk). The Recycle
// Bin stays out outright. Archived people are the OWNER's call:
//   • they ARE in the first-connect review list,
//   • shown UNTICKED by default, unlike everyone else,
//   • with one short line saying they were archived and when
//     (archivedLine() below),
//   • and the owner ticks them if they want them in Mailchimp.
// 319 people are affected today across 14 locations. About 50 of those were
// archived in a bulk cleanup by Kevin, NOT by their owner, so the owner has
// no idea they were set aside — which is why the line must say so plainly
// and the person must not be hidden behind a filter. The data cannot tell
// Kevin's cleanup from an owner's own archive (there is no "archived by"
// column), so the line shows the date only.
//
// An archived person's own "no marketing emails" or unsubscribe still wins:
// those checks run first, so an archived opt-out is ineligible, not unticked.

export function mailchimpEligibility(
  lead: MailchimpLeadFields,
  opts: { suppressed?: ReadonlySet<string> | null } = {},
): MailchimpEligibility {
  const key = emailKey(lead.email)
  if (!key) return { eligible: false, reason: 'no_email' }
  if (lead.is_junk === true) return { eligible: false, reason: 'junk' }
  if (lead.marketing_opt_out === true) return { eligible: false, reason: 'opted_out' }
  if (lead.marketing_unsubscribed_at) return { eligible: false, reason: 'unsubscribed' }
  // Checked after the record's own flags so the reason names the stronger,
  // local fact when both are true.
  if (opts.suppressed?.has(key)) return { eligible: false, reason: 'unsubscribed_elsewhere' }
  const archivedAt = lead.archived_at || null
  return { eligible: true, emailKey: key, tickedByDefault: !archivedAt, archivedAt }
}

// The owner's tick, if they made one: 'in' (ticked), 'out' (unticked), or
// null (untouched — the default applies). An owner can never tick in someone
// who is ineligible: a person's unsubscribe outranks the owner's tick.
export type OwnerChoice = 'in' | 'out' | null | undefined

export function mailchimpIncluded(
  lead: MailchimpLeadFields,
  opts: { suppressed?: ReadonlySet<string> | null; ownerChoice?: OwnerChoice } = {},
): boolean {
  const e = mailchimpEligibility(lead, opts)
  if (!e.eligible) return false
  if (opts.ownerChoice === 'in') return true
  if (opts.ownerChoice === 'out') return false
  return e.tickedByDefault
}

// Owner words for each reason, for the review list and the client-record
// line. Plain, no jargon; the person-chose reasons all read the same.
export const INELIGIBLE_WORDS: Record<MailchimpIneligibleReason, string> = {
  no_email: 'No email address',
  junk: 'In the Recycle Bin',
  opted_out: 'No marketing emails',
  unsubscribed: 'No marketing emails',
  unsubscribed_elsewhere: 'No marketing emails',
}

// The one short line under an archived person in the review list. The date
// is shown in the LOCATION's time zone (the caller passes it — a UTC date
// can be a day off for an evening archive). Bad or missing dates fall back
// to the line without a date rather than "Invalid Date".
export function archivedLine(archivedAt: string | null | undefined, timeZone: string): string | null {
  if (!archivedAt) return null
  const d = new Date(archivedAt)
  if (Number.isNaN(d.getTime())) return 'Archived. Tick to add them to Mailchimp.'
  let when: string
  try {
    when = d.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    when = d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
  }
  return `Archived on ${when}. Tick to add them to Mailchimp.`
}

// ── Matching ─────────────────────────────────────────────────
// A contact from either side: a Bee Hub lead or a Mailchimp member. `id` is
// whatever that side uses (lead id, member hash). Any name field a caller
// passes in is ignored by design — the type does not even carry one.
export type MatchContact = { id: string; email?: string | null; phone?: string | null }

export type MatchIndex = {
  byEmail: Map<string, string[]>
  byPhone: Map<string, string[]>
}

export function buildMatchIndex(contacts: readonly MatchContact[]): MatchIndex {
  const byEmail = new Map<string, string[]>()
  const byPhone = new Map<string, string[]>()
  const add = (m: Map<string, string[]>, k: string, id: string) => {
    const list = m.get(k)
    if (!list) m.set(k, [id])
    else if (!list.includes(id)) list.push(id)
  }
  for (const c of contacts) {
    const e = emailKey(c.email)
    if (e) add(byEmail, e, c.id)
    const p = matchPhoneKey(c.phone)
    if (p) add(byPhone, p, c.id)
  }
  return { byEmail, byPhone }
}

// The verdict for ONE contact against the other side's index.
//
//   email         — same email address. Safe to treat as the same person.
//                   `ids` may hold more than one: duplicates on that side,
//                   which the caller must not silently collapse.
//   phone_confirm — no email match, but the same phone. NEVER joined
//                   automatically: the owner confirms each one.
//   none          — no match. Name is never consulted.
//
// When the contact HAS an email and it matches nothing, phone is still
// offered (people change email addresses) — as a proposal only.
export type MatchVerdict =
  | { kind: 'email'; ids: string[] }
  | { kind: 'phone_confirm'; ids: string[] }
  | { kind: 'none' }

export function matchContact(contact: MatchContact, index: MatchIndex): MatchVerdict {
  const e = emailKey(contact.email)
  if (e) {
    const ids = index.byEmail.get(e)
    if (ids && ids.length) return { kind: 'email', ids: [...ids] }
  }
  const p = matchPhoneKey(contact.phone)
  if (p) {
    const ids = index.byPhone.get(p)
    if (ids && ids.length) return { kind: 'phone_confirm', ids: [...ids] }
  }
  return { kind: 'none' }
}
