// components/hive/shared/cardKit.jsx
// ─────────────────────────────────────────────────────────────
// Shared chrome for the tabbed lead-detail cards (PersonCard /
// ClientProfile / EngagementPanel) so the three don't re-declare it:
//   MicroLabel    — the 11px letterspaced section header
//   quietBtn      — the hairline quiet button (kept for inline mini-form
//                   controls like the touchpoint Log)
//   ActionRow /   — THE card action row (2026-07-09 restyle): equal-width
//   actionBtn       grid, soft-tinted no-border buttons. Tints stay at
//                   ~10-12% opacity — restrained, never a loud fill (the
//                   user dislikes obnoxious buttons).
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
import { GREEN_TEXT } from '@/components/ui/tokens'

export function MicroLabel({ children }) {
  return (
    <p style={{ fontSize: '11px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: '8px' }}>
      {children}
    </p>
  )
}

// Quiet action — hairline outline, dark text, ≥44px tap target. The
// CARD action rows moved to ActionRow/actionBtn below; this stays for
// inline mini-form controls (the touchpoint Log button).
export const quietBtn = (accent = null) => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
  minHeight: '44px', padding: '9px 14px', borderRadius: '8px',
  border: '0.5px solid rgba(0,0,0,0.15)', background: 'transparent',
  fontSize: '12px', fontWeight: 500, color: accent || '#1a1a18',
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', textDecoration: 'none',
})

// Action-row tones — soft tints of the action's own color family with a
// matching-color icon + label:
//   blue  — reach-the-human actions (Call)
//   gray  — neutral (Log touchpoint, Open in Jobber, New engagement)
//   green — forward motion (Send to Jobber — the founding door; the
//           Advance button was removed 7/10, stages move via Jobber)
export const ACTION_TONES = {
  blue:  { bg: 'rgba(55,138,221,0.10)', text: '#2b6aad' },
  gray:  { bg: 'rgba(0,0,0,0.06)',      text: '#444441' },
  green: { bg: 'rgba(29,158,117,0.12)', text: GREEN_TEXT },
}

// One action button — 38px, radius 9, NO border, soft tinted fill.
export const actionBtn = (tone = 'gray') => {
  const t = ACTION_TONES[tone] || ACTION_TONES.gray
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
    height: '38px', padding: '0 10px', borderRadius: '9px', border: 'none',
    background: t.bg, color: t.text, fontSize: '13px', fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', textDecoration: 'none',
    minWidth: 0, overflow: 'hidden',
  }
}

// The row — equal columns, even 8px gaps, sized to however many actions
// the card actually renders (conditional buttons drop out of the count).
export function ActionRow({ children }) {
  const kids = React.Children.toArray(children).filter(Boolean)
  if (kids.length === 0) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${kids.length}, 1fr)`, gap: '8px' }}>
      {kids}
    </div>
  )
}

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
