// lib/slack-lead-channel.ts
// Which channel a location's lead posts go to after a Slack connect.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Slack's install screen ALWAYS asks the owner to pick a channel (that is what
// the incoming-webhook permission does), and the callback used to store
// whatever was picked. Fine for a first connection. On a RECONNECT it meant an
// owner who only wanted the new job-channels permission could move their lead
// posts by clicking through — or break them outright by picking a private
// channel the app is not in. Every connected location reconnects once to get
// job channels, so that was a risk to something that already works everywhere.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
//   · Reconnecting to the SAME Slack workspace → keep the channel the location
//     already had, whatever was picked. Only the token and the grant change.
//   · A first connection, or a connection after Disconnect → take the pick.
//   · Connecting to a DIFFERENT workspace → take the pick. The old channel id
//     means nothing there; this is a real move.
//
// ── HOW "THE SAME WORKSPACE" IS TOLD ────────────────────────────────────────
// By Slack's own workspace id (team.id, "T…"), which oauth.v2.access returns
// on every install and the callback has always stored as slack_team_id. It is
// Slack's stable identifier for a workspace: it does not change when the
// workspace is renamed, and two workspaces never share one. NOT the workspace
// name (owners rename those) and not the channel name.
//
// FAILS TOWARD TODAY'S BEHAVIOUR: anything short of "connected, a stored
// workspace id, a stored channel id, and the SAME workspace id coming back"
// takes the pick, exactly as before this file existed. So a location is never
// left with no channel, and a missing id on either side can never pin a
// location to a channel in a workspace it has left.
//
// To move lead posts to another channel in the same workspace on purpose:
// Disconnect, then connect again. Disconnect clears the stored workspace and
// channel (lib/slack-disconnect.ts), so the next connect is a first connection.
//
// Pure — no database, no Slack call — so the rule can be pinned on its own.

export type PriorSlack = {
  slack_connected?: boolean | null
  slack_team_id?: string | null
  slack_channel_id?: string | null
  slack_channel_name?: string | null
} | null | undefined

export type LeadChannelDecision = {
  /** true → leave slack_channel_id / slack_channel_name untouched in the write. */
  keep: boolean
  /** The channel the location posts leads to after this connect. */
  channelId: string | null
  channelName: string | null
  reason: 'same_workspace' | 'first_connection' | 'different_workspace'
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function leadChannelOnConnect(
  prior: PriorSlack,
  incoming: { teamId: unknown; channelId: unknown; channelName: unknown },
): LeadChannelDecision {
  const picked = { channelId: str(incoming.channelId), channelName: str(incoming.channelName) }
  const priorTeam = str(prior?.slack_team_id)
  const priorChannel = str(prior?.slack_channel_id)
  const newTeam = str(incoming.teamId)

  // Not connected before, or connected with nothing worth keeping.
  if (!prior || prior.slack_connected !== true || !priorTeam || !priorChannel) {
    return { keep: false, ...picked, reason: 'first_connection' }
  }
  // Workspace ids are compared exactly. An absent id on the new side is NOT
  // "the same": unknown is treated as a move, which is what happened before.
  if (!newTeam || newTeam !== priorTeam) {
    return { keep: false, ...picked, reason: 'different_workspace' }
  }
  return { keep: true, channelId: priorChannel, channelName: str(prior.slack_channel_name), reason: 'same_workspace' }
}
