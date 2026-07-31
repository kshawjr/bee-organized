// components/hive/shared/AssigneeCorner.jsx
// ─────────────────────────────────────────────────────────────
// The in-record ASSIGNEE CORNER — the small avatar cluster that sits in
// the TOP-RIGHT of an open record (ClientProfile lead card, EngagementPanel
// deal card) and is the click-to-assign affordance. Kevin 7/24: assignee is
// identity, so the corner shows FACES ONLY — no "Assigned to" label, no
// names inline. The full name rides each avatar's hover title (with no
// visible label, hover is the only way to read who), and the whole set is
// the wrapper title so the "+N" overflow is legible too.
//
// One idiom, both records:
//   · avatars   MiniAvatar (b71fdca) at T.avatar.corner — the SAME disc the
//               inbox row and the card stacks draw, one step down from the
//               32px identity disc so it reads as chrome, not the subject.
//   · unassigned a dashed GHOST disc with a + — a visible "click to assign"
//               affordance, never a blank corner.
//   · click     opens a multi-select checklist popover of the record's
//               LOCATION hub_users (toggle on/off, immediate write, live
//               update — no reload). lead_assignees / engagement_assignees
//               are both PLURAL, so the picker is multi.
//
// The two records write through DIFFERENT routes, so the write is a MODE:
//   · mode='put'    → PUT  {endpoint} { hub_user_ids: [...] }   (leads —
//                     the set-based lead_assignees route; the whole new set
//                     is sent each toggle. Does NOT push to Jobber by design,
//                     so no unmapped-to-Jobber nag here.)
//   · mode='toggle' → POST {endpoint} { hub_user_id }  /  DELETE
//                     {endpoint}?hub_user_id=…              (engagements —
//                     the per-user idempotent engagement_assignees route,
//                     which also drives the Jobber crew sync. When the
//                     location is on Jobber, unmapped users are selectable
//                     but marked in the picker — the EngagementAssignees
//                     idiom, kept where the choice is made.)
// Both routes return { assignees: [...] } (names resolved server-side, so the
// corner never depends on the location roster to LABEL a current assignee —
// the roster-resolution "?" (#56) can't bite a corner that has no name to
// fall back to). onChange lifts the fresh list to the parent.
//
// §8.5 props only, no context. Token-pure (beta-hive-tokens source sweep).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import { T } from './tokens'
import MiniAvatar from './MiniAvatar'

const MAX_FACES = 3

export default function AssigneeCorner({
  assignees = [],
  users = [],
  endpoint,
  mode = 'put',
  jobberConnected = false,
  onChange = () => {},
  onJobberSync = () => {},
  setToast = () => {},
  readOnly = false,
  size = T.avatar.corner,
  font = T.avatar.cornerFont,
  align = 'right',
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

  // Prefer the junction's resolved name, fall back to the roster prop (covers
  // the moment before a refetch), then email. A missing name → MiniAvatar's
  // own '?' — but the GET route resolves names, so a current assignee arrives
  // labelled regardless of the roster.
  const nameOf = (a) => a.name || users.find(u => u.id === a.hub_user_id)?.name || a.email || 'Member'
  const jobberIdOf = (a) =>
    a.jobber_user_id ?? users.find(u => u.id === a.hub_user_id)?.jobberUserId ?? null

  async function toggle(user) {
    const uid = user.id
    if (busyId) return
    const adding = !isAssigned(uid)
    setBusyId(uid)
    try {
      let res
      if (mode === 'put') {
        // Set-based (leads): compute the new full set, order-stable, and send
        // it whole. The route de-dupes and keeps leads.assigned_to in step.
        const nextIds = adding
          ? [...assignees.map(a => a.hub_user_id), uid]
          : assignees.map(a => a.hub_user_id).filter(id => id !== uid)
        res = await fetch(endpoint, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hub_user_ids: nextIds }),
        })
      } else {
        // Per-user idempotent (engagements): the route recomputes + returns
        // the whole list and drives the Jobber crew sync.
        res = adding
          ? await fetch(endpoint, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ hub_user_id: uid }),
            })
          : await fetch(`${endpoint}?hub_user_id=${encodeURIComponent(uid)}`, { method: 'DELETE' })
      }
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      onChange(Array.isArray(j.assignees) ? j.assignees : [])
      // issue 148 — lift the Jobber-sync outcome so the parent can surface a
      // status line under the picker. Only the engagement (toggle) route
      // drives a Jobber crew push and returns jobber_sync; the leads (put)
      // route never does, so clear it there. null = latest attempt had
      // nothing to say (silent).
      onJobberSync(mode === 'toggle' ? (j.jobber_sync ?? null) : null)
      const label = user.name || user.email || 'member'
      // Only the Jobber-driven engagement route earns the internal-only note.
      const unmappedNote = mode === 'toggle' && adding && jobberConnected && !user.jobberUserId
        ? ' — internal only (not linked to Jobber)'
        : ''
      setToast({ kind: 'success', msg: `${adding ? 'Assigned' : 'Unassigned'} ${label}${unmappedNote}` })
    } catch (e) {
      // The write itself failed — Jobber was never reached with a new set, so
      // drop any stale sync note (issue 148); the error toast owns this case.
      onJobberSync(null)
      setToast({ kind: 'error', msg: `Assign ${adding ? 'add' : 'remove'} failed: ${e.message}` })
    } finally { setBusyId(null) }
  }

  const n = assignees.length
  const allNames = assignees.map(nameOf).join(', ')

  // The face cluster (or the ghost). aria-hidden discs; the button below owns
  // the accessible name.
  const cluster = n === 0 ? (
    <span aria-hidden style={{
      width: size, height: size, borderRadius: T.radius.round,
      border: `1px dashed ${T.hairline.control}`, color: T.ink.faint,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: `calc(${size} * 0.6)`, fontWeight: 400, lineHeight: 1, flexShrink: 0,
    }}>+</span>
  ) : (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {assignees.slice(0, MAX_FACES).map((a, i) => (
        <span key={a.hub_user_id} style={{ display: 'inline-flex', marginLeft: i ? '-8px' : 0 }}>
          <MiniAvatar id={a.hub_user_id} name={nameOf(a)} title={nameOf(a)} size={size} font={font} ring />
        </span>
      ))}
      {n > MAX_FACES && (
        <span style={{ marginLeft: '4px', fontSize: '11px', color: T.ink.muted }}>+{n - MAX_FACES}</span>
      )}
    </span>
  )

  // Read-only: display only, no picker. A ghost still reads "unassigned"
  // honestly; it just doesn't invite a click.
  if (readOnly) {
    return (
      <span title={n === 0 ? 'Unassigned' : allNames}
        style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
        {cluster}
      </span>
    )
  }

  const triggerLabel = n === 0 ? 'Assign a team member' : `Assigned to ${allNames} — edit assignment`

  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <button type="button" onClick={() => setOpen(v => !v)}
        aria-label={triggerLabel} aria-haspopup="true" aria-expanded={open}
        title={n === 0 ? 'Assign' : allNames}
        style={{
          display: 'inline-flex', alignItems: 'center', border: 'none', background: 'transparent',
          padding: '4px', borderRadius: T.radius.pill, cursor: 'pointer', fontFamily: 'inherit',
        }}>
        {cluster}
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10009 }} />
          <div onClick={e => e.stopPropagation()}
            style={{
              position: 'absolute', [align]: 0, top: 'calc(100% + 6px)', zIndex: 10010,
              width: '230px', maxHeight: '46vh', overflowY: 'auto',
              background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.inset,
              boxShadow: T.shadow.pop, padding: '8px 12px',
            }}>
            {users.map(u => {
              const on = isAssigned(u.id)
              const unmapped = mode === 'toggle' && jobberConnected && !u.jobberUserId
              return (
                <button key={u.id} type="button" disabled={busyId === u.id}
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
  )
}
