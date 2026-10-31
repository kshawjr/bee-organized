// lib/merge-tags.ts
//
// THE MERGE TAGS — one list, for every place that names them (2026-10-30).
//
//   OWNER_MERGE_TAGS  what an owner is offered to click into an email, with a
//                     label and one plain sentence each. Shown by the email
//                     editors (components/settings/EmailsScreen.jsx
//                     MergeTagPicker) and the template editor popup.
//   LEGACY_MERGE_TAGS still filled at send time for older wording, but not
//                     offered: each would mislead an owner or duplicate a
//                     better tag.
//   source            where the value comes from — for corporate's Variable
//                     Reference (Admin → Content), not shown to owners.
//
// THE RULE (lib/beta-merge-tags.test.ts): every tag offered here is filled by
// all three client senders (drips, the welcome, the job follow-ups) and by
// the real renderTemplate, and renders a non-empty value when its source is
// set. A tag nothing fills is never offered — {{last_name}} was on the old
// list and rendered as nothing.
//
// The renderer itself is lib/resend.ts renderTemplate (RenderContext);
// {{signature}} is the one tag that is not a RenderContext value — the body
// builders lay it out (lib/email-signature.ts).

export type MergeTagGroup = 'client' | 'people' | 'location' | 'booking'

export type MergeTag = {
  key: string            // without braces
  label: string          // the chip
  description: string    // one plain sentence, for owners
  group: MergeTagGroup
  source: string         // for corporate's reference
}

export const MERGE_TAG_GROUPS: { id: MergeTagGroup; title: string }[] = [
  { id: 'client', title: 'The client' },
  { id: 'people', title: 'You and your team' },
  { id: 'location', title: 'Your location' },
  { id: 'booking', title: 'Booking links' },
]

export const OWNER_MERGE_TAGS: MergeTag[] = [
  { key: 'first_name', label: 'Client’s first name', group: 'client',
    description: 'The client’s first name.',
    source: 'leads.first_name, else the first word of leads.name' },

  { key: 'owner_name', label: 'Assigned person’s name', group: 'people',
    description: 'The full name of whoever the client is assigned to — or the location owner if nobody is.',
    source: 'leads.assigned_to → hub_users.full_name, else the location’s primary owner' },
  { key: 'owner_first_name', label: 'Assigned person’s first name', group: 'people',
    description: 'Just the first name of that same person.',
    source: 'first word of {{owner_name}}' },
  { key: 'location_owner_name', label: 'Owner’s name', group: 'people',
    description: 'The location owner’s full name, whoever the client is assigned to.',
    source: 'the location’s primary owner, hub_users.full_name' },
  { key: 'signature', label: 'Signature', group: 'people',
    description: 'Your whole email signature — photo, name, title, email, mobile and your location’s links. It already includes the name, so put it straight after “Thank you,”.',
    source: 'lib/email-signature.ts, resolved per send (assignee → owner → location)' },

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
    description: 'Your hourly rate, written exactly as you typed it in Your details. An email that uses it waits until it is filled in.',
    source: 'locations.rate_per_hour (free text, e.g. "$95")' },
  { key: 'reviews_link', label: 'Google Reviews link', group: 'location',
    description: 'Your Google Reviews link.',
    source: 'locations.reviews_link' },

  { key: 'book_assessment_link', label: 'In-home assessment link', group: 'booking',
    description: 'Your in-home assessment booking link, from Your details. An email that uses it waits until it is filled in.',
    source: 'locations.calendar_link' },
  { key: 'booking_link', label: 'In-home assessment link (older name)', group: 'booking',
    description: 'Exactly the same link as “In-home assessment link” — an older name for it. Use either; they always match.',
    source: 'locations.calendar_link (alias of {{book_assessment_link}})' },
  { key: 'owner_booking_link', label: 'Assigned person’s booking link', group: 'booking',
    description: 'The assigned person’s own booking link, if they have set one in Settings → Profile; otherwise your in-home assessment link.',
    source: 'assignee hub_users.booking_link → primary owner’s → locations.calendar_link' },
  { key: 'discovery_booking_link', label: 'Discovery call link', group: 'booking',
    description: 'Your discovery call booking link, from Your details. An email that uses it waits until it is filled in.',
    source: 'locations.discovery_booking_link (migrations/locations_booking_links.sql)' },
  { key: 'virtual_booking_link', label: 'Video assessment link', group: 'booking',
    description: 'Your video assessment booking link, from Your details. An email that uses it waits until it is filled in.',
    source: 'locations.virtual_booking_link (migrations/locations_booking_links.sql)' },
]

// Filled at send time, NOT offered to owners — and why.
export const LEGACY_MERGE_TAGS: (Omit<MergeTag, 'group' | 'label'> & { why: string })[] = [
  { key: 'organizer_name', source: 'locations.sender_name (Settings → Emails → Main name)',
    description: 'The location’s sending name.',
    why: 'Used by the old t1–t9 templates. Was offered to owners as “Your Name”, but it is the location’s Main name (often “Bee Organized …”), not the person — {{owner_name}} is what owners mean.' },
  { key: 'phone', source: 'locations.phone, else the primary owner’s phone',
    description: 'The location phone, or the owner’s if the location has none.',
    why: 'Older name. The current master wording uses {{location_phone}}; offering both read as two different numbers.' },
  { key: 'partner_name', source: '(Partner Drip — Phase 2)',
    description: 'Nothing yet.',
    why: 'Declared in RenderContext but never filled — renders as empty. Not offered.' },
]

export const mergeTagToken = (key: string) => `{{${key}}}`

// Put `token` into `value` where the cursor is (replacing any selection), and
// say where the cursor should land after it. With no cursor information the
// token goes at the end.
export function insertAtCursor(value: string, token: string, start?: number | null, end?: number | null): { next: string; caret: number } {
  const s = typeof start === 'number' ? Math.max(0, Math.min(start, value.length)) : value.length
  const e = typeof end === 'number' ? Math.max(s, Math.min(end, value.length)) : s
  return { next: value.slice(0, s) + token + value.slice(e), caret: s + token.length }
}
