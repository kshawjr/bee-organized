// components/hive/MetaSelect.jsx
// ─────────────────────────────────────────────────────────────
// Quiet tap-to-edit meta select: 'Source: Webform' as a hairline pill
// trigger → the modern popover menu rows (✓ on active, hover tint),
// Escape/outside closes. Empty state: '{label} · add' dashed-quiet.
// Options are admin-managed lookup labels. Used by PersonCard +
// EngagementPanel's meta row. Beta chunk only.
//
// renderTrigger (optional): swap the pill for a host-supplied trigger —
// receives a toggle callback; the popover menu (None + options, the ONE
// options idiom) anchors beneath it. SourceField's ContactField-anatomy
// row composes this so the menu never forks. Default pill unchanged.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useEffect } from 'react'
import { T } from './shared/tokens'

export default function MetaSelect({ label, value, options = [], onPick, renderTrigger = null, readOnly = false }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const pill = value ? {
    padding: '4px 10px', borderRadius: T.radius.pill, border: T.border.thin,
    background: T.surface.raised, fontSize: '11px', color: T.ink.primary, cursor: 'pointer',
    fontFamily: 'inherit', whiteSpace: 'nowrap',
  } : {
    padding: '4px 10px', borderRadius: T.radius.pill, border: T.border.dashed,
    background: 'transparent', fontSize: '11px', color: T.ink.quiet, cursor: 'pointer',
    fontFamily: 'inherit', whiteSpace: 'nowrap',
  }

  const toggle = (e) => { if (e) e.stopPropagation(); setOpen(v => !v) }

  // Read-only: show the value as static text — no trigger, no popover.
  if (readOnly) {
    return (
      <span style={{ fontSize: '11px', color: T.ink.primary, whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
        <span style={{ color: T.ink.muted }}>{label}: </span>{value || '—'}
      </span>
    )
  }

  return (
    <span style={{ position: 'relative', display: renderTrigger ? 'block' : 'inline-block' }}>
      {renderTrigger ? renderTrigger(toggle) : (
        <button onClick={toggle} style={pill}>
          {value ? <><span style={{ color: T.ink.muted }}>{label}: </span>{value}</> : `${label} · add`}
        </button>
      )}
      {open && (
        <>
          <div onClick={e => { e.stopPropagation(); setOpen(false) }} style={{ position: 'fixed', inset: 0, zIndex: 10009 }} />
          <div className="bee-meta-pop" onClick={e => e.stopPropagation()}
            style={{ position: 'absolute', left: 0, top: 'calc(100% + 6px)', zIndex: 10010, width: '210px', overflowY: 'auto', background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.inset, boxShadow: T.shadow.pop, padding: '8px 12px' }}>
            <style>{`.bee-meta-item:hover { background:${T.surface.hover} } .bee-meta-pop { max-height: 46vh; max-height: 46dvh; }`}</style>
            {/* None pinned first — every meta field must be clearable; a
                lead can legitimately have no source/type, and trapping the
                user in a value once picked fabricates data. onPick(null)
                → the caller PATCHes the column to null. */}
            <button className="bee-meta-item"
              onClick={() => { setOpen(false); if (value != null) onPick(null) }}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', margin: '0 -8px', borderRadius: T.radius.control, border: 'none', background: 'transparent', fontSize: '12px', color: value == null ? T.ink.primary : T.ink.quiet, fontWeight: value == null ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', fontStyle: 'italic' }}>
              <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center', color: T.state.success.fg, flexShrink: 0 }}>{value == null ? '✓' : ''}</span>
              None
            </button>
            {options.map(o => (
              <button key={o} className="bee-meta-item"
                onClick={() => { setOpen(false); if (o !== value) onPick(o) }}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', margin: '0 -8px', borderRadius: T.radius.control, border: 'none', background: 'transparent', fontSize: '12px', color: o === value ? T.ink.primary : T.ink.secondary, fontWeight: o === value ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center', color: T.state.success.fg, flexShrink: 0 }}>{o === value ? '✓' : ''}</span>
                {o}
              </button>
            ))}
            {options.length === 0 && (
              <p style={{ fontSize: '11px', color: T.ink.quiet, padding: '4px 0' }}>No options configured — manage in Admin</p>
            )}
          </div>
        </>
      )}
    </span>
  )
}
