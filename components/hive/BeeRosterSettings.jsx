// components/hive/BeeRosterSettings.jsx
// ─────────────────────────────────────────────────────────────
// Settings › Bees (Slack job channels, slice 2) — the people who work a
// location's jobs, by name and email. A ROSTER, not logins: nobody here signs
// in to Bee Hub. Slice 3 uses it to put bees in a job's Slack channel.
//   · Add — name + email. The same email twice at one location is refused.
//   · Edit — fix a name or an email (a new email is checked against Slack).
//   · Remove — hides them; nothing is deleted. Bring back restores the same
//     bee, Slack id and all.
//   · Slack — when the location's Slack is connected, each bee says whether
//     their email was found there. Checked on add, on a new email, and on
//     "Check again" — never just by opening this screen. No Slack connected
//     → nothing about Slack shows at all.
// Same look and building blocks as Settings › Tags (OwnTagsSettings).
// §8.5: props only; owns its own fetches.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import { T } from './shared/tokens'

const btn = (tone = 'quiet') => ({
  padding: '5px 10px', borderRadius: T.radius.control, border: T.border.thin,
  background: tone === 'danger' ? T.state.danger.soft : T.surface.raised,
  color: tone === 'danger' ? T.state.danger.fg : T.ink.secondary,
  fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
})

const input = {
  width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: T.radius.control,
  border: T.border.control, fontSize: '13px', fontFamily: 'inherit', color: T.ink.primary, outline: 'none',
}

// The one plain line under a bee when Slack is connected.
export function beeSlackLine(bee) {
  if (bee.slack_user_id) return { kind: 'found', text: 'Found in your Slack' }
  if (bee.slack_checked_at) return {
    kind: 'not_found',
    text: 'Not found in your Slack. Use the email they sign in to Slack with — tap Edit to change it.',
  }
  return { kind: 'unchecked', text: 'Not checked against your Slack yet.' }
}

const UNAVAILABLE = 'Saved. We couldn’t reach Slack to check this email — tap Check again in a minute.'

export default function BeeRosterSettings({ locationId = null, locationName = '' }) {
  const [bees, setBees] = useState(null)     // null = loading
  const [slackConnected, setSlackConnected] = useState(false)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)      // a calm line (Slack unreachable)
  const [draft, setDraft] = useState({ name: '', email: '' })
  const [editing, setEditing] = useState(null) // { id, name, email }
  const [confirming, setConfirming] = useState(null)
  const [busy, setBusy] = useState(null)

  async function load() {
    if (!locationId) { setBees([]); return }
    try {
      const res = await fetch(`/api/locations/${encodeURIComponent(locationId)}/bees`)
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.message || j?.error || `HTTP ${res.status}`)
      setBees(j.bees || [])
      setSlackConnected(j.slackConnected === true)
    } catch (e) {
      setError(`Couldn't load your bees: ${e.message}`); setBees([])
    }
  }
  useEffect(() => { load() }, [locationId]) // eslint-disable-line react-hooks/exhaustive-deps

  function take(j) {
    if (typeof j?.slackConnected === 'boolean') setSlackConnected(j.slackConnected)
    setNote(j?.slackCheck === 'unavailable' ? UNAVAILABLE : null)
    const b = j.bee
    setBees(prev => {
      const list = prev || []
      return list.some(x => x.id === b.id) ? list.map(x => (x.id === b.id ? b : x)) : [...list, b]
    })
  }

  async function send(url, method, body, key) {
    setBusy(key); setError(null); setNote(null)
    try {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) { setError(j?.message || `Couldn't save (${j?.error || res.status}).`); return false }
      take(j)
      return true
    } catch (e) {
      setError(`Couldn't save: ${e.message}`); return false
    } finally { setBusy(null) }
  }

  const base = `/api/locations/${encodeURIComponent(locationId || '')}/bees`
  const add = async () => {
    if (await send(base, 'POST', { name: draft.name, email: draft.email }, 'add')) setDraft({ name: '', email: '' })
  }
  const patch = (bee, body) => send(`${base}/${bee.id}`, 'PATCH', body, bee.id)

  const all = (bees || []).slice().sort((a, b) => a.name.localeCompare(b.name))
  const active = all.filter(b => b.is_active !== false)
  const removed = all.filter(b => b.is_active === false)

  const slackLine = (b) => {
    if (!slackConnected || b.is_active === false) return null
    const l = beeSlackLine(b)
    const color = l.kind === 'found' ? T.state.success.fg : l.kind === 'not_found' ? T.state.warning.fg : T.ink.quiet
    return (
      <p data-bee-slack={l.kind} style={{ fontSize: '11px', color, margin: '2px 0 0' }}>
        {l.kind === 'found' ? '✓ ' : ''}{l.text}
      </p>
    )
  }

  const row = (b, isRemoved) => (
    <div key={b.id} data-bee={b.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderBottom: T.border.thin, background: T.surface.raised, opacity: isRemoved ? 0.7 : 1, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        {editing?.id === b.id ? (
          <div style={{ display: 'grid', gap: '6px' }}>
            <input aria-label={`Name for ${b.name}`} value={editing.name} style={input}
              onChange={e => setEditing({ ...editing, name: e.target.value })} />
            <input aria-label={`Email for ${b.name}`} type="email" value={editing.email} style={input}
              onChange={e => setEditing({ ...editing, email: e.target.value })} />
          </div>
        ) : (
          <>
            <p style={{ fontSize: '13px', fontWeight: 600, color: T.ink.primary, margin: 0 }}>{b.name}</p>
            <p style={{ fontSize: '12px', color: T.ink.secondary, margin: '1px 0 0', wordBreak: 'break-all' }}>{b.email}</p>
            {isRemoved && <p style={{ fontSize: '11px', color: T.ink.quiet, margin: '2px 0 0' }}>Removed</p>}
            {slackLine(b)}
          </>
        )}
      </div>
      {isRemoved ? (
        <button style={btn()} disabled={!!busy} onClick={() => patch(b, { active: true })}>Bring back</button>
      ) : editing?.id === b.id ? (
        <>
          <button style={btn()} disabled={busy === b.id}
            onClick={async () => { if (await patch(b, { name: editing.name, email: editing.email })) setEditing(null) }}>Save</button>
          <button style={btn()} onClick={() => setEditing(null)}>Cancel</button>
        </>
      ) : (
        <>
          {slackConnected && !b.slack_user_id && (
            <button style={btn()} disabled={!!busy} onClick={() => patch(b, { recheck: true })}>Check again</button>
          )}
          <button style={btn()} disabled={!!busy} onClick={() => { setError(null); setEditing({ id: b.id, name: b.name, email: b.email }) }}>Edit</button>
          <button style={btn('danger')} disabled={!!busy} onClick={() => setConfirming(b)}>Remove</button>
        </>
      )}
    </div>
  )

  return (
    <div data-testid="bee-roster-settings" style={{ padding: '16px' }}>
      <p style={{ fontSize: '12px', fontWeight: 700, color: T.ink.muted, textTransform: 'uppercase', letterSpacing: '0.6px', margin: '0 0 2px' }}>
        {locationName ? `${locationName}'s bees` : 'Your bees'}
      </p>
      <p style={{ fontSize: '12px', color: T.ink.quiet, margin: '0 0 12px' }}>
        The people who work your jobs. This is just a list — nobody here gets a Bee Hub login.
        {slackConnected ? ' Use the email each bee signs in to Slack with, so Bee Hub can find them there.' : ''}
      </p>

      {error && (
        <p role="alert" style={{ fontSize: '12px', color: T.state.danger.fg, background: T.state.danger.soft, padding: '8px 10px', borderRadius: T.radius.control, margin: '0 0 10px' }}>{error}</p>
      )}
      {note && (
        <p data-bee-note style={{ fontSize: '12px', color: T.state.warning.fg, background: T.state.warning.soft, padding: '8px 10px', borderRadius: T.radius.control, margin: '0 0 10px' }}>{note}</p>
      )}

      {confirming && (
        <div role="dialog" aria-label={`Remove ${confirming.name}`} style={{ padding: '12px', margin: '0 0 12px', borderRadius: T.radius.inset, border: T.border.thin, background: T.surface.sunken }}>
          <p style={{ fontSize: '13px', color: T.ink.primary, margin: '0 0 8px' }}>
            Remove {confirming.name} from your bees? You can bring them back any time, exactly as they were.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button style={btn('danger')} disabled={busy === confirming.id}
              onClick={async () => { if (await patch(confirming, { active: false })) setConfirming(null) }}>Remove</button>
            <button style={btn()} onClick={() => setConfirming(null)}>Keep them</button>
          </div>
        </div>
      )}

      <form data-bee-add onSubmit={e => { e.preventDefault(); add() }}
        style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', padding: '10px 12px', margin: '0 0 12px', border: T.border.thin, borderRadius: T.radius.inset, background: T.surface.raised }}>
        <input aria-label="Bee name" placeholder="Name" value={draft.name} style={{ ...input, flex: '1 1 140px', width: 'auto' }}
          onChange={e => setDraft({ ...draft, name: e.target.value })} />
        <input aria-label="Bee email" placeholder="Email" type="email" value={draft.email} style={{ ...input, flex: '2 1 200px', width: 'auto' }}
          onChange={e => setDraft({ ...draft, email: e.target.value })} />
        <button type="submit" style={btn()} disabled={busy === 'add' || !draft.name.trim() || !draft.email.trim()}>Add bee</button>
      </form>

      {bees == null && <p style={{ fontSize: '12px', color: T.ink.quiet }}>Loading…</p>}
      {bees != null && active.length === 0 && removed.length === 0 && (
        <p style={{ fontSize: '12px', color: T.ink.quiet }}>No bees on your list yet.</p>
      )}
      {active.length > 0 && (
        <div style={{ border: T.border.thin, borderRadius: T.radius.inset, overflow: 'hidden', marginBottom: '12px' }}>
          {active.map(b => row(b, false))}
        </div>
      )}
      {removed.length > 0 && (
        <>
          <p style={{ fontSize: '11px', fontWeight: 600, color: T.ink.muted, textTransform: 'uppercase', letterSpacing: '0.5px', margin: '8px 0 4px' }}>Removed</p>
          <div style={{ border: T.border.thin, borderRadius: T.radius.inset, overflow: 'hidden' }}>
            {removed.map(b => row(b, true))}
          </div>
        </>
      )}
    </div>
  )
}
