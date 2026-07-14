// lib/slack-disconnect.ts
// ─────────────────────────────────────────────────────────────
// Single source of truth for "tear down a location's Slack link".
// Mirrors lib/jobber-disconnect.ts.
//
// Used by the in-app Disconnect button → POST
// /api/locations/[id]/slack-disconnect. (No Slack-side APP_DISCONNECT webhook
// is wired, unlike Jobber — if one is added later it can reuse this helper.)
//
// Clears every Slack token / cached-identity column and flips slack_connected
// to false. Nothing else on the location or in leads is touched.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from './supabase-service'

export type DisconnectResult = { error: string | null }

// Null every Slack connection column on `locations` for the given row (matched
// by the uuid PK — same PK-keyed pattern as the token write).
export async function disconnectSlackFromLocation(
  locationUuid: string,
): Promise<DisconnectResult> {
  const { error } = await supabaseService
    .from('locations')
    .update({
      slack_connected: false,
      slack_bot_token: null,
      slack_team_id: null,
      slack_team_name: null,
      slack_channel_id: null,
      slack_channel_name: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', locationUuid)

  return { error: error ? error.message : null }
}
