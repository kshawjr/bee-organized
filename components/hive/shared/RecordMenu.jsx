// components/hive/shared/RecordMenu.jsx
// ─────────────────────────────────────────────────────────────
// The record ··· overflow menu — a portal-based action menu for a
// record masthead (EngagementPanel first; more record surfaces later).
//
// PORTAL PATTERN (the inbox menu-clip lesson, beta-inbox-menu-clip):
// the open menu rides createPortal to <body> with FIXED coords derived
// from its ··· trigger's rect, so an overflow:hidden / rounded ancestor
// (the overlay card) can never amputate it — the failure the inbox row
// menus hit. It re-anchors on scroll (capture phase, so scrolling
// ancestors count) + resize, flips ABOVE the trigger when the viewport
// bottom would clip it, closes on outside-click AND Esc, and only ever
// shows ONE menu (self-contained open state).
//
// STACKING (why NOT the inbox's zIndex:80): unlike the inbox row (a
// top-level tab), this menu's first home — the EngagementPanel masthead —
// lives INSIDE OverlayShell's fixed scrim (zIndex 10005). A body-portal at
// z-80 is a stacking sibling of that overlay in the root context, so it
// rendered BEHIND the scrim + card: the menu "opened" (state flipped,
// portal mounted) but was invisible AND unclickable — no error, no visible
// response. The portal therefore sits ABOVE the overlay layer so a menu
// spawned from within any overlay floats over it.
//
// Structured to GROW: pass `items` — an array of
//   { key, label, onClick, danger?, icon?, disabled? }
// (a falsy entry is skipped, so callers can inline conditionals). More
// record actions live here as they land; the masthead stays a single
// ··· affordance instead of a widening button row.
//
// tokens.js styling only (§ design-system pass). PURE-ish: only React +
// react-dom + tokens + icons — safe in the beta chunk.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useRef, useState, useLayoutEffect, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { IconDots } from '@/components/ui/icons'
import { T } from './tokens'

function MenuPortal({ anchorRef, onClose, children }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  // Fixed coords from the trigger rect, re-derived on scroll/resize.
  // First paint hidden until useLayoutEffect measures the real box, so
  // there's no flash at (0,0) before it lands under its ···.
  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const r = anchor.getBoundingClientRect()
      const w = ref.current?.offsetWidth || 0
      const h = ref.current?.offsetHeight || 0
      const below = r.bottom + 4
      // Flip above the trigger when the viewport bottom would clip it.
      const top = h && below + h > window.innerHeight - 8 && r.top - h - 4 > 8
        ? r.top - h - 4
        : below
      // Right-aligned: the menu's right edge hugs the trigger's, clamped.
      const left = Math.max(8, r.right - w)
      setPos({ top, left })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [anchorRef])

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div ref={ref} data-bee-record-menu onClick={(ev) => ev.stopPropagation()}
      style={{
        position: 'fixed', top: 0, left: 0, ...(pos || {}),
        visibility: pos ? 'visible' : 'hidden',
        minWidth: '200px', zIndex: 10011, background: T.surface.raised,
        border: T.border.thin, borderRadius: T.radius.inset,
        boxShadow: T.shadow.pop, padding: '4px',
      }}>
      {children}
    </div>,
    document.body,
  )
}

export default function RecordMenu({ items = [], ariaLabel = 'Record actions' }) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef(null)
  const rows = items.filter(Boolean)

  // Any click that bubbles to the document closes the menu; the trigger
  // and the portal itself stopPropagation, and the portal DOM lives under
  // <body> so the target check covers it explicitly (delegation order
  // alone can't be trusted across the portal boundary).
  useEffect(() => {
    if (!open) return
    const close = (ev) => {
      if (ev.target instanceof Element &&
        (ev.target.closest('[data-bee-record-menu]') || ev.target.closest('[data-bee-record-menu-trigger]'))) return
      setOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])

  if (rows.length === 0) return null

  return (
    <>
      <button
        ref={triggerRef}
        data-bee-record-menu-trigger
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(ev) => { ev.stopPropagation(); setOpen(v => !v) }}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: '30px', height: '30px', flexShrink: 0,
          borderRadius: T.radius.control, border: T.border.control,
          background: open ? T.surface.hover : T.surface.raised,
          color: T.ink.muted, cursor: 'pointer', fontFamily: 'inherit', padding: 0,
        }}>
        <IconDots size={16} />
      </button>
      {open && (
        <MenuPortal anchorRef={triggerRef} onClose={() => setOpen(false)}>
          {rows.map(it => (
            <button
              key={it.key}
              role="menuitem"
              disabled={it.disabled}
              onClick={() => { if (it.disabled) return; setOpen(false); it.onClick?.() }}
              style={{
                display: 'flex', alignItems: 'center', gap: '9px', width: '100%',
                textAlign: 'left', padding: '9px 11px', borderRadius: T.radius.control,
                border: 'none', background: 'transparent', fontFamily: 'inherit',
                fontSize: '13px', fontWeight: 500,
                color: it.disabled ? T.ink.faint : (it.danger ? T.state.danger.fg : T.ink.primary),
                cursor: it.disabled ? 'default' : 'pointer',
              }}
              onMouseEnter={(e) => { if (!it.disabled) e.currentTarget.style.background = T.surface.hover }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}>
              {it.icon && (
                <span style={{ display: 'inline-flex', flexShrink: 0, color: it.danger ? T.state.danger.fg : T.ink.muted }}>
                  {it.icon}
                </span>
              )}
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
            </button>
          ))}
        </MenuPortal>
      )}
    </>
  )
}
