// lib/jobber-reconnect.ts
// ─────────────────────────────────────────────────────────────
// Reads the one Jobber token state that does NOT recover by itself.
//
// lib/jobber performRefresh writes exactly
//   `RECONNECT REQUIRED — Jobber rejected refresh token (<status>) @ <YYYY-MM-DDTHH:MM:SS>`
// (UTC, no zone suffix) onto locations.last_sync_status — and only after the
// race-loss check (#102) has found no sibling that rotated the token, so the
// stamp means "a human must reconnect Jobber". The next successful refresh
// overwrites it with 'Token refreshed: …'. Both the instant alert (the moment
// a location gets stamped) and the daily digest (locations still stamped)
// read it through here, so the two can never disagree about the wording.
// ─────────────────────────────────────────────────────────────

// Returns the stamp's time in ms, or null for any other status.
export function parseReconnectStamp(status: string | null | undefined): number | null {
  if (!status || !/^RECONNECT REQUIRED/i.test(status)) return null
  const at = status.match(/@\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/)?.[1]
  const ms = at ? Date.parse(`${at}Z`) : NaN
  return Number.isFinite(ms) ? ms : null
}
