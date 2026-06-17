// lib/jobber-disconnect.ts
// ─────────────────────────────────────────────────────────────
// Single source of truth for "tear down a location's Jobber link".
//
// Used by BOTH disconnect paths so they can never drift:
//   1. The in-app Disconnect button → POST /api/locations/[id]/jobber-disconnect
//   2. The Jobber-side APP_DISCONNECT webhook → handleAppDisconnect
//      (lib/jobber-webhook-handlers.ts)
//
// Clears every token / cached-identity column and flips jobber_connected
// to false. INTENTIONALLY preserves:
//   - jobber_account_id  — audit trail of which account WAS connected,
//                          and a cleaner reconnect to the same workspace
//   - all imported lead / sub-record data — the owner may reconnect and
//                          want their history. Nothing in `leads` or the
//                          jobber_* sub-tables is touched here.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'

export type DisconnectResult = { error: string | null }

// Null every Jobber connection column on `locations` for the given row
// (matched by the uuid PK). `lastSyncStatus` lets each caller stamp its
// own audit message: the webhook records "Disconnected from Jobber: <ts>",
// the in-app button passes null (clean slate).
export async function disconnectJobberFromLocation(
  locationUuid: string,
  opts: { lastSyncStatus?: string | null } = {},
): Promise<DisconnectResult> {
  const { error } = await supabaseService
    .from('locations')
    .update({
      jobber_connected:                   false,
      jobber_access_token:                null,
      jobber_refresh_token:               null,
      token_expiry:                       null,
      token_expiry_display:               null,
      jobber_account_name:                null,
      jobber_team_roster:                 null,
      jobber_team_roster_synced_at:       null,
      jobber_initial_import_completed_at: null,
      last_sync_status:                   opts.lastSyncStatus ?? null,
      updated_at:                         new Date().toISOString(),
      // jobber_account_id — preserved on purpose (see file header).
    })
    .eq('id', locationUuid)

  return { error: error ? error.message : null }
}
