// components/ui/FilterChips.jsx — quiet horizontal filter strip, now in
// the board's SECTION_LABEL type treatment (no pills): plain 12px/500
// text segments with the count after a middot in muted gray. The ACTIVE
// segment signals with a 2px bottom underline in --text-primary (the
// same active-signal idiom as the shell tab row) — never a background.
// Hover previews the underline in a light gray (class rule, so the
// active segment's inline underline always wins). items may set:
//   muted: true   — extra-quiet label (e.g. 'No contact info')
//   color: '...'  — semantic label color (e.g. Won green / Lost red)
//   divider: true — thin vertical rule between segment groups
//   toggle: { expanded, onToggle, ariaLabel } — a chevron button AFTER
//     the segment (separate click target: the segment text selects the
//     filter, the chevron only reveals/hides sub-segments — the List's
//     Open ▾ stages and Closed ▾ Won/Lost groups). Chevron points down
//     collapsed, up expanded (rotated IconChevronRight, the SortChevrons
//     idiom).
// Scrolls horizontally on narrow viewports (§7 mobile rule) — unless
// `wrap` is set: rows with BOTH collapse groups expandable (the List)
// wrap instead, so no expanded segment hides off-screen.
'use client'

import React from 'react'
import { SECTION_LABEL, SECTION_COUNT, TEXT_PRIMARY } from './tokens'
import { IconChevronRight } from './icons'

export default function FilterChips({ items = [], active, onChange, wrap = false }) {
  return (
    <div style={{
      display: 'flex', flexWrap: wrap ? 'wrap' : 'nowrap', alignItems: 'stretch',
      gap: wrap ? '2px 14px' : '14px', maxWidth: '100%',
      ...(wrap ? {} : { overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none' }),
      paddingBottom: '2px',
    }}>
      <style>{`
        .bee-flt-seg { border-bottom: 2px solid transparent }
        .bee-flt-seg:hover { border-bottom-color: rgba(0,0,0,0.18) }
      `}</style>
      {items.map(({ key, label, count, muted, color, divider, toggle }) => {
        if (divider) {
          return <span key={key} aria-hidden="true" style={{ width: '1px', alignSelf: 'stretch', background: 'rgba(0,0,0,0.12)', flexShrink: 0, margin: '2px 0' }} />
        }
        const isActive = key === active
        const seg = (
          <button
            key={toggle ? undefined : key}
            className="bee-flt-seg"
            aria-pressed={isActive}
            onClick={() => onChange(key)}
            style={{
              flexShrink: 0,
              padding: '3px 0 5px',
              border: 'none',
              background: 'transparent',
              ...SECTION_LABEL,
              color: color || (isActive ? `var(--text-primary, ${TEXT_PRIMARY})` : (muted ? '#b5b3ac' : SECTION_LABEL.color)),
              fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
              ...(isActive ? { borderBottom: `2px solid var(--text-primary, ${TEXT_PRIMARY})` } : {}),
            }}
          >
            {label}
            {count != null && (
              <span style={{ ...SECTION_COUNT, marginLeft: '5px', ...(muted ? { color: '#c9c7c0' } : {}) }}>· {count}</span>
            )}
          </button>
        )
        if (!toggle) return seg
        return (
          <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
            {seg}
            <button
              onClick={toggle.onToggle}
              aria-label={toggle.ariaLabel}
              aria-expanded={!!toggle.expanded}
              style={{
                border: 'none', background: 'transparent', padding: '3px 2px 5px',
                display: 'inline-flex', alignItems: 'center', cursor: 'pointer',
                color: SECTION_LABEL.color, fontFamily: 'inherit', flexShrink: 0,
              }}
            >
              <IconChevronRight size={12} style={{ transform: toggle.expanded ? 'rotate(-90deg)' : 'rotate(90deg)' }} />
            </button>
          </span>
        )
      })}
    </div>
  )
}
