// lib/partner-merge-tags.ts
//
// THE PARTNER MERGE TAGS — partner emails, slice 1 (2026-11-21).
//
// The tags an email to a REFERRAL PARTNER may use, and the merge context that
// fills them. Kevin's ruling: partner emails get only tags that make sense on
// a partner — nothing that needs a client record.
//
//   PARTNER_MERGE_TAGS    what a partner email is offered, label + one plain
//                         sentence each. For the picker in a later slice; no
//                         screen reads it yet.
//   CLIENT_ONLY_TAG_KEYS  every client tag left out, and why — the tests
//                         assert none of them is ever in the partner list.
//   partnerRenderContext  the context for renderTemplate (lib/resend.ts) for
//                         one partner at one location. It holds ONLY the
//                         partner tags' values, so a client tag in a partner
//                         email renders blank instead of borrowing a client.
//
// The client list (lib/merge-tags.ts OWNER_MERGE_TAGS) is not touched:
// {{partner_name}} is still never offered to, or filled for, a client.
//
// This module sends nothing. It imports the RenderContext TYPE only (erased
// at build); lib/partner-merge-tags.test.ts fails if it ever imports the
// sender, the Resend client or the drip engine.

import type { RenderContext } from './resend'
import type { MergeTag } from './merge-tags'
import { partnerGreetingName, type PartnerNameRow } from './network/partner-greeting'

export type PartnerMergeTagGroup = 'partner' | 'people' | 'location'

export type PartnerMergeTag = Omit<MergeTag, 'group'> & { group: PartnerMergeTagGroup }

export const PARTNER_MERGE_TAG_GROUPS: { id: PartnerMergeTagGroup; title: string }[] = [
  { id: 'partner', title: 'The partner' },
  { id: 'people', title: 'You' },
  { id: 'location', title: 'Your location' },
]

export const PARTNER_MERGE_TAGS: PartnerMergeTag[] = [
  { key: 'partner_name', label: 'Partner’s name', group: 'partner',
    description: 'The partner’s first name — or, for an organization or a joint name like “Drew & Bill Crowley”, the whole name.',
    source: 'lib/network/partner-greeting.ts: organization → partners.name; joint name → partners.name; else partners.first_name, else partners.name' },

  { key: 'location_owner_name', label: 'Owner’s name', group: 'people',
    description: 'Your location owner’s full name.',
    source: 'the location’s primary owner, hub_users.full_name' },
  { key: 'signature', label: 'Signature', group: 'people',
    description: 'Your whole email signature — photo, name, title, email, mobile and your location’s links. A partner has no assigned person, so the location owner signs it (or the location, if no owner is active).',
    source: 'lib/email-signature-resolve.ts with no assignee (owner → location)' },

  { key: 'location_name', label: 'Location name', group: 'location',
    description: 'Your location’s name, as it is set in Settings → Location.',
    source: 'locations.name' },
  { key: 'location_phone', label: 'Location phone', group: 'location',
    description: 'Your location’s phone number.',
    source: 'locations.phone' },
  { key: 'service_area', label: 'City and state', group: 'location',
    description: 'Your city and state, like “Boulder, CO”.',
    source: 'locations.city + ", " + locations.state' },
  { key: 'rate_per_hour', label: 'Hourly rate', group: 'location',
    description: 'Your hourly rate, written exactly as you typed it in Your details.',
    source: 'locations.rate_per_hour (free text, e.g. "$95")' },
  { key: 'reviews_link', label: 'Google Reviews link', group: 'location',
    description: 'Your Google Reviews link.',
    source: 'locations.reviews_link' },
]

// Every tag a client email can use that a partner email may NOT, and why.
// Kept as data so the tests can assert against each one by name.
export const CLIENT_ONLY_TAG_KEYS: { key: string; why: string }[] = [
  { key: 'first_name', why: 'The client’s first name — a partner is not a client.' },
  { key: 'last_name', why: 'A client field, and filled by nothing even for clients.' },
  { key: 'owner_name', why: 'Reads the client’s assigned person (leads.assigned_to).' },
  { key: 'owner_first_name', why: 'First word of the client’s assigned person.' },
  { key: 'owner_booking_link', why: 'A booking link, and it reads the client’s assigned person.' },
  { key: 'book_assessment_link', why: 'A booking link for a client to book a job.' },
  { key: 'booking_link', why: 'Older name for the same client booking link.' },
  { key: 'discovery_booking_link', why: 'A booking link for a client to book a call.' },
  { key: 'virtual_booking_link', why: 'A booking link for a client to book a video assessment.' },
  { key: 'organizer_name', why: 'Legacy, not offered to anyone; {{location_name}} / {{location_owner_name}} say it better.' },
  { key: 'phone', why: 'Legacy name for the location phone; {{location_phone}} is the one offered.' },
]

/** The location columns the partner tags read (lib/drip-send.ts reads the same ones). */
export type PartnerLocationRow = {
  name: string | null
  phone: string | null
  city: string | null
  state: string | null
  rate_per_hour: string | null
  reviews_link: string | null
}

/**
 * The merge context for one partner email. {{signature}} is not in it — it is
 * laid out by the body builders, as for client email (lib/resend.ts).
 */
export function partnerRenderContext(args: {
  partner: PartnerNameRow
  location: PartnerLocationRow
  locationOwnerName: string | null
}): RenderContext {
  const { partner, location: loc, locationOwnerName } = args
  // Same rule as the client senders (lib/drip-send.ts serviceArea).
  const serviceArea = loc.city && loc.state ? `${loc.city}, ${loc.state}` : loc.city || loc.state || null
  return {
    partner_name: partnerGreetingName(partner),
    location_owner_name: locationOwnerName,
    location_name: loc.name,
    location_phone: loc.phone,
    service_area: serviceArea,
    rate_per_hour: loc.rate_per_hour,
    reviews_link: loc.reviews_link,
  }
}
