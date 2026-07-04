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

const GeometryStyle = () => (
  <style>{`
    .bee-sheet { max-height: 90vh; max-height: 90dvh; padding-bottom: env(safe-area-inset-bottom, 0px); }
    .bee-overlay-modal { max-height: 88vh; max-height: 88dvh; }
  `}</style>
)

export default function OverlayShell({ isMobile, onClose, children }) {
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
      <div style={{ position: 'fixed', inset: 0, zIndex: 10005, display: 'flex', alignItems: 'flex-end', background: 'rgba(26,26,24,0.35)' }} onClick={onClose}>
        <GeometryStyle />
        <div ref={scrollRef} className="bee-sheet" onClick={e => e.stopPropagation()}
          style={{ background: '#fff', width: '100%', overflowY: 'auto', overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch', borderRadius: '20px 20px 0 0', boxShadow: '0 -8px 40px rgba(26,26,24,0.2)' }}>
          <div
            onTouchStart={e => { touchY.current = e.touches[0].clientY }}
            onTouchEnd={e => {
              if (touchY.current == null) return
              const dy = e.changedTouches[0].clientY - touchY.current
              touchY.current = null
              if (dy > 60) onClose()
            }}
            style={{ padding: '10px 0 8px', cursor: 'grab' }}
          >
            <div style={{ width: '36px', height: '4px', background: 'rgba(0,0,0,0.15)', borderRadius: '2px', margin: '0 auto' }} />
          </div>
          {children}
        </div>
      </div>
    )
  }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 10005, background: 'rgba(26,26,24,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }} onClick={onClose}>
      <GeometryStyle />
      <div ref={scrollRef} className="bee-overlay-modal" onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: '740px', overflowY: 'auto', overscrollBehavior: 'contain', background: '#fff', borderRadius: '16px', boxShadow: '0 24px 80px rgba(26,26,24,0.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 16px 4px' }}>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', color: '#b5b3ac', cursor: 'pointer', lineHeight: 1, padding: '2px 4px' }}><IconX size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}
