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
import { T } from './tokens'

export function MicroLabel({ children }) {
  return (
    <p style={{ fontSize: '11px', fontWeight: 500, color: T.ink.muted, letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: '8px' }}>
      {children}
    </p>
  )
}

// ── the pill/badge scale (design-system pass 7/11) ────────────
// ONE person/category PILL anatomy — assignee + tag pills and the
// dashed "+ add" affordances share height/font/radius here, tuned to
// sit level with the status CHIPS beside them. BOTH cards reach for this
// (EngagementAssignees on the panel; TagsRow/ContactsBlock on the
// profile) so the two surfaces can't drift chip-vs-pill-vs-button.
//   leading — tighten the left inset for a pill that carries an avatar
//   dashed  — the "+ add" affordance (transparent, dashed hairline)
export const pillStyle = ({ dashed = false, leading = false } = {}) => ({
  display: 'inline-flex', alignItems: 'center', gap: T.badge.gap,
  height: T.badge.height, boxSizing: 'border-box',
  padding: leading ? `0 ${T.badge.padX} 0 ${T.badge.padAvatarL}` : `0 ${T.badge.padX}`,
  borderRadius: T.radius.pill,
  border: dashed ? T.border.dashed : T.border.thin,
  background: dashed ? 'transparent' : T.surface.raised,
  fontSize: T.badge.font, fontWeight: T.badge.weight, lineHeight: 1,
  color: dashed ? T.ink.muted : T.ink.primary,
  fontFamily: 'inherit', whiteSpace: 'nowrap',
})

// A quiet, BORDERLESS editable meta VALUE — the masthead Type cell (and
// any future meta value): value in primary ink with the inline-edit ✎,
// no input box. Sits under a MicroLabel, mirroring the profile's cells.
export const metaValueBtn = (filled) => ({
  display: 'inline-flex', alignItems: 'center', gap: '6px', maxWidth: '100%', minWidth: 0,
  border: 'none', background: 'transparent', padding: 0,
  fontSize: '13px', fontWeight: 500, color: filled ? T.ink.primary : T.ink.quiet,
  letterSpacing: T.type.trackTitle, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
})

// Quiet action — hairline outline, dark text, ≥44px tap target. The
// CARD action rows moved to ActionRow/actionBtn below; this stays for
// inline mini-form controls (the touchpoint Log button).
export const quietBtn = (accent = null) => ({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
  minHeight: '44px', padding: '9px 14px', borderRadius: T.radius.control,
  border: T.border.control, background: 'transparent',
  fontSize: '12px', fontWeight: 500, color: accent || T.ink.primary,
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', textDecoration: 'none',
})

// Action-row tones (design-system pass 7/11): ONE action accent — the
// brand teal — for forward/primary actions; gray for neutral. The old
// blue (Call) and forest-green (Send to Jobber) tones both unified to
// `accent`, so the row never fights the chip families' blue:
//   accent — reach-the-human + forward motion (Call, Send to Jobber)
//   gray   — neutral (Log touchpoint, Open in Jobber, New engagement)
export const ACTION_TONES = {
  accent: { bg: T.accent.soft, text: T.accent.deep },
  gray:   { bg: T.state.neutralSoft, text: T.ink.strong },
  // legacy tone names — kept resolving so a missed call site degrades
  // to the unified accent, never to a dead gray
  blue:   { bg: T.accent.soft, text: T.accent.deep },
  green:  { bg: T.accent.soft, text: T.accent.deep },
}

// One action button — 38px, radius from the token scale, NO border,
// soft tinted fill.
export const actionBtn = (tone = 'gray') => {
  const t = ACTION_TONES[tone] || ACTION_TONES.gray
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
    height: '38px', padding: '0 10px', borderRadius: T.radius.inset, border: 'none',
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
          border: 'none', background: 'transparent', borderRadius: T.radius.control,
          color: `var(--text-muted, ${T.ink.muted})`, cursor: 'pointer', fontFamily: 'inherit',
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
            minWidth: '210px', background: T.surface.raised,
            border: T.border.thin, borderRadius: T.radius.inset,
            boxShadow: T.shadow.pop, padding: '4px',
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
        padding: '8px 10px', border: 'none', borderRadius: T.radius.control,
        background: hover ? T.surface.hover : 'transparent',
        fontSize: '13px', fontWeight: 500, fontFamily: 'inherit', cursor: 'pointer',
        color: item.danger ? T.state.danger.strong : T.ink.primary,
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
        style={{ background: 'none', border: 'none', padding: 0, color: T.ink.inverse, font: 'inherit', textDecoration: 'underline', cursor: 'pointer' }}>
        Undo
      </button>
    </span>
  ),
})
