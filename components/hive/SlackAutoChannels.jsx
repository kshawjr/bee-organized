// components/hive/SlackAutoChannels.jsx
// ─────────────────────────────────────────────────────────────
// The switch on Settings › Slack: "Make a Slack channel for every new job"
// (2026-11-12, Jobber crew → Slack, slice 3 of 3). Mounted inside the Slack
// card, under the reconnect box. The rules live on the server
// (lib/job-channel-auto.ts); this only shows them and asks.
//
// WHAT IT SHOWS
//   · nothing        until the answer arrives, before the migration has run,
//                    and where Slack is not connected at all (the card is
//                    then about connecting, and a dead switch is noise).
//   · greyed, off    connected but not reconnected for job channels — with
//                    the reason. The server refuses there too.
//   · off            the default. Says how a channel is made by hand.
//   · on             since when, what it does, what it leaves alone, and
//                    the daily ceiling.
//   · on, paused     the ceiling was reached in the last 24 hours: says so,
//                    and what to do for the jobs it skipped.
//   · cannot change  a manager sees the state, greyed, and who can change it.
//
// OFF BY DEFAULT and nothing here turns it on without a tap. Turning it on
// makes no channel: only jobs created in Jobber afterwards get one.
//
// §8.5 props only, no context. Token-pure.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import { T } from './shared/tokens'

export const AUTO_LABEL = 'Make a Slack channel for every new job'
export const AUTO_OFF_LINE = 'Off. You make a job’s channel yourself, with the Slack mark on the job.'
export const AUTO_NEEDS_RECONNECT = 'Reconnect Slack first. Until then Bee Hub can’t make channels for this location.'
export const AUTO_OWNER_ONLY = 'Only the location’s owner can change this.'
export const autoOnLine = (cap) => `Each job created in Jobber after that gets its own channel, and people are added as you put them on its visits. Jobs you already had are left alone. Bee Hub makes at most ${cap} a day.`
export const autoCappedLine = (cap) => `Paused: ${cap} channels were made in 24 hours, the most Bee Hub makes on its own. Jobs created since then have no channel. To give one a channel, open the job and tap the Slack mark. It starts again by itself within 24 hours.`

export function sinceLabel(iso) {
  const d = iso ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export default function SlackAutoChannels({ locationId }) {
  const [state, setState] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let dead = false
    setState(null); setError(null)
    if (!locationId) return undefined
    fetch(`/api/locations/${locationId}/slack-auto-channels`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (!dead) setState(j) })
      .catch(() => { if (!dead) setState(null) })
    return () => { dead = true }
  }, [locationId])

  if (!state || !state.setUp || !state.connected) return null

  const { on, since, capped, cap, reconnected, canSet } = state
  // Turning OFF is always allowed to someone who may set it; turning ON
  // needs a reconnected Slack.
  const disabled = saving || !canSet || (!on && !reconnected)

  async function flip() {
    if (disabled) return
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/slack-auto-channels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !on }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.setUp) throw new Error(j?.message || 'That didn’t save. Try again.')
      setState(j)
    } catch (e) {
      setError(e.message)
    } finally { setSaving(false) }
  }

  const reason = !canSet ? AUTO_OWNER_ONLY : (!on && !reconnected ? AUTO_NEEDS_RECONNECT : null)
  const when = sinceLabel(since)

  return (
    <div data-slack-auto style={{ marginTop: '12px', paddingTop: '12px', borderTop: T.border.thin, textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <p id="slack-auto-label" style={{ flex: 1, minWidth: 0, margin: 0, fontSize: '13px', fontWeight: 600, lineHeight: 1.35, color: reason ? T.ink.muted : T.ink.primary }}>
          {AUTO_LABEL}
        </p>
        <button type="button" role="switch" data-slack-auto-switch aria-checked={on} aria-labelledby="slack-auto-label"
          aria-describedby="slack-auto-help" disabled={disabled} onClick={flip}
          style={{
            flexShrink: 0, width: '38px', height: '22px', minHeight: 0, padding: 0, borderRadius: T.radius.pill, border: 'none', position: 'relative',
            background: on ? T.accent.fg : T.hairline.control, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
          }}>
          <span aria-hidden style={{ position: 'absolute', top: '2px', left: on ? '18px' : '2px', width: '18px', height: '18px', borderRadius: T.radius.round, background: T.surface.raised }} />
        </button>
      </div>
      <div id="slack-auto-help">
        {reason && (
          <p data-slack-auto-reason style={{ margin: '6px 0 0', fontSize: '12px', lineHeight: 1.45, color: T.ink.secondary }}>{reason}</p>
        )}
        {!on && !reason && (
          <p data-slack-auto-off style={{ margin: '6px 0 0', fontSize: '12px', lineHeight: 1.45, color: T.ink.muted }}>{AUTO_OFF_LINE}</p>
        )}
        {on && (
          <p data-slack-auto-on style={{ margin: '6px 0 0', fontSize: '12px', lineHeight: 1.45, color: T.ink.secondary }}>
            {when ? <><strong style={{ fontWeight: 600, color: T.ink.primary }}>On since {when}.</strong>{' '}</> : null}{autoOnLine(cap)}
          </p>
        )}
        {on && capped && (
          <p data-slack-auto-capped role="status" style={{ margin: '8px 0 0', padding: '8px 10px', borderRadius: T.radius.inset, background: T.state.warning.bg, fontSize: '12px', fontWeight: 500, lineHeight: 1.45, color: T.state.warning.deep }}>
            {autoCappedLine(cap)}
          </p>
        )}
        {error && (
          <p data-slack-auto-error role="alert" style={{ margin: '6px 0 0', fontSize: '12px', fontWeight: 500, lineHeight: 1.45, color: T.state.warning.deep }}>{error}</p>
        )}
      </div>
    </div>
  )
}
