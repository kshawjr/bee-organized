// lib/us-timezones.ts
//
// THE list of timezones a location may hold. One list, four consumers:
//   · onboarding  → Settings → Location step dropdown   (components/BeeHub.jsx)
//   · post-onboarding Settings → Location › Timezone row (components/BeeHub.jsx)
//   · super_admin "+ Add Location" form                  (components/BeeHub.jsx)
//   · the two routes that write locations.timezone       (app/api/admin/locations,
//                                                         app/api/locations/[id])
//
// locations.timezone is stored as the friendly LABEL ("Mountain Time (MT)");
// lib/drip-time.ts maps labels → IANA for scheduling and Jobber assessments.
// A value outside this list is not merely cosmetic: requireIanaTimezone throws
// on it, and Send to Jobber calls that check AFTER the Jobber client and
// request already exist — which is exactly how "Phoenix AZ", typed into a
// free-text Settings row, produced a duplicate Jobber client (2026-09-01).
//
// The IANA names are accepted as ALIASES on the way in (the DB default is
// 'America/New_York', and older rows hold IANA strings) and normalised to
// their label for display — never offered as separate choices.

export type UsTimezoneOption = { value: string; label: string; iana: string }

// Arizona is its own entry, NOT folded into Mountain: Phoenix never observes
// daylight saving, so America/Denver is an hour wrong there from March to
// November. Every label here must also appear in lib/drip-time.ts TZ_ALIASES
// (the table requireIanaTimezone reads) — the test suite checks that pairing.
export const US_TIMEZONES: readonly UsTimezoneOption[] = [
  { value: 'Eastern Time (ET)',  label: 'Eastern Time (ET) — New York, Miami',                              iana: 'America/New_York' },
  { value: 'Central Time (CT)',  label: 'Central Time (CT) — Chicago, Dallas, Kansas City',                  iana: 'America/Chicago' },
  { value: 'Mountain Time (MT)', label: 'Mountain Time (MT) — Denver, Salt Lake City',                      iana: 'America/Denver' },
  { value: 'Arizona Time (AZ)',  label: 'Arizona Time (AZ) — Phoenix, Scottsdale, Peoria (no daylight saving)', iana: 'America/Phoenix' },
  { value: 'Pacific Time (PT)',  label: 'Pacific Time (PT) — Los Angeles, Seattle',                         iana: 'America/Los_Angeles' },
  { value: 'Alaska Time (AKT)',  label: 'Alaska Time (AKT)',                                                iana: 'America/Anchorage' },
  { value: 'Hawaii Time (HT)',   label: 'Hawaii Time (HT)',                                                 iana: 'Pacific/Honolulu' },
]

// Stored label (or IANA alias) → the canonical label. null when the value is
// not one of ours ("Phoenix AZ", "", null, "EST", …).
export function normalizeTimezoneLabel(input: string | null | undefined): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  const hit = US_TIMEZONES.find(
    (tz) => tz.value.toLowerCase() === lower || tz.iana.toLowerCase() === lower,
  )
  return hit ? hit.value : null
}

// True for a label or an IANA alias of one; false for anything else,
// including blank. Used by both write routes.
export function isValidTimezoneValue(input: unknown): boolean {
  return typeof input === 'string' && normalizeTimezoneLabel(input) !== null
}
