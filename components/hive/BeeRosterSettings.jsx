// components/hive/BeeRosterSettings.jsx
// ─────────────────────────────────────────────────────────────
// The Bees section of Settings › Team and Seats — the people who work a
// location's jobs, by name and email. A ROSTER, not logins: nobody here signs
// in to Bee Hub and nobody is billed. It sits BELOW Seats on that screen and
// says so in its first line, because that difference is the whole point of
// having two lists.
//   · Add — "Add a bee" opens a labelled form. The same email twice at one
//     location is refused.
//   · Edit — fix a name or an email (a new email is checked against Slack).
//   · Remove — hides them; nothing is deleted. Bring back restores the same
//     bee, Slack id and all. Removed bees sit behind a disclosure.
//   · Slack — when the location's Slack is connected, each bee carries ONE
//     chip: In your Slack / Not in Slack / Not checked. The explanation
//     appears once, under the row that needs it, with its Check button
//     beside it. Checked on add, on a new email, and on that button — never
//     just by opening this screen. No Slack connected → not a word about
//     Slack, anywhere.
// Token-pure (shared/tokens). §8.5: props only; owns its own fetches.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import { T } from './shared/tokens'

// ── What a bee's Slack state reads as ─────────────────────────
// chip: the short state on the row. text: the one explanation under the row
// (null when there is nothing to explain). action: its button's label.
export function beeSlackLine(bee) {
  if (bee.slack_user_id) return { kind: 'found', chip: 'In your Slack', text: null, action: null }
  if (bee.slack_checked_at) return {
    kind: 'not_found',
    chip: 'Not in Slack',
    text: 'That email isn’t in your Slack. Use the one they sign in to Slack with.',
    action: 'Check again',
  }
  return { kind: 'unchecked', chip: 'Not checked', text: 'Not checked against your Slack yet.', action: 'Check now' }
}

const UNAVAILABLE = 'Saved. We couldn’t reach Slack to check this email — tap Check again in a minute.'

export const beeInitials = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] || '' : '')).toUpperCase()
}

const CHIP = {
  found: T.family.teal,
  not_found: T.family.amber,
  unchecked: T.family.quiet,
}

const primaryBtn = (off) => ({
  minHeight: '44px', padding: '0 18px', borderRadius: T.radius.inset, border: 0,
  background: off ? T.ink.disabled : T.accent.fg, color: T.accent.onFill,
  fontSize: '14px', fontWeight: 600, fontFamily: 'inherit', cursor: off ? 'default' : 'pointer', whiteSpace: 'nowrap',
})
const quietBtn = (h = '44px') => ({
  minHeight: h, padding: h === '44px' ? '0 16px' : '0 14px', borderRadius: h === '44px' ? T.radius.inset : T.radius.control,
  border: T.border.control, background: T.surface.raised, color: T.ink.primary,
  fontSize: h === '44px' ? '14px' : '13px', fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
})
const iconBtn = {
  minHeight: '36px', minWidth: '36px', display: 'grid', placeItems: 'center', borderRadius: T.radius.control,
  border: 0, background: 'transparent', cursor: 'pointer', padding: '0 6px',
}
const field = {
  width: '100%', boxSizing: 'border-box', minHeight: '44px', padding: '0 12px', borderRadius: T.radius.control,
  border: T.border.control, fontSize: '14px', fontFamily: 'inherit', color: T.ink.primary, background: T.surface.raised,
}
const fieldLabel = { display: 'block', fontSize: '13px', fontWeight: 600, color: T.ink.primary, marginBottom: '5px' }
const listBox = { border: T.border.card, borderRadius: T.radius.inset, overflow: 'hidden', background: T.surface.raised }

const Icon = ({ stroke, children }) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)

function Avatar({ name, size = '36px', font = '13px', quiet = false }) {
  return (
    <span aria-hidden="true" style={{
      flex: '0 0 auto', width: size, height: size, borderRadius: T.radius.round,
      background: quiet ? T.family.quiet.bg : T.brand.goldSoft, color: quiet ? T.family.quiet.text : T.brand.goldText,
      display: 'grid', placeItems: 'center', fontSize: font, fontWeight: 600,
    }}>{beeInitials(name)}</span>
  )
}

export default function BeeRosterSettings({ locationId = null }) {
  const [bees, setBees] = useState(null)     // null = loading
  const [slackConnected, setSlackConnected] = useState(false)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)      // a calm line (Slack unreachable)
  const [adding, setAdding] = useState(false)
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
    if (await send(base, 'POST', { name: draft.name, email: draft.email }, 'add')) {
      setDraft({ name: '', email: '' }); setAdding(false)
    }
  }
  const patch = (bee, body) => send(`${base}/${bee.id}`, 'PATCH', body, bee.id)

  const all = (bees || []).slice().sort((a, b) => a.name.localeCompare(b.name))
  const active = all.filter(b => b.is_active !== false)
  const removed = all.filter(b => b.is_active === false)
  const emailLabel = slackConnected ? 'Email they use for Slack' : 'Email'
  const draftReady = draft.name.trim() && draft.email.trim()

  const activeRow = (b, i) => {
    const slack = slackConnected ? beeSlackLine(b) : null
    const isEditing = editing?.id === b.id
    const isConfirming = confirming?.id === b.id
    return (
      <div key={b.id} data-bee={b.id} style={{ borderTop: i ? T.border.divider : 'none', background: T.surface.raised }}>
        {isEditing ? (
          <form data-bee-edit onSubmit={async e => { e.preventDefault(); if (await patch(b, { name: editing.name, email: editing.email })) setEditing(null) }}
            style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              <label style={{ flex: '1 1 200px', minWidth: 0 }}>
                <span style={fieldLabel}>Name</span>
                <input aria-label={`Name for ${b.name}`} value={editing.name} style={field}
                  onChange={e => setEditing({ ...editing, name: e.target.value })} />
              </label>
              <label style={{ flex: '1.4 1 260px', minWidth: 0 }}>
                <span style={fieldLabel}>{emailLabel}</span>
                <input aria-label={`Email for ${b.name}`} type="email" value={editing.email} style={field}
                  onChange={e => setEditing({ ...editing, email: e.target.value })} />
              </label>
            </div>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
              <button type="submit" style={primaryBtn(busy === b.id)} disabled={busy === b.id}>Save</button>
              <button type="button" style={quietBtn()} onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px', flexWrap: 'wrap' }}>
            <Avatar name={b.name} />
            <span style={{ flex: '1 1 160px', minWidth: 0 }}>
              <span data-bee-name style={{ display: 'block', fontSize: '15px', fontWeight: 600, color: T.ink.primary }}>{b.name}</span>
              <span data-bee-email style={{ display: 'block', fontSize: '13px', color: T.ink.muted, marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.email}</span>
            </span>
            {slack && (
              <span data-bee-slack={slack.kind} style={{
                flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', fontSize: '12px', fontWeight: 600,
                padding: '4px 10px', borderRadius: T.radius.pill, background: CHIP[slack.kind].bg, color: CHIP[slack.kind].text,
              }}>{slack.chip}</span>
            )}
            <span style={{ flex: '0 0 auto', display: 'flex', gap: '4px' }}>
              <button type="button" aria-label={`Edit ${b.name}`} title="Edit" style={iconBtn} disabled={!!busy}
                onClick={() => { setError(null); setConfirming(null); setEditing({ id: b.id, name: b.name, email: b.email }) }}>
                <Icon stroke={T.ink.muted}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon>
              </button>
              <button type="button" aria-label={`Remove ${b.name}`} title="Remove" style={iconBtn} disabled={!!busy}
                onClick={() => { setError(null); setConfirming(b) }}>
                <Icon stroke={T.state.danger.fg}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /></Icon>
              </button>
            </span>
          </div>
        )}

        {!isEditing && slack?.text && !isConfirming && (
          <div style={{ padding: '0 16px 14px 66px' }}>
            <div data-bee-slack-note={slack.kind} style={{
              display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', borderRadius: T.radius.control, padding: '9px 12px',
              background: slack.kind === 'not_found' ? T.state.warning.bg : T.surface.sunken,
              border: `1px solid ${slack.kind === 'not_found' ? T.state.warning.soft : T.hairline.line}`,
            }}>
              <span style={{ fontSize: '13px', lineHeight: 1.5, flex: '1 1 220px', minWidth: 0, color: slack.kind === 'not_found' ? T.state.warning.deep : T.ink.muted }}>{slack.text}</span>
              <button type="button" data-bee-recheck style={{ ...quietBtn('36px'), fontWeight: 600 }} disabled={!!busy}
                onClick={() => patch(b, { recheck: true })}>{busy === b.id ? 'Checking…' : slack.action}</button>
            </div>
          </div>
        )}

        {isConfirming && (
          <div role="dialog" aria-label={`Remove ${b.name}`} style={{ padding: '0 16px 14px 66px' }}>
            <div style={{ borderRadius: T.radius.control, padding: '12px', background: T.surface.sunken, border: T.border.card }}>
              <p style={{ fontSize: '14px', lineHeight: 1.5, color: T.ink.primary, margin: '0 0 10px' }}>
                Remove {b.name} from your bees? You can bring them back any time, exactly as they were.
              </p>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <button type="button" disabled={busy === b.id}
                  style={{ ...quietBtn('36px'), fontWeight: 600, color: T.state.danger.fg, background: T.state.danger.soft }}
                  onClick={async () => { if (await patch(b, { active: false })) setConfirming(null) }}>Remove</button>
                <button type="button" style={quietBtn('36px')} onClick={() => setConfirming(null)}>Keep them</button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <section data-testid="bee-roster-settings" data-team-bees aria-labelledby="team-bees-title" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 300px', minWidth: 0 }}>
          <h2 id="team-bees-title" style={{ margin: 0, fontSize: '17px', fontWeight: 600, color: T.ink.primary }}>Bees</h2>
          <p data-bee-intro style={{ margin: '3px 0 0', fontSize: '13px', lineHeight: 1.55, color: T.ink.muted, maxWidth: '560px' }}>
            The people who work your jobs. <strong style={{ fontWeight: 600, color: T.ink.primary }}>Not seats</strong> — nobody here signs in to Bee Hub and nobody is billed.
            {slackConnected ? ' Use the email each bee signs in to Slack with, so Bee Hub can find them there.' : ''}
          </p>
        </div>
        <button type="button" data-bee-add-open style={primaryBtn(false)} aria-expanded={adding}
          onClick={() => { setError(null); setAdding(v => !v) }}>Add a bee</button>
      </div>

      {error && (
        <p role="alert" style={{ fontSize: '13px', lineHeight: 1.5, color: T.state.danger.fg, background: T.state.danger.soft, padding: '9px 12px', borderRadius: T.radius.control, margin: 0 }}>{error}</p>
      )}
      {note && (
        <p data-bee-note style={{ fontSize: '13px', lineHeight: 1.5, color: T.state.warning.deep, background: T.state.warning.bg, padding: '9px 12px', borderRadius: T.radius.control, margin: 0 }}>{note}</p>
      )}

      {adding && (
        <form data-bee-add onSubmit={e => { e.preventDefault(); if (draftReady) add() }}
          style={{ border: `1px solid ${T.accent.fg}`, borderRadius: T.radius.inset, padding: '16px', background: T.accent.faint, display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <label style={{ flex: '1 1 200px', minWidth: 0 }}>
              <span style={fieldLabel}>Name</span>
              <input aria-label="Bee name" autoFocus value={draft.name} style={field}
                onChange={e => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label style={{ flex: '1.4 1 260px', minWidth: 0 }}>
              <span style={fieldLabel}>{emailLabel}</span>
              <input aria-label="Bee email" type="email" value={draft.email} style={field}
                onChange={e => setDraft({ ...draft, email: e.target.value })} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <button type="submit" style={primaryBtn(busy === 'add' || !draftReady)} disabled={busy === 'add' || !draftReady}>
              {busy === 'add' ? 'Adding…' : 'Add bee'}
            </button>
            <button type="button" style={quietBtn()} onClick={() => { setAdding(false); setDraft({ name: '', email: '' }); setError(null) }}>Cancel</button>
          </div>
        </form>
      )}

      {bees == null && <p style={{ fontSize: '13px', color: T.ink.quiet, margin: 0 }}>Loading…</p>}
      {bees != null && active.length === 0 && (
        <p data-bee-empty style={{ fontSize: '13px', color: T.ink.quiet, margin: 0 }}>
          {removed.length ? 'No bees on your list right now.' : 'No bees on your list yet.'}
        </p>
      )}
      {active.length > 0 && <div style={listBox}>{active.map(activeRow)}</div>}

      {removed.length > 0 && (
        <details data-bee-removed style={{ border: T.border.card, borderRadius: T.radius.inset, background: T.surface.sunken }}>
          <summary style={{ cursor: 'pointer', padding: '12px 16px', fontSize: '13px', fontWeight: 600, color: T.ink.muted }}>
            Removed bees ({removed.length})
          </summary>
          <div style={{ padding: '0 16px 6px' }}>
            {removed.map(b => (
              <div key={b.id} data-bee={b.id} style={{ display: 'flex', alignItems: 'center', gap: '14px', padding: '10px 0', flexWrap: 'wrap' }}>
                <Avatar name={b.name} size="32px" font="12px" quiet />
                <span style={{ flex: '1 1 160px', minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: '14px', fontWeight: 600, color: T.ink.muted }}>{b.name}</span>
                  <span style={{ display: 'block', fontSize: '12px', color: T.ink.quiet, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.email}</span>
                </span>
                <button type="button" style={quietBtn('36px')} disabled={!!busy} onClick={() => patch(b, { active: true })}>Bring back</button>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  )
}
