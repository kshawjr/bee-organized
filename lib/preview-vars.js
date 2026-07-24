// lib/preview-vars.js
//
// The ONE preview variable source. buildPreviewVars() mirrors the FULL
// send-time RenderContext that lib/drip-send.ts assembles (the `ctx` object
// handed to renderTemplate) — all 14 variables, same keys, same resolution
// order where the UI can know it. Every preview surface substitutes through
// this module so a preview can never again show an empty hole that the real
// send would fill (the old TemplatePreviewModal map implemented only 7 of
// the 14, so {{rate_per_hour}} / {{owner_name}} / {{book_assessment_link}}
// previewed as gaps).
//
// RenderContext also declares a 15th optional key, partner_name — that one
// is Partner Drip Phase 2, resolves to nothing at send time today, and is
// deliberately NOT previewed as a filled value.
//
// Values are guaranteed non-empty strings: a preview's job is to show what a
// healthy send looks like, so unset location fields fall back to labelled
// sample values rather than rendering the same blank the rate/booking-link
// send guards exist to prevent.

// The 14 keys drip-send.ts actually sends with. Order matches the ctx
// literal in lib/drip-send.ts for easy eyeball diffing.
export const PREVIEW_VAR_KEYS = [
  'first_name',
  'organizer_name',
  'location_name',
  'phone',
  'booking_link',
  'service_area',
  'owner_name',
  'owner_first_name',
  'owner_booking_link',
  'location_owner_name',
  'rate_per_hour',
  'location_phone',
  'book_assessment_link',
  'reviews_link',
]

const first = (...vals) => {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return ''
}

// settings is the SettingsScreen shape ({ profile, location }) — both parts
// optional so surfaces without a signed-in context (onboarding, admin
// master editors) still get a fully-populated sample preview.
export function buildPreviewVars(settings = {}) {
  const loc = settings?.location || {}
  const profile = settings?.profile || {}

  const locationName = first(loc.name, 'Bee Organized')
  const locationPhone = first(loc.phone, '(555) 123-4567')
  const bookingLink = first(loc.bookingLink, 'https://example.com/book')

  // Send time: {{owner_name}} is the lead's assignee, falling back to the
  // location's primary owner. The preview can't know a lead, so the
  // signed-in profile stands in for both.
  const ownerName = first(
    [profile.firstName, profile.lastName].filter(Boolean).join(' '),
    loc.sendFromName,
    'Sarah Mitchell',
  )

  return {
    first_name: 'John',
    organizer_name: first(loc.sendFromName, profile.firstName, 'Sarah'),
    location_name: locationName,
    phone: first(loc.phone, profile.phone, '(555) 123-4567'),
    booking_link: bookingLink,
    service_area: first(
      [loc.city, loc.state].filter(Boolean).join(', '),
      locationName,
    ),
    owner_name: ownerName,
    owner_first_name: ownerName.split(/\s+/)[0],
    // Mirrors lib/booking-link: assignee's own link → location owner's →
    // locations.calendar_link.
    owner_booking_link: first(profile.bookingLink, loc.bookingLink, 'https://example.com/book'),
    location_owner_name: ownerName,
    rate_per_hour: first(loc.ratePerHour, '$95'),
    location_phone: locationPhone,
    book_assessment_link: bookingLink,
    reviews_link: first(loc.reviewsLink, 'https://g.page/bee-organized/review'),
  }
}

// Same substitution semantics as lib/resend.ts applyVars: {{word}} tokens,
// unknown/empty keys render as empty string so a preview never shows a
// literal {{placeholder}} the send would have stripped.
const VAR_RE = /\{\{(\w+)\}\}/g

export function applyPreviewVars(text, vars) {
  if (!text) return ''
  return String(text).replace(VAR_RE, (_m, key) => {
    const v = vars?.[key]
    return v === null || v === undefined ? '' : String(v)
  })
}
