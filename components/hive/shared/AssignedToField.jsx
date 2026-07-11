// components/hive/shared/AssignedToField.jsx
// ─────────────────────────────────────────────────────────────
// Assigned-to picker — ClientProfile left column (card-restore
// build 3; Build 2's row was display-only). Same anatomy family as
// SourceField (value row + standard ✎ → options popover) but options
// are ID-VALUED (hub_users rows), so it carries its own menu instead
// of composing the string-valued MetaSelect.
//
// users: the location's hub_users [{ id, name, email }] — threaded
// from BeeHub's LocationUsersContext through HiveShell as a PROP
// (§8.5: the hive chunk never touches context). Write: PATCH
// /api/leads/:id { assigned_to } (whitelisted; the same column the
// send-to-jobber route reads for salespersonId/assessment assignment —
// assigning here also decides who future Jobber requests go to).
// None clears. onSaved(cols, label) after a confirmed write.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import { IconUserCheck } from '@/components/ui/icons'
import { T } from './tokens'
import { MicroLabel } from './cardKit'
import { EditPencil } from './inlineEdit'

export default function AssignedToField({ leadId, value = null, valueName = null, users = [], onSaved = () => {}, setToast = () => {} }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  async function pick(user) { // null = unassign
    setOpen(false)
    if ((user?.id ?? null) === (value ?? null)) return
    setBusy(true)
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigned_to: user?.id ?? null }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      onSaved({ assigned_to: user?.id ?? null }, user ? (user.name || user.email || user.id) : null)
      setToast({ kind: 'success', msg: user ? `Assigned to ${user.name || user.email}` : 'Unassigned' })
    } catch (e) {
      setToast({ kind: 'error', msg: `Assign failed: ${e.message}` })
    } finally { setBusy(false) }
  }

  const label = valueName || (value ? users.find(u => u.id === value)?.name : null)

  return (
    <div>
      <MicroLabel>Assigned to</MicroLabel>
      <span style={{ position: 'relative', display: 'block' }}>
        <p onClick={() => !busy && setOpen(v => !v)} title="Edit assignee"
          style={{ fontSize: '12px', color: label ? T.ink.primary : T.ink.quiet, display: 'flex', alignItems: 'center', gap: '7px', cursor: 'pointer', minWidth: 0 }}>
          <span style={{ color: T.ink.muted, display: 'inline-flex', flexShrink: 0 }}><IconUserCheck size={13} /></span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label || 'Unassigned'}</span>
          <EditPencil />
        </p>
        {open && (
          <>
            <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 10009 }} />
            <div onClick={e => e.stopPropagation()}
              style={{ position: 'absolute', left: 0, top: 'calc(100% + 6px)', zIndex: 10010, width: '210px', maxHeight: '46vh', overflowY: 'auto', background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.inset, boxShadow: T.shadow.pop, padding: '8px 12px' }}>
              <button onClick={() => pick(null)}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', margin: '0 -8px', borderRadius: T.radius.control, border: 'none', background: 'transparent', fontSize: '12px', color: value == null ? T.ink.primary : T.ink.quiet, fontWeight: value == null ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', fontStyle: 'italic' }}>
                <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center', color: T.state.success.fg, flexShrink: 0 }}>{value == null ? '✓' : ''}</span>
                Unassigned
              </button>
              {users.map(u => (
                <button key={u.id} onClick={() => pick(u)}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', margin: '0 -8px', borderRadius: T.radius.control, border: 'none', background: 'transparent', fontSize: '12px', color: u.id === value ? T.ink.primary : T.ink.secondary, fontWeight: u.id === value ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                  <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center', color: T.state.success.fg, flexShrink: 0 }}>{u.id === value ? '✓' : ''}</span>
                  {u.name || u.email || u.id}
                </button>
              ))}
              {users.length === 0 && (
                <p style={{ fontSize: '11px', color: T.ink.quiet, padding: '4px 0' }}>No team members found</p>
              )}
            </div>
          </>
        )}
      </span>
    </div>
  )
}
