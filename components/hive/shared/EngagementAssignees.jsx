// components/hive/shared/EngagementAssignees.jsx
// ─────────────────────────────────────────────────────────────
// Engagement-level Assigned To — the masthead chip-row + multi-select
// (engagement-assigned-to-multi build). Assignment is now PLURAL and
// lives on the engagement (engagement_assignees junction), replacing the
// old lead-level single AssignedToField.
//
//   chip-row  avatar + name per assignee, quiet ✗ to remove
//   + assign  dashed button → checklist popover of the engagement's
//             LOCATION hub_users (toggle on/off, immediate idempotent
//             junction writes — the TagsRow idiom)
//
// Users with no jobber_user_id are SELECTABLE (a valid internal
// assignment) but MARKED — a muted "no Jobber" note + tooltip — because
// they won't be pushed to Jobber until an owner links them in
// Settings → Team. The badge only shows when the location is connected
// to Jobber (otherwise nobody has a Jobber identity and the nag is noise).
//
//   add    → POST   /api/engagements/:id/assignees { hub_user_id }
//   remove → DELETE /api/engagements/:id/assignees?hub_user_id=…
// Both return the full assignees list → onChange(next). §8.5: props only,
// no context. Token-pure (beta-hive-tokens source sweep).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import { T } from './tokens'
import { MicroLabel, pillStyle } from './cardKit'

const initialsOf = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'

// Stable per-person avatar color from the token chip families (no random,
// no literals) — a light spread so a row of assignees reads as distinct.
const AVATAR_FAMILIES = ['teal', 'blue', 'purple', 'amber', 'green', 'gray']
const familyFor = (id) => {
  const s = String(id || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return T.family[AVATAR_FAMILIES[h % AVATAR_FAMILIES.length]]
}

function MiniAvatar({ id, name }) {
  const fam = familyFor(id)
  return (
    <span aria-hidden style={{
      width: T.avatar.inline, height: T.avatar.inline, borderRadius: T.radius.round, background: fam.bg, color: fam.text,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: T.avatar.inlineFont, fontWeight: 600, flexShrink: 0,
    }}>
      {initialsOf(name)}
    </span>
  )
}

export default function EngagementAssignees({
  engagementId, assignees = [], users = [], jobberConnected = false,
  onChange = () => {}, setToast = () => {}, readOnly = false,
}) {
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const assignedIds = new Set(assignees.map(a => a.hub_user_id))
  const isAssigned = (uid) => assignedIds.has(uid)

  async function toggle(user) {
    const uid = user.id
    if (busyId) return
    const adding = !isAssigned(uid)
    setBusyId(uid)
    try {
      const res = adding
        ? await fetch(`/api/engagements/${engagementId}/assignees`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hub_user_id: uid }),
          })
        : await fetch(`/api/engagements/${engagementId}/assignees?hub_user_id=${encodeURIComponent(uid)}`, { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      onChange(Array.isArray(j.assignees) ? j.assignees : [])
      // Toast-truth: when the location is on Jobber but this person isn't
      // linked, say the assignment is internal-only so it's not a surprise.
      const label = user.name || user.email || 'member'
      const unmappedNote = adding && jobberConnected && !user.jobberUserId
        ? ' — internal only (not linked to Jobber)'
        : ''
      setToast({ kind: 'success', msg: `${adding ? 'Assigned' : 'Unassigned'} ${label}${unmappedNote}` })
    } catch (e) {
      setToast({ kind: 'error', msg: `Assign ${adding ? 'add' : 'remove'} failed: ${e.message}` })
    } finally { setBusyId(null) }
  }

  // Assignee display name — prefer the junction's resolved name, fall
  // back to the roster prop (covers an optimistic state before refetch).
  const nameFor = (a) => a.name || users.find(u => u.id === a.hub_user_id)?.name || a.email || 'Member'
  const jobberIdFor = (a) =>
    a.jobber_user_id ?? users.find(u => u.id === a.hub_user_id)?.jobberUserId ?? null

  return (
    <div>
      <MicroLabel>Assigned to</MicroLabel>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', position: 'relative' }}>
        {assignees.map(a => {
          const unmapped = jobberConnected && !jobberIdFor(a)
          return (
            <span key={a.hub_user_id}
              title={unmapped ? "Won't sync to Jobber until linked (Settings → Team)" : undefined}
              style={pillStyle({ leading: true })}>
              <MiniAvatar id={a.hub_user_id} name={nameFor(a)} />
              {nameFor(a)}
              {unmapped && (
                <span aria-label="Not linked to Jobber" style={{ color: T.state.warning.deep, fontSize: '10px', fontWeight: 600 }}>⚠</span>
              )}
              {!readOnly && (
                <button aria-label={`Unassign ${nameFor(a)}`} disabled={busyId === a.hub_user_id}
                  onClick={() => toggle({ id: a.hub_user_id, name: nameFor(a), email: a.email, jobberUserId: jobberIdFor(a) })}
                  style={{ border: 'none', background: 'transparent', padding: 0, fontSize: '11px', lineHeight: 1, color: T.ink.quiet, cursor: 'pointer', fontFamily: 'inherit' }}>
                  ✗
                </button>
              )}
            </span>
          )
        })}
        {assignees.length === 0 && <span style={{ fontSize: '11px', color: T.ink.quiet }}>Unassigned</span>}
        {!readOnly && (
        <span style={{ position: 'relative', display: 'inline-block' }}>
          <button onClick={() => setOpen(v => !v)} aria-label="Assign a team member"
            style={{ ...pillStyle({ dashed: true }), cursor: 'pointer' }}>
            + Assign
          </button>
          {open && (
            <>
              <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10009 }} />
              <div onClick={e => e.stopPropagation()}
                style={{ position: 'absolute', left: 0, top: 'calc(100% + 6px)', zIndex: 10010, width: '230px', maxHeight: '46vh', overflowY: 'auto', background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.inset, boxShadow: T.shadow.pop, padding: '8px 12px' }}>
                {users.map(u => {
                  const on = isAssigned(u.id)
                  const unmapped = jobberConnected && !u.jobberUserId
                  return (
                    <button key={u.id} disabled={busyId === u.id}
                      onClick={() => toggle(u)}
                      title={unmapped ? "Won't sync to Jobber until linked (Settings → Team)" : undefined}
                      style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', margin: '0 -8px', borderRadius: T.radius.control, border: 'none', background: 'transparent', fontSize: '12px', color: on ? T.ink.primary : T.ink.secondary, fontWeight: on ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                      <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center', color: T.state.success.fg, flexShrink: 0 }}>{on ? '✓' : ''}</span>
                      <MiniAvatar id={u.id} name={u.name} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name || u.email || u.id}</span>
                      {unmapped && (
                        <span style={{ flexShrink: 0, fontSize: '10px', color: T.state.warning.deep, fontWeight: 600 }}>no Jobber</span>
                      )}
                    </button>
                  )
                })}
                {users.length === 0 && (
                  <p style={{ fontSize: '11px', color: T.ink.quiet, padding: '4px 0' }}>No team members at this location</p>
                )}
              </div>
            </>
          )}
        </span>
        )}
      </div>
    </div>
  )
}
