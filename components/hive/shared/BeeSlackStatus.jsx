// components/hive/shared/BeeSlackStatus.jsx
// ─────────────────────────────────────────────────────────────
// The bee → Slack channel status line. The AssigneeSyncStatus idiom, for
// Slack instead of Jobber: POST/DELETE /api/engagements/:id/bees returns a
// slack_sync outcome (lib/engagement-bees BeeSlackOutcome) and this turns it
// into ONE plain line under the Bees cell, spoken to an owner about their
// job — never a Slack error code.
//
// SILENT ON SUCCESS and when the job has no channel (slack_sync null).
// Every other outcome speaks, because an owner who believes a bee is off a
// job while they are still reading the channel is worse than an error.
// "still_in_channel" is the one that matters most: some workspaces forbid
// apps from removing people, and the owner must do it in Slack by hand.
//
// Accepts one outcome or a list (the create dialog can hit several).
// §8.5 props only, no context. Token-pure.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { T } from './tokens'

const chan = (name) => (name ? `#${name}` : 'the job’s channel')

// Pure map: outcome → { tone, text } or null for silence. Exported so a test
// can read every case without a fetch.
export function beeSlackNote(sync) {
  if (!sync || sync.status === 'ok') return null
  switch (sync.status) {
    case 'still_in_channel':
      return {
        tone: 'fail',
        text: `${sync.bee} is off this job in Bee Hub, but is STILL IN ${chan(sync.channel)} — your Slack doesn’t let apps remove people. Remove them in Slack: open the channel, tap the member list, then Remove from channel.`,
      }
    case 'add_refused':
      return { tone: 'fail', text: `${sync.bee} is on this job in Bee Hub, but your Slack doesn’t let apps add people to channels. Add them in Slack.` }
    case 'not_in_slack':
      return { tone: 'info', text: `${sync.bee} is on this job, but nobody in your Slack uses ${sync.email}, so they weren’t added to the channel. Check their email in Settings › Team and leads.` }
    case 'owner_not_in_slack':
      return { tone: 'info', text: `${sync.bee}, the owner, wasn’t added to the channel: nobody in your Slack uses ${sync.email}, the email they sign in to Bee Hub with. Add them in Slack.` }
    case 'owner_not_added':
      return { tone: 'info', text: `${sync.bee}, the owner, wasn’t added to the channel — Slack didn’t let Bee Hub add them. Add them in Slack.` }
    case 'scope_lost':
      return { tone: 'fail', text: 'Saved here, but Slack no longer lets Bee Hub manage channels, so Slack wasn’t changed. Reconnect Slack in Settings to turn it back on.' }
    case 'channel_gone':
      return { tone: 'fail', text: 'Saved here, but this job’s Slack channel was deleted in Slack. You can make a new one.' }
    case 'archived':
      return { tone: 'info', text: 'Saved here. This job is closed and its channel is archived, so Slack wasn’t changed.' }
    case 'unavailable':
      return sync.action === 'remove'
        ? { tone: 'fail', text: `${sync.bee} is off this job in Bee Hub, but Slack didn’t answer — they may still be in the channel. Untick and tick again shortly, or remove them in Slack.` }
        : { tone: 'fail', text: `${sync.bee} is on this job in Bee Hub, but Slack didn’t answer — they may not be in the channel yet. Try again shortly.` }
    default:
      return null
  }
}

export default function BeeSlackStatus({ sync }) {
  const list = (Array.isArray(sync) ? sync : [sync]).map(beeSlackNote).filter(Boolean)
  if (!list.length) return null
  return (
    <div role="status" aria-live="polite" data-bee-bees-slack style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' }}>
      {list.map((note, i) => (
        <p key={i} style={{ margin: 0, fontSize: '13px', lineHeight: 1.4, maxWidth: '52ch', color: note.tone === 'fail' ? T.state.warning.fg : T.ink.muted }}>
          {note.text}
        </p>
      ))}
    </div>
  )
}
