// components/hive/shared/AlphaRail.jsx — the contacts-app A–Z jump rail
// (ClientDirectory + EngagementList). Vertical, hugs the right edge of
// the table card as a flex sibling (sticky), locked idiom: 11px muted
// letters, hover accent, extra-muted non-clickable when no rows start
// with that letter, scroll-spy marks the current letter when sorted by
// name. Touch-drag along the rail jumps live (the iOS gesture).
//
// The parent owns the jump semantics (sort-switch when not name-sorted,
// cap extension, smooth scroll) via onPick(letter); this component owns
// presentation, the drag gesture, and the cheap scroll-spy (rAF-
// throttled offset check against the parent's `${idPrefix}-{L}` row
// anchors — no observers per row).
'use client'

import React, { useState, useEffect, useRef } from 'react'
import { ACCENT_BLUE } from './stageConfig'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export default function AlphaRail({ present = new Set(), idPrefix, sortedByName = false, onPick = () => {} }) {
  const [active, setActive] = useState(null)
  const railRef = useRef(null)
  const ticking = useRef(false)

  // Scroll-spy: last anchor above the fold wins. Only meaningful when
  // the rows are name-sorted; otherwise no letter is "current".
  useEffect(() => {
    if (!sortedByName) { setActive(null); return }
    const spy = () => {
      if (ticking.current) return
      ticking.current = true
      requestAnimationFrame(() => {
        ticking.current = false
        let current = null
        for (const L of LETTERS) {
          if (!present.has(L)) continue
          const el = document.getElementById(`${idPrefix}-${L}`)
          if (el && el.getBoundingClientRect().top <= 130) current = L
        }
        setActive(current)
      })
    }
    spy()
    window.addEventListener('scroll', spy, { passive: true })
    return () => window.removeEventListener('scroll', spy)
  }, [sortedByName, present, idPrefix])

  // Touch-drag: map the finger's Y inside the rail to a letter, live.
  const letterFromTouch = (clientY) => {
    const box = railRef.current?.getBoundingClientRect()
    if (!box) return null
    const idx = Math.floor(((clientY - box.top) / box.height) * LETTERS.length)
    return LETTERS[Math.max(0, Math.min(LETTERS.length - 1, idx))]
  }
  const handleTouch = (ev) => {
    const L = letterFromTouch(ev.touches[0].clientY)
    if (L && present.has(L)) onPick(L, { live: true })
  }

  return (
    <div
      ref={railRef}
      onTouchStart={handleTouch}
      onTouchMove={(ev) => { ev.preventDefault(); handleTouch(ev) }}
      style={{
        position: 'sticky', top: '70px', alignSelf: 'flex-start',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        width: '18px', flexShrink: 0, userSelect: 'none',
        touchAction: 'none', padding: '2px 0',
      }}
    >
      <style>{`.bee-alpha-letter:hover { color: ${ACCENT_BLUE} !important }`}</style>
      {LETTERS.map(L => {
        const has = present.has(L)
        const isActive = active === L
        return (
          <button
            key={L}
            className={has ? 'bee-alpha-letter' : undefined}
            onClick={has ? () => onPick(L) : undefined}
            disabled={!has}
            style={{
              border: 'none', background: 'transparent', padding: '0 4px',
              fontSize: '10px', lineHeight: '13px', fontFamily: 'inherit',
              fontWeight: isActive ? 600 : 400,
              color: isActive ? '#1a1a18' : has ? '#8a8a84' : '#dedcd5',
              cursor: has ? 'pointer' : 'default',
            }}
          >
            {L}
          </button>
        )
      })}
    </div>
  )
}
