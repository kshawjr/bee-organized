// components/hive/shared/ContactField.jsx
// ─────────────────────────────────────────────────────────────
// THE editable contact row (phone/email) — one implementation, two
// mounts: ClientProfile Key Facts + EngagementPanel Key Facts. Quiet
// system per the locked design language: inline edit (no modal),
// hairline input, Enter/blur saves, Esc cancels. Affordances follow
// the shared inline-edit standard (shared/inlineEdit.jsx, Kevin 7/10):
// always-visible readable ✎ in view mode; edit mode gains the trailing
// green-✓ / muted-✗ pair (visible path — the shortcuts still work);
// in-flight disables the pair, failure keeps the edit open with the
// inline error.
//
// The VALUE stays a live tel:/mailto: anchor (stopPropagation) —
// clicking the number still calls; clicking anywhere else on the row
// (or the ✎) opens the input. Empty state ('add phone'/'add email')
// is the same input.
//
// Validation before save (quiet inline error, no PATCH on junk):
// email regex, phone ≥7 digits. Normalization stays consistent with
// the server's diffContactPatch (same lib module — single source of
// truth), so a formatting-only reformat saves the display string but
// can never fire a Jobber mutation server-side.
//
// Save path: PATCH /api/leads/:id { phone|email } — the 041e75c
// auto-sync trigger fires server-side and the response carries
// contact_writeback. The toast tells the WHOLE truth:
//   'Phone updated · synced to Jobber'                      (updated/added)
//   'Phone updated'                                          (not linked /
//                                                             already in Jobber)
//   'Phone updated · Jobber sync failed — saved in Bee Hub only'
// Clearing is allowed ('Phone removed') — Bee Hub only; the write-back
// never deletes Jobber-side data by design.
//
// onSaved(cols, responseJson) fires after a confirmed save — hosts
// merge cols into their local state AND hand them up through
// onLeadPatched for the people-context propagation (board/list/inbox
// reflect the change without a reload).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useRef } from 'react'
import { IconPhone, IconMail } from '@/components/ui/icons'
import { T } from './tokens'
import { EditPencil, InlineEditControls } from './inlineEdit'
import { metaRowStyle, metaIconStyle, metaValueStyle, metaAddStyle, META_ICON } from './metaRow'
import { normalizePhoneDigits } from '@/lib/jobber-contact-writeback'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const FIELD = {
  phone: {
    Icon: IconPhone, label: 'Phone', empty: 'add phone', type: 'tel',
    placeholder: '(561) 555-0100', href: (v) => `tel:${v}`,
    invalid: 'Enter a valid phone (7+ digits)',
    ok: (v) => normalizePhoneDigits(v).length >= 7,
  },
  email: {
    Icon: IconMail, label: 'Email', empty: 'add email', type: 'email',
    placeholder: 'name@example.com', href: (v) => `mailto:${v}`,
    invalid: 'Enter a valid email',
    ok: (v) => EMAIL_RE.test(v),
  },
}

export default function ContactField({ kind, leadId, value, onSaved = () => {}, setToast = () => {}, readOnly = false }) {
  const f = FIELD[kind]
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  // Refs, not state: Esc-then-blur and Enter-then-blur both arrive
  // before the state update lands — the guards must be synchronous.
  const cancelled = useRef(false)
  const saving = useRef(false)

  const open = () => { setDraft(value || ''); setErr(null); cancelled.current = false; setEditing(true) }
  const cancel = () => { cancelled.current = true; setErr(null); setEditing(false) }

  async function save() {
    if (cancelled.current || saving.current) return
    const next = draft.trim()
    const prev = (value || '').trim()
    if (next === prev) { setEditing(false); setErr(null); return }
    if (next && !f.ok(next)) { setErr(f.invalid); return } // stay editing — quiet error, no junk PATCH
    saving.current = true
    setBusy(true)
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [kind]: next }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      setEditing(false)
      onSaved({ [kind]: next }, j)
      // The whole truth from the response — the auto-sync outcome rides
      // contact_writeback; absent means not linked or nothing to push.
      const verb = !prev ? 'added' : !next ? 'removed' : 'updated'
      const outcome = j?.contact_writeback?.[kind]
      const msg =
        outcome === 'updated' || outcome === 'added'
          ? `${f.label} ${verb} · synced to Jobber`
          : outcome === 'failed'
            ? `${f.label} ${verb} · Jobber sync failed — saved in Bee Hub only`
            : `${f.label} ${verb}`
      setToast({ kind: 'success', msg })
    } catch (e) {
      // Keep the draft on a failed save — the input stays open with the
      // inline error (the standard: never silently drop a draft).
      setErr(`Save failed: ${e.message}`)
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
          <span style={{ color: T.ink.muted, display: 'inline-flex', flexShrink: 0 }}><f.Icon size={13} /></span>
          <input
            autoFocus
            type={f.type}
            value={draft}
            disabled={busy}
            aria-label={`Edit ${kind}`}
            placeholder={f.placeholder}
            onChange={e => { setDraft(e.target.value); if (err) setErr(null) }}
            onKeyDown={e => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') cancel()
            }}
            onBlur={save}
            style={{ flex: 1, minWidth: 0, padding: '5px 8px', border: T.border.control, borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit', color: T.ink.primary, background: T.surface.raised, outline: 'none' }}
          />
          <InlineEditControls busy={busy} onSave={save} onCancel={cancel} />
        </div>
        {err && <p style={{ fontSize: '11px', color: T.state.danger.fg, marginTop: '3px', paddingLeft: '20px' }}>{err}</p>}
      </div>
    )
  }

  return value ? (
    <p onClick={readOnly ? undefined : open} title={readOnly ? undefined : `Edit ${kind}`}
      data-meta-row={kind}
      style={{ ...metaRowStyle(), cursor: readOnly ? 'default' : 'text' }}>
      <span style={metaIconStyle}><f.Icon size={META_ICON} /></span>
      <a className="bee-contact-link" href={f.href(value)} onClick={e => e.stopPropagation()}
        style={{ ...metaValueStyle, color: T.accent.fg, textDecoration: 'none' }}>
        {value}
      </a>
      {!readOnly && <EditPencil />}
    </p>
  ) : readOnly ? null : (
    <p onClick={open} data-meta-row={kind}
      style={{ ...metaRowStyle({ tone: 'faint' }), cursor: 'text' }}>
      <span style={{ ...metaIconStyle, color: 'inherit' }}><f.Icon size={META_ICON} /></span>
      <span style={metaAddStyle}>{f.empty}</span>
    </p>
  )
}
