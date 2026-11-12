// lib/slack-scopes.ts
// "Can this location's Slack app manage channels?" — one answer, used by the
// screen (SlackCard's reconnect line) and the server (lib/engagement-bees.ts).
//
// Shared on purpose, the way linkedinFor lives in lib/email-signature.ts: this
// file imports nothing server-side, so the browser bundle can use it too. The
// one helper that WRITES (recordSlackMissingScope) lives in
// lib/slack-scopes-server.ts so no database client is pulled into the screen.
//
// ── WHAT THE STORED VALUE MEANS ─────────────────────────────────────────────
// locations.slack_scopes (migrations/slack_scopes.sql) is the comma-separated
// scope string Slack's oauth.v2.access returned at the location's most recent
// connect. Every location connected before that column existed holds NULL,
// which means UNKNOWN, and unknown is read as "old scopes" — not ready. Nothing
// guesses or backfills it: a location proves it has the scope by reconnecting.
//
// ── WHY STORED SCOPES ARE NOT THE LAST WORD ─────────────────────────────────
// The stored string is what Slack granted on the day of the install. An owner
// can later remove the app or change it. When a real channel call comes back
// { ok:false, error:'missing_scope', needed, provided }, that answer is
// authoritative and must flip the location back to not-ready:
// scopesAfterMissingScope() computes the corrected string from that answer,
// and recordSlackMissingScope() (server file) stores it. lib/engagement-bees.ts
// calls it from every channel call that can come back missing_scope.

/** The one scope that covers create, invite, kick, archive and unarchive for
 *  PUBLIC channels. Private channels (groups:write) are deliberately not asked
 *  for — see app/api/slack/connect/route.ts. */
export const SLACK_CHANNELS_SCOPE = 'channels:manage'

/** Split Slack's comma-separated scope string into a set. Null/blank → empty. */
export function parseSlackScopes(raw: unknown): Set<string> {
  if (typeof raw !== 'string') return new Set()
  return new Set(
    raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
  )
}

export type SlackScopeLocation = {
  slack_connected?: boolean | null
  slack_scopes?: string | null
}

/**
 * True only when the location is connected AND its stored grant includes
 * channels:manage. Null scopes (every pre-migration connect) → false.
 * Not connected → false.
 */
export function slackCanManageChannels(loc: SlackScopeLocation | null | undefined): boolean {
  if (!loc || !loc.slack_connected) return false
  return parseSlackScopes(loc.slack_scopes).has(SLACK_CHANNELS_SCOPE)
}

/**
 * The runtime-correction hook. Given a Slack Web API response body, returns
 * the scope string that should now be stored, or null when the response is
 * not a missing_scope answer (nothing to correct).
 *
 * Slack's missing_scope body carries `provided` (what the token actually has
 * right now) and `needed` (what the call wanted). `provided` is the truth and
 * is stored as-is. If Slack ever omits it, the stored set minus `needed` is
 * used instead — and if `needed` is absent too, channels:manage is removed,
 * because a missing_scope from a channel call means exactly that.
 *
 * The result never contains the scope Slack said was missing, so the location
 * reads as not-ready afterwards whatever the stored string said before.
 */
export function scopesAfterMissingScope(
  stored: string | null | undefined,
  slackResponse: unknown,
): string | null {
  const r = slackResponse as { ok?: unknown; error?: unknown; needed?: unknown; provided?: unknown } | null
  if (!r || r.ok !== false || r.error !== 'missing_scope') return null

  const needed = parseSlackScopes(r.needed)
  if (needed.size === 0) needed.add(SLACK_CHANNELS_SCOPE)

  const base = typeof r.provided === 'string' ? parseSlackScopes(r.provided) : parseSlackScopes(stored)
  needed.forEach((n) => base.delete(n))
  return Array.from(base).join(',')
}
