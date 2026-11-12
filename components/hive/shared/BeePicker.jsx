// components/hive/shared/BeePicker.jsx
// ─────────────────────────────────────────────────────────────
// THE bee checklist — one component for the Bees cell's popover AND the
// "Put this job in Slack" dialog (never a second picker). The AssigneeCorner
// checklist idiom: the location's roster, tick on / off, each tick an
// immediate write the parent makes (onToggle), live, no reload.
//
// Bees who can't be synced are still selectable but MARKED where the choice
// is made — AssigneeCorner's "no Jobber" mark, for Slack: a bee whose email
// was checked and matches nobody in this location's Slack reads "not in
// Slack". An unchecked bee carries no mark (we don't know yet).
//
// Inline add (Kevin: "so they don't have to exit again"): a name and an
// email straight into the roster (POST /api/locations/:id/bees — the same
// route and the same Slack email check as Settings › Bees), then the new bee
// is ticked on this job. Shown only to people who manage the roster.
//
// §8.5 props only, no context. Token-pure.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { T } from './tokens'
import MiniAvatar from './MiniAvatar'
import { wizInput } from './CloseWizardKit'

export const notInSlack = (bee, slackConnected) =>
  !!slackConnected && !!bee?.slack_checked_at && !bee?.slack_user_id

export default function BeePicker({
  roster = [],
  assignedIds = [],
  busyId = null,
  onToggle = () => {},
  slackConnected = false,
  canAdd = false,
  locationUuid,
  onAdded = () => {},
}) {
  const on = new Set(assignedIds)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)

  async function add(e) {
    e?.preventDefault?.()
    if (saving) return
    setSaving(true); setMsg(null)
    try {
      const res = await fetch(`/api/locations/${locationUuid}/bees`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.bee) { setMsg({ tone: 'fail', text: j?.message || 'Couldn’t save — try again.' }); return }
      setName(''); setEmail(''); setAdding(false)
      if (j.slackCheck === 'not_found') {
        setMsg({ tone: 'info', text: `Saved. Nobody in your Slack uses ${j.bee.email}, so ${j.bee.name} won’t be added to the channel until that’s fixed.` })
      } else if (j.slackCheck === 'unavailable') {
        setMsg({ tone: 'info', text: 'Saved. Slack didn’t answer, so we couldn’t check their email yet.' })
      }
      await onAdded(j.bee)
    } catch {
      setMsg({ tone: 'fail', text: 'Couldn’t save — try again.' })
    } finally { setSaving(false) }
  }

  return (
    <div data-bee-picker style={{ display: 'flex', flexDirection: 'column' }}>
      {roster.map(b => {
        const ticked = on.has(b.id)
        const marked = notInSlack(b, slackConnected)
        return (
          <button key={b.id} type="button" disabled={busyId === b.id} onClick={() => onToggle(b)}
            aria-pressed={ticked} data-bee-id={b.id}
            title={marked ? `Nobody in your Slack uses ${b.email} — they can be on the job, but won’t be in the channel` : b.email}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', margin: '0 -8px', borderRadius: T.radius.control, border: 'none', background: 'transparent', fontSize: '12px', color: ticked ? T.ink.primary : T.ink.secondary, fontWeight: ticked ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
            <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center', color: T.state.success.fg, flexShrink: 0 }}>{ticked ? '✓' : ''}</span>
            <MiniAvatar id={b.id} name={b.name} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
            {marked && (
              <span data-bee-not-in-slack style={{ flexShrink: 0, fontSize: '10px', color: T.state.warning.deep, fontWeight: 600 }}>not in Slack</span>
            )}
          </button>
        )
      })}
      {roster.length === 0 && !adding && (
        <p style={{ fontSize: '11px', color: T.ink.quiet, padding: '4px 0' }}>No bees at this location yet</p>
      )}

      {canAdd && !adding && (
        <button type="button" data-bee-add-open onClick={() => { setAdding(true); setMsg(null) }}
          style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', margin: '2px -8px 0', borderRadius: T.radius.control, border: 'none', background: 'transparent', fontSize: '12px', color: T.accent.fg, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
          <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>+</span>
          Add a bee who isn’t listed
        </button>
      )}
      {canAdd && adding && (
        <form data-bee-add-form onSubmit={add} style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '6px 0 2px' }}>
          <input aria-label="Bee’s name" placeholder="Name" value={name} onChange={e => setName(e.target.value)} style={wizInput()} />
          <input aria-label="Bee’s email" placeholder="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} style={wizInput()} />
          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => { setAdding(false); setMsg(null) }}
              style={{ border: 'none', background: 'transparent', color: T.ink.muted, fontSize: '12px', fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', padding: '6px 8px' }}>Cancel</button>
            <button type="submit" disabled={saving || !name.trim() || !email.trim()}
              style={{ border: 'none', borderRadius: T.radius.control, background: saving || !name.trim() || !email.trim() ? T.ink.disabled : T.accent.fg, color: T.accent.onFill, fontSize: '12px', fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer', padding: '6px 12px' }}>
              {saving ? 'Adding…' : 'Add to job'}
            </button>
          </div>
        </form>
      )}
      {msg && (
        <p role="status" data-bee-add-msg style={{ fontSize: '11px', lineHeight: 1.4, padding: '4px 0', color: msg.tone === 'fail' ? T.state.warning.fg : T.ink.muted }}>{msg.text}</p>
      )}
    </div>
  )
}
