// components/hive/shared/ContactsBlock.jsx
// ─────────────────────────────────────────────────────────────
// Secondary contacts CRUD — ClientProfile left column (card-restore
// build 3; Build 2 shipped display-only rows). Backed by the existing
// routes, shapes verified:
//   POST   /api/lead-contacts            { lead_id, name, role?, phone?, email? } → { contact }
//   PATCH  /api/lead-contacts/:id        { name?, role?, phone?, email? }         → { contact }
//   DELETE /api/lead-contacts/:id                                                 → 200
//
// Inline-edit standard (shared/inlineEdit): view rows wear the standard
// ✎; edit mode is a small stacked form with the green-✓/✗ pair; a
// failed save keeps the form open with the inline error. Role is a
// PICKER (preset select — lead_contacts.role is free text server-side,
// the presets just keep the vocabulary from fraying); phone/email keep
// live tel:/mailto: links in view mode. Remove lives INSIDE edit mode —
// destructive affordances stay one level deep.
//
// Host owns the contacts array: onChange(next) after every confirmed
// write. §8.5: props only, no context.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { IconPhone, IconMail } from '@/components/ui/icons'
import { T } from './tokens'
import { MicroLabel, pillStyle } from './cardKit'
import { EditPencil, InlineEditControls } from './inlineEdit'

const ROLE_PRESETS = ['Spouse', 'Partner', 'Family member', 'Assistant', 'Property manager', 'Tenant', 'Other']

const inputStyle = { padding: '6px 9px', border: T.border.control, borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit', background: T.surface.raised, outline: 'none', minWidth: 0 }

function ContactForm({ initial = null, busy, err, onSave, onCancel, onDelete = null, readOnly = false }) {
  const [draft, setDraft] = useState({
    name: initial?.name || '', role: initial?.role || '',
    phone: initial?.phone || '', email: initial?.email || '',
  })
  const set = (k) => (e) => setDraft(d => ({ ...d, [k]: e.target.value }))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '8px 10px', border: T.border.thin, borderRadius: T.radius.control, background: T.surface.raised }}>
      <div style={{ display: 'flex', gap: '6px' }}>
        <input autoFocus value={draft.name} onChange={set('name')} placeholder="Name" aria-label="Contact name" style={{ ...inputStyle, flex: 1 }} />
        <select value={draft.role} onChange={set('role')} aria-label="Contact role" style={inputStyle}>
          <option value="">Role…</option>
          {ROLE_PRESETS.map(r => <option key={r} value={r}>{r}</option>)}
          {draft.role && !ROLE_PRESETS.includes(draft.role) && <option value={draft.role}>{draft.role}</option>}
        </select>
      </div>
      <input type="tel" value={draft.phone} onChange={set('phone')} placeholder="Phone (optional)" aria-label="Contact phone" style={inputStyle} />
      <input type="email" value={draft.email} onChange={set('email')} placeholder="Email (optional)" aria-label="Contact email" style={inputStyle} />
      {err && <p style={{ fontSize: '11px', color: T.state.danger.fg }}>{err}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <InlineEditControls busy={busy} onSave={() => onSave(draft)} onCancel={onCancel} />
        {onDelete && !readOnly && (
          <button disabled={busy} onClick={onDelete}
            style={{ marginLeft: 'auto', border: 'none', background: 'transparent', fontSize: '11px', color: T.state.danger.fg, cursor: 'pointer', fontFamily: 'inherit', padding: '2px 4px' }}>
            Remove contact
          </button>
        )}
      </div>
    </div>
  )
}

export default function ContactsBlock({ leadId, contacts = [], onChange = () => {}, setToast = () => {}, readOnly = false }) {
  const [editingId, setEditingId] = useState(null) // contact id | 'new' | null
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const close = () => { setEditingId(null); setErr(null) }

  async function save(draft, existing = null) {
    if (!draft.name.trim()) { setErr('Name is required'); return }
    setBusy(true); setErr(null)
    try {
      const res = existing
        ? await fetch(`/api/lead-contacts/${existing.id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: draft.name, role: draft.role || null, phone: draft.phone || null, email: draft.email || null }),
          })
        : await fetch('/api/lead-contacts', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lead_id: leadId, name: draft.name, role: draft.role || null, phone: draft.phone || null, email: draft.email || null }),
          })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      const saved = j.contact
      onChange(existing
        ? contacts.map(ct => (ct.id === existing.id ? saved : ct))
        : [...contacts, saved])
      close()
      setToast({ kind: 'success', msg: existing ? 'Contact updated' : 'Contact added' })
    } catch (e) {
      setErr(`Save failed: ${e.message}`) // form stays open, draft intact
    } finally { setBusy(false) }
  }

  async function remove(contact) {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/lead-contacts/${contact.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      onChange(contacts.filter(ct => ct.id !== contact.id))
      close()
      setToast({ kind: 'success', msg: 'Contact removed' })
    } catch (e) {
      setErr(`Remove failed: ${e.message}`)
    } finally { setBusy(false) }
  }

  return (
    <div>
      <MicroLabel>Contacts{contacts.length ? ` · ${contacts.length}` : ''}</MicroLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {contacts.map(ct => (editingId === ct.id && !readOnly) ? (
          <ContactForm key={ct.id} initial={ct} busy={busy} err={err}
            onSave={(d) => save(d, ct)} onCancel={close} onDelete={() => remove(ct)} readOnly={readOnly} />
        ) : (
          <div key={ct.id} onClick={readOnly ? undefined : () => { setErr(null); setEditingId(ct.id) }} title={readOnly ? undefined : 'Edit contact'}
            style={{ fontSize: '12px', color: T.ink.primary, cursor: readOnly ? 'default' : 'pointer' }}>
            <p style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ct.name}{ct.role ? <span style={{ color: T.ink.muted }}> · {ct.role}</span> : null}
              </span>
              {!readOnly && <EditPencil />}
            </p>
            <p style={{ display: 'flex', gap: '10px', marginTop: '1px' }}>
              {ct.phone && (
                <a className="bee-contact-link" href={`tel:${ct.phone}`} onClick={e => e.stopPropagation()}
                  style={{ color: T.accent.fg, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px' }}>
                  <IconPhone size={11} /> {ct.phone}
                </a>
              )}
              {ct.email && (
                <a className="bee-contact-link" href={`mailto:${ct.email}`} onClick={e => e.stopPropagation()}
                  style={{ color: T.accent.fg, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <IconMail size={11} /> {ct.email}
                </a>
              )}
            </p>
          </div>
        ))}
        {editingId === 'new' && !readOnly ? (
          <ContactForm busy={busy} err={err} onSave={(d) => save(d)} onCancel={close} />
        ) : readOnly ? null : (
          <button onClick={() => { setErr(null); setEditingId('new') }}
            style={{ ...pillStyle({ dashed: true }), alignSelf: 'flex-start', cursor: 'pointer' }}>
            + Add contact
          </button>
        )}
      </div>
    </div>
  )
}
