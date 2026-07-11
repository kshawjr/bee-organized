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

export default function MetaSelect({ label, value, options = [], onPick, renderTrigger = null }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const pill = value ? {
    padding: '4px 10px', borderRadius: '20px', border: '0.5px solid rgba(0,0,0,0.12)',
    background: '#fff', fontSize: '11px', color: '#1a1a18', cursor: 'pointer',
    fontFamily: 'inherit', whiteSpace: 'nowrap',
  } : {
    padding: '4px 10px', borderRadius: '20px', border: '0.5px dashed rgba(0,0,0,0.18)',
    background: 'transparent', fontSize: '11px', color: '#b5b3ac', cursor: 'pointer',
    fontFamily: 'inherit', whiteSpace: 'nowrap',
  }

  const toggle = (e) => { if (e) e.stopPropagation(); setOpen(v => !v) }

  return (
    <span style={{ position: 'relative', display: renderTrigger ? 'block' : 'inline-block' }}>
      {renderTrigger ? renderTrigger(toggle) : (
        <button onClick={toggle} style={pill}>
          {value ? <><span style={{ color: '#8a8a84' }}>{label}: </span>{value}</> : `${label} · add`}
        </button>
      )}
      {open && (
        <>
          <div onClick={e => { e.stopPropagation(); setOpen(false) }} style={{ position: 'fixed', inset: 0, zIndex: 10009 }} />
          <div className="bee-meta-pop" onClick={e => e.stopPropagation()}
            style={{ position: 'absolute', left: 0, top: 'calc(100% + 6px)', zIndex: 10010, width: '210px', overflowY: 'auto', background: '#fff', border: '0.5px solid rgba(0,0,0,0.12)', borderRadius: '10px', boxShadow: '0 8px 30px rgba(26,26,24,0.12)', padding: '8px 12px' }}>
            <style>{`.bee-meta-item:hover { background:#f7f6f4 } .bee-meta-pop { max-height: 46vh; max-height: 46dvh; }`}</style>
            {/* None pinned first — every meta field must be clearable; a
                lead can legitimately have no source/type, and trapping the
                user in a value once picked fabricates data. onPick(null)
                → the caller PATCHes the column to null. */}
            <button className="bee-meta-item"
              onClick={() => { setOpen(false); if (value != null) onPick(null) }}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', margin: '0 -8px', borderRadius: '8px', border: 'none', background: 'transparent', fontSize: '12px', color: value == null ? '#1a1a18' : '#b5b3ac', fontWeight: value == null ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', fontStyle: 'italic' }}>
              <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center', color: '#1D9E75', flexShrink: 0 }}>{value == null ? '✓' : ''}</span>
              None
            </button>
            {options.map(o => (
              <button key={o} className="bee-meta-item"
                onClick={() => { setOpen(false); if (o !== value) onPick(o) }}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', margin: '0 -8px', borderRadius: '8px', border: 'none', background: 'transparent', fontSize: '12px', color: o === value ? '#1a1a18' : '#6b6b66', fontWeight: o === value ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center', color: '#1D9E75', flexShrink: 0 }}>{o === value ? '✓' : ''}</span>
                {o}
              </button>
            ))}
            {options.length === 0 && (
              <p style={{ fontSize: '11px', color: '#b5b3ac', padding: '4px 0' }}>No options configured — manage in Admin</p>
            )}
          </div>
        </>
      )}
    </span>
  )
}
