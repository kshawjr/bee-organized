// lib/booking-link.ts
//
// Per-user booking link: the resolution chain behind {{owner_booking_link}},
// and the send guard that stops a linkless "click HERE".
//
// WHY THIS EXISTS. {{book_assessment_link}} and {{booking_link}} both render
// locations.calendar_link, so every owner at a location sends the same
// calendar. When a lead is ASSIGNED to a person, the email should carry that
// person's link. {{owner_booking_link}} resolves:
//
//   1. lead.assigned_to  → that hub_user's booking_link
//   2. the location's primary owner's booking_link
//   3. locations.calendar_link                    ← today's behavior, kept
//
// Tier 3 is deliberate and permanent: an unassigned lead, or an assignee who
// never set a link, still gets the location's calendar rather than nothing.
// Mirrors the {{owner_name}} chain (assignee → location owner) one tier deeper.
//
// PRE-MIGRATION SAFETY. hub_users.booking_link does not exist until
// migrations/hub_users_booking_link.sql is run, and this code ships first.
// So the hub_users reads are their OWN queries that swallow the "column does
// not exist" error and return null — deliberately NOT widened into the
// existing selects in owner-resolution / the send rails, because widening one
// of those would error the whole row and silently take {{owner_name}} and the
// phone fallback down with it. Column absent → every tier-1/2 read is null →
// the chain resolves to calendar_link → byte-identical to today.
//
// THE GUARD. Same shape and same reasoning as lib/rate-guard.ts: a pure
// predicate, in its own module, checked against the template SOURCE before
// rendering. An unresolved tag substitutes as EMPTY STRING, so a booking
// template with no link ships "Please click here () to select a day and time"
// — a hole only the client sees. Template quotes a booking tag + that tag's
// value resolves empty → HOLD the send (row untouched, cron retries) instead.
// Never invent a placeholder link.

import { supabaseService } from './supabase-service'

const blank = (v: unknown): boolean =>
  v === null || v === undefined || String(v).trim() === ''

const clean = (v: unknown): string | null => (blank(v) ? null : String(v).trim())

// The three tags that render a scheduling URL. {{owner_booking_link}} is the
// new per-assignee tag; the other two are the location-level aliases the Gen 2
// masters quote today. All three produce the same broken sentence when their
// value is blank, so all three are guarded.
export const OWNER_BOOKING_TAG = '{{owner_booking_link}}'
export const LOCATION_BOOKING_TAGS = ['{{book_assessment_link}}', '{{booking_link}}'] as const
// Their own links (2026-10-30): a discovery call and a virtual assessment.
export const DISCOVERY_BOOKING_TAG = '{{discovery_booking_link}}'
export const VIRTUAL_BOOKING_TAG = '{{virtual_booking_link}}'

// ── tier 1 / 2: one user's own link ──────────────────────────────────
// Never throws, never widens someone else's query. A missing column, a
// missing row, or a read hiccup all mean the same thing here: this user
// contributes nothing, fall through to the next tier.
export async function fetchUserBookingLink(
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null
  try {
    const { data, error } = await supabaseService
      .from('hub_users')
      .select('booking_link')
      .eq('id', userId)
      .maybeSingle()
    if (error || !data) return null
    return clean((data as { booking_link?: unknown }).booking_link)
  } catch {
    return null
  }
}

// ── the chain ────────────────────────────────────────────────────────
// assignee → location primary owner → locations.calendar_link.
// Short-circuits: an unassigned lead skips the tier-1 read entirely, and a
// tier-1 hit skips tier 2. Returns null only when the location has no
// calendar_link either — which is exactly the case the guard below holds on.
export async function resolveOwnerBookingLink(args: {
  assignedToUserId: string | null | undefined
  locationOwnerUserId: string | null | undefined
  locationCalendarLink: string | null | undefined
}): Promise<string | null> {
  const assignee = await fetchUserBookingLink(args.assignedToUserId)
  if (assignee) return assignee

  // Skip the second read when the location owner IS the assignee — we just
  // asked about them.
  if (args.locationOwnerUserId && args.locationOwnerUserId !== args.assignedToUserId) {
    const owner = await fetchUserBookingLink(args.locationOwnerUserId)
    if (owner) return owner
  }

  return clean(args.locationCalendarLink)
}

// ── the guard ────────────────────────────────────────────────────────
// Per-TAG accurate, because the two families resolve from different places:
// {{owner_booking_link}} carries the resolved chain, while the legacy aliases
// only ever carry locations.calendar_link. A template quoting an alias at a
// location with no calendar_link still ships a hole even when the assignee
// has a personal link, so the two are checked separately.
export function blockedOnMissingBookingLink(
  template: { subject: string | null; body: string | null },
  links: {
    ownerBookingLink: string | null | undefined
    locationCalendarLink: string | null | undefined
    // The two links added 2026-10-30. Absent → treated as blank, so an email
    // using one of their tags holds exactly like the in-home link does.
    discoveryBookingLink?: string | null | undefined
    virtualBookingLink?: string | null | undefined
  },
): boolean {
  const source = `${template.subject ?? ''}\n${template.body ?? ''}`
  if (source.includes(OWNER_BOOKING_TAG) && blank(links.ownerBookingLink)) return true
  if (
    LOCATION_BOOKING_TAGS.some((t) => source.includes(t)) &&
    blank(links.locationCalendarLink)
  ) {
    return true
  }
  if (source.includes(DISCOVERY_BOOKING_TAG) && blank(links.discoveryBookingLink)) return true
  if (source.includes(VIRTUAL_BOOKING_TAG) && blank(links.virtualBookingLink)) return true
  return false
}

// Owner-actionable copy for the held-send status write on the lead row.
//
// IT NAMES THE FIELD THAT RELEASES THE EMAIL (2026-11-13). The one sentence it
// used to be sent every owner to Settings → Profile → Booking Link. That link
// fills {{owner_booking_link}} ONLY. An email held on the in-home tags
// ({{book_assessment_link}} / {{booking_link}}) reads locations.calendar_link
// and nothing else, so an owner who followed the instruction stayed stuck —
// Portland, 13 Nov: the owner's own link was set and the first email still
// waited. Same per-tag checks, in the same order, as the guard above; the two
// are pinned against each other (a held email always gets a named field).
const HELD_TAIL = 'The email is held until then and goes out on its own once it is saved.'
export function missingBookingLinkMessage(
  template: { subject: string | null; body: string | null },
  links: Parameters<typeof blockedOnMissingBookingLink>[1],
): string {
  const source = `${template.subject ?? ''}\n${template.body ?? ''}`
  const fields: string[] = []
  if (LOCATION_BOOKING_TAGS.some((t) => source.includes(t)) && blank(links.locationCalendarLink)) {
    fields.push('In-home assessment link')
  }
  if (source.includes(DISCOVERY_BOOKING_TAG) && blank(links.discoveryBookingLink)) fields.push('Discovery call link')
  if (source.includes(VIRTUAL_BOOKING_TAG) && blank(links.virtualBookingLink)) fields.push('Video assessment link')
  const ownerHeld = source.includes(OWNER_BOOKING_TAG) && blank(links.ownerBookingLink)
  const parts: string[] = []
  if (fields.length) {
    const names = fields.length === 1 ? fields[0] : `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}`
    parts.push(
      `This email asks the client to click a booking link that is blank. Fill in the ${names} in Settings → Emails → Your details.`,
    )
  }
  if (ownerHeld) {
    parts.push(
      'This email uses the assigned person’s own booking link and none is saved. Set it in Settings → Profile → Booking Link, ' +
      'or fill in the In-home assessment link in Settings → Emails → Your details.',
    )
  }
  if (!parts.length) parts.push('This email asks the client to click a booking link that is blank. Check the links in Settings → Emails → Your details.')
  return `${parts.join(' ')} ${HELD_TAIL}`
}
