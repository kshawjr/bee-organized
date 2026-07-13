// lib/jobber-status.ts
// ─────────────────────────────────────────────────────────────────────────────
// SINGLE source of truth for Jobber connection-status derivation. Pure — no
// React, no DOM, no secrets — so the SAME logic feeds BOTH the client-side
// connection card (re-exported through components/BeeHub.jsx) and the
// server-side admin all-locations health view (app/api/admin/jobber-health).
//
// This bug class came entirely from DRIFTING copies of this derivation:
//   • v1 — a bare `jobber_connected` boolean that only flips at OAuth callback
//     / manual Disconnect. It hid a 2-month dead-token outage: Kansas City
//     showed "✅ Connected" over a "RECONNECT REQUIRED" last_sync_status.
//   • v2 — over-corrected: it flagged ANY past `token_expiry` as
//     reconnect_required. But the access token is short-lived BY DESIGN and is
//     silently renewed from the refresh token on the next webhook — so a
//     normally-expired access token with a HEALTHY refresh token is NOT broken.
//     That false alarm made ~5 healthy locations look dead.
//
// The truth (three meaningful states):
//   connected          — a valid access token, OR an expired-but-refreshable
//                        one (refresh token present, no 401 stamp). It will
//                        auto-renew; not an error.
//   reconnect_required — genuinely dead: a fail-loud 401 refresh-rejection
//                        stamp, OR a connected flag with no access token ever
//                        obtained (the "half-connection" case), OR a missing
//                        refresh token (nothing left to renew with).
//   disconnected       — never connected / manually disconnected.
// ─────────────────────────────────────────────────────────────────────────────

export type JobberStatus = 'connected' | 'reconnect_required' | 'disconnected'

export interface JobberStatusInput {
  connected?: boolean | null
  tokenExpiry?: string | number | null
  lastSyncStatus?: string | null
  // Token-PRESENCE booleans, threaded server-side. The raw tokens are NEVER
  // sent to the client — only these booleans cross the wire. Optional: when a
  // caller can't supply them (client card, mock data, unit tests) they stay
  // undefined and the derivation falls back to connected/expiry/stamp signals.
  // Only an explicit `false` trips reconnect_required — "we couldn't tell"
  // (undefined) is never treated as a failure ("absence of a failure signal is
  // not itself a failure").
  hasAccessToken?: boolean | null
  hasRefreshToken?: boolean | null
}

// token_expiry is stored as epoch-ms (string or number). Mirror the parse in
// lib/jobber.ts getValidJobberToken so "expired" means the same thing here.
export function parseExpiryMs(tokenExpiry?: string | number | null): number {
  return tokenExpiry !== null && tokenExpiry !== undefined && tokenExpiry !== ''
    ? parseInt(String(tokenExpiry), 10)
    : 0
}

export function deriveJobberStatus({
  connected,
  lastSyncStatus,
  hasAccessToken,
  hasRefreshToken,
}: JobberStatusInput = {}): JobberStatus {
  if (!connected) return 'disconnected'

  // Fail-loud 401 stamp — Jobber rejected the refresh token. Genuinely dead;
  // needs a manual reconnect. Wins over every other signal (even a future
  // token_expiry that a stale refresh left behind).
  const reconnectStamp =
    typeof lastSyncStatus === 'string' && lastSyncStatus.startsWith('RECONNECT REQUIRED')
  if (reconnectStamp) return 'reconnect_required'

  // A connected flag with NO access token ever obtained (the half-connection:
  // the OAuth row exists but the token exchange never completed), or a MISSING
  // refresh token (nothing left to silently renew with), is dead. Only trust
  // these when the boolean was actually threaded (=== false).
  if (hasAccessToken === false) return 'reconnect_required'
  if (hasRefreshToken === false) return 'reconnect_required'

  // Everything else is healthy — INCLUDING a normally-expired access token.
  // Expiry alone no longer trips amber: the next authenticated call / webhook
  // refreshes it from the (present, un-rejected) refresh token. This is the
  // false-alarm fix.
  return 'connected'
}

export interface JobberStatusView {
  status: JobberStatus
  autoRefreshing: boolean
  // 4-way display label the card + admin view render.
  label: 'Connected' | 'Auto-refreshing' | 'Reconnect required' | 'Never connected'
  tone: 'ok' | 'info' | 'warn' | 'muted'
}

// Presentation refinement built ON TOP of the canonical derivation — it CALLS
// deriveJobberStatus (no parallel logic) and only splits the single 'connected'
// state into two labels: a valid token reads "Connected", an expired-but-
// auto-renewing one reads "Auto-refreshing" (reassuring, not alarming).
export function jobberStatusView(input: JobberStatusInput = {}): JobberStatusView {
  const status = deriveJobberStatus(input)
  const expiryMs = parseExpiryMs(input.tokenExpiry)
  const accessExpired = expiryMs > 0 && Date.now() >= expiryMs
  const autoRefreshing = status === 'connected' && accessExpired

  const label: JobberStatusView['label'] =
    status === 'reconnect_required' ? 'Reconnect required'
    : status === 'disconnected'     ? 'Never connected'
    : autoRefreshing                ? 'Auto-refreshing'
    :                                 'Connected'

  const tone: JobberStatusView['tone'] =
    status === 'reconnect_required' ? 'warn'
    : status === 'disconnected'     ? 'muted'
    : autoRefreshing                ? 'info'
    :                                 'ok'

  return { status, autoRefreshing, label, tone }
}
