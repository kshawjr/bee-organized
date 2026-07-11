// components/hive/OverlayShell.jsx
// ─────────────────────────────────────────────────────────────
// THE overlay container: desktop centered modal (740px, r16, close X) /
// mobile bottom sheet (drag handle + swipe-down dismiss). Extracted from
// EngagementPanel/ClientProfile so PersonCard and any future overlay
// render the identical chrome. Beta chunk only.
//
// Open discipline: every open (and panel↔profile swap — HiveShell keys
// the overlays by record id, so a swap remounts this shell) starts the
// sheet at ITS OWN top, and the page behind is scroll-locked (classic
// AccountPanel pattern, BeeHub.jsx) so touch scrolling never bleeds
// through to the board.
//
// Sheet geometry (2026-07-04 iOS root cause): the backdrop is fixed
// inset:0 (iOS layout viewport = the VISIBLE area), but a vh maxHeight
// resolves against the LARGE viewport — with Safari's toolbar expanded
// a bottom-anchored 88vh sheet was taller than the screen and its top
// (handle + title) rendered offscreen. Height caps therefore live in
// the class below as vh-with-dvh-override pairs (inline styles can't
// double-declare); the sheet also pads for the home indicator. NEVER
// size the sheet with height:100vh or top:0+bottom:0.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useRef, useEffect } from 'react'
import { IconX } from '@/components/ui/icons'
import { T } from './shared/tokens'

// .bee-sheet-close: the X shares the 44px handle row — absolute right so
// the handle stays dead-center; 44×44 hit target (glyph stays 16px) kept
// inside the row so the invisible hit area never covers the title/chip
// content below; right offset respects the notch in landscape.
const GeometryStyle = () => (
  <style>{`
    .bee-sheet { max-height: 90vh; max-height: 90dvh; padding-bottom: env(safe-area-inset-bottom, 0px); }
    .bee-overlay-modal { max-height: 88vh; max-height: 88dvh; }
    .bee-sheet-close { position: absolute; top: 0; right: env(safe-area-inset-right, 0px); width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; padding: 0; border: none; background: transparent; color: ${T.ink.quiet}; cursor: pointer; }
  `}</style>
)

// maxWidth: desktop modal width cap. 740 is the classic card width;
// ClientProfile + EngagementPanel pass 840 (card-restore build 2 — the
// blessed two-column layouts assume it). Mobile sheet ignores it.
export default function OverlayShell({ isMobile, onClose, children, maxWidth = 740 }) {
  const touchY = useRef(null)
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  if (isMobile) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 10005, display: 'flex', alignItems: 'flex-end', background: T.surface.scrim }} onClick={onClose}>
        <GeometryStyle />
        <div ref={scrollRef} className="bee-sheet" onClick={e => e.stopPropagation()}
          style={{ background: T.surface.raised, width: '100%', overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', borderRadius: `${T.radius.card} ${T.radius.card} 0 0`, boxShadow: T.shadow.sheet }}>
          <div
            onTouchStart={e => { touchY.current = e.touches[0].clientY }}
            onTouchEnd={e => {
              if (touchY.current == null) return
              const dy = e.changedTouches[0].clientY - touchY.current
              touchY.current = null
              if (dy > 60) onClose()
            }}
            style={{ position: 'relative', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'grab' }}
          >
            <div style={{ width: '36px', height: '4px', background: T.hairline.control, borderRadius: '2px' }} />
            <button onClick={onClose} aria-label="Close" className="bee-sheet-close"><IconX size={16} /></button>
          </div>
          {children}
        </div>
      </div>
    )
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10005, background: T.surface.scrim, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }} onClick={onClose}>
      <GeometryStyle />
      <div ref={scrollRef} className="bee-overlay-modal" onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: `${maxWidth}px`, overflowY: 'auto', overscrollBehavior: 'contain', background: T.surface.raised, border: T.border.card, borderRadius: T.radius.card, boxShadow: T.shadow.overlay }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 16px 4px' }}>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: T.ink.quiet, cursor: 'pointer', lineHeight: 1, padding: '2px 4px' }}><IconX size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}
