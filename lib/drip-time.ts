// lib/drip-time.ts
// Time-zone helpers for drip sends. Drips fire at 9am in the location's
// timezone. locations.timezone is sometimes stored as a friendly label
// like "Eastern Time (ET)" rather than an IANA identifier, so we
// normalize before handing the value to date-fns-tz.

import { fromZonedTime, toZonedTime, format } from 'date-fns-tz'

const TZ_ALIASES: Record<string, string> = {
  'eastern time (et)':  'America/New_York',
  'central time (ct)':  'America/Chicago',
  'mountain time (mt)': 'America/Denver',
  'pacific time (pt)':  'America/Los_Angeles',
  'alaska time (akt)':  'America/Anchorage',
  'hawaii time (ht)':   'Pacific/Honolulu',
  // Older variant that previously appeared in seed/docs. Kept so any rows
  // still holding the (HST) label keep resolving correctly.
  'hawaii time (hst)':  'Pacific/Honolulu',
  et: 'America/New_York',
  ct: 'America/Chicago',
  mt: 'America/Denver',
  pt: 'America/Los_Angeles',
}

export function resolveTimezone(input: string | null | undefined): string {
  if (!input) return 'UTC'
  const trimmed = input.trim()
  if (!trimmed) return 'UTC'
  const lower = trimmed.toLowerCase()
  if (TZ_ALIASES[lower]) return TZ_ALIASES[lower]
  // Heuristic: anything with a slash (e.g. "America/New_York") we assume
  // is already a valid IANA name. date-fns-tz will throw downstream if not.
  if (trimmed.includes('/')) return trimmed
  return 'UTC'
}

// Strict variant for callers that cannot tolerate a silent UTC fallback —
// notably Jobber's LocalDateTimeAttributes, where the wrong zone shows up
// on the wrong day in the customer's calendar. Throws with an actionable
// message instead of returning 'UTC'.
export function requireIanaTimezone(input: string | null | undefined): string {
  if (!input || !input.trim()) {
    throw new Error('location timezone is not set')
  }
  const trimmed = input.trim()
  const lower = trimmed.toLowerCase()
  if (TZ_ALIASES[lower]) return TZ_ALIASES[lower]
  // Already IANA-shaped (contains a slash) — trust it; date-fns-tz will
  // surface its own error on use if the name is bogus.
  if (trimmed.includes('/')) return trimmed
  throw new Error(
    `unrecognized timezone "${trimmed}" — expected an IANA name like ` +
    `"America/New_York" or one of the standard US labels`,
  )
}

// Returns the UTC instant corresponding to 9am on the given calendar day
// (in `tz`). If `addDays > 0`, advances the calendar day first.
export function nextSendAt(args: {
  from: Date
  tz: string
  delayDays: number
}): Date {
  const tz = resolveTimezone(args.tz)

  // Convert "now" into the location's wall-clock so we can compute the
  // local calendar day, then construct the target wall-clock time.
  const localNow = toZonedTime(args.from, tz)

  // Build local-9am for (today + delay). The minimum is the next 9am —
  // if it's already past 9am today and delayDays=0, advance one day so we
  // never send "today, several hours ago".
  let targetDay = new Date(
    localNow.getFullYear(),
    localNow.getMonth(),
    localNow.getDate() + Math.max(0, args.delayDays),
    9,
    0,
    0,
    0,
  )

  // For delay=0: if it's already 9am or later locally, push to tomorrow.
  if (args.delayDays === 0 && targetDay.getTime() <= localNow.getTime()) {
    targetDay = new Date(
      localNow.getFullYear(),
      localNow.getMonth(),
      localNow.getDate() + 1,
      9,
      0,
      0,
      0,
    )
  }

  // Format the local wall-clock as an ISO-like string with no offset, then
  // re-anchor it in `tz` to get the correct UTC instant.
  const wall = format(targetDay, "yyyy-MM-dd'T'HH:mm:ss")
  return fromZonedTime(wall, tz)
}
