// components/hive/shared/cardKit.jsx
// ─────────────────────────────────────────────────────────────
// Shared chrome for the tabbed lead-detail cards (PersonCard /
// ClientProfile / EngagementPanel) so the three don't re-declare it:
//   MicroLabel    — the 11px letterspaced section header
//   quietBtn      — the hairline quiet action (ghost-adjacent: text +
//                   optional leading icon, no fill; the user dislikes
//                   loud buttons — one restrained accent max per card)
//   CardMenu      — the header's ··· more menu (secondary/destructive
//                   actions live here, not inline). MetaSelect's
//                   fixed-backdrop pattern — overlay-safe zIndexes.
//   undoToast     — the Inbox's undo-inside-the-toast idiom (host
//                   InlineToast renders {msg} verbatim; ~3s window).
// §8.5: props only, no context.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useState } from 'react'
import { IconDots } from '@/components/ui/icons'

export function MicroLabel({ children }) {
  return (
    <p style={{ fontSize: '11px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: '8px' }}>
      {children}
    </p>
  )
}

// Quiet action — hairline outline, dark text, ≥44px tap target. Pass
// accent for the ONE slightly-emphasized action a card may carry
// (Send to Jobber, the founding door): green text, still no fill.
export const quietBtn = (accent = null) => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
  minHeight: '44px', padding: '9px 14px', borderRadius: '8px',
  border: '0.5px solid rgba(0,0,0,0.15)', background: 'transparent',
  fontSize: '12px', fontWeight: 500, color: accent || '#1a1a18',
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', textDecoration: 'none',
})

export function CardMenu({ items = [], label = 'More' }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  if (items.length === 0) return null
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        className="bee-ghost-btn" aria-label={label} title={label}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}
        style={{
          width: '32px', height: '32px', padding: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: 'none', background: 'transparent', borderRadius: '8px',
          color: 'var(--text-muted, #8a8a84)', cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        <IconDots size={17} />
      </button>
      {open && (
        <>
          {/* fixed click-catcher — overlay-safe (above the OverlayShell) */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 10009 }} onClick={() => setOpen(false)} />
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 10010,
            minWidth: '210px', background: '#fff',
            border: '0.5px solid rgba(0,0,0,0.12)', borderRadius: '10px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.14)', padding: '4px',
          }}>
            {items.map(it => <MenuRow key={it.key} item={it} close={() => setOpen(false)} />)}
          </div>
        </>
      )}
    </div>
  )
}

function MenuRow({ item, close }) {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={(e) => { e.stopPropagation(); close(); item.onPick() }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '8px 10px', border: 'none', borderRadius: '7px',
        background: hover ? '#f7f6f4' : 'transparent',
        fontSize: '13px', fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
        color: item.danger ? '#b42318' : '#1a1a18',
      }}
    >
      {item.label}
    </button>
  )
}

// InlineToast (BeeHub scope) renders {msg} verbatim, so a React node
// rides through — the Undo button lives inside the toast; the undo
// window is the host's ~3s auto-dismiss.
export const undoToast = (text, onUndo) => ({
  kind: 'success',
  msg: (
    <span>
      {text} ·{' '}
      <button onClick={onUndo}
        style={{ background: 'none', border: 'none', padding: 0, color: '#fff', font: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
        Undo
      </button>
    </span>
  ),
})
