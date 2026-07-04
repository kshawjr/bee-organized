// components/hive/shared/FilterPopover.jsx — THE control idiom, defined
// once for every beta surface:
//   FilterButton  — the 'Filters · N' pill
//   FilterPopover — positioned card (sections + Clear all at the bottom)
//   FilterSection / CheckRow / TogglePills — section building blocks
//   SortChevrons  — discoverable sort marker: muted chevron PAIR at rest,
//                   dark single chevron + direction when active
//   SortHeaderStyle — hover tint for sortable headers (.bee-sort-header)
//   SortRows      — sort options as the combined popover's top section
//   FilteredEmpty — zero-match safety: names the active count + inline
//                   Clear all (the d710247 rule, on every surface)
'use client'

import React from 'react'
import { IconChevronRight } from '@/components/ui/icons'

// Pill sized EXACTLY like the FilterChips idiom it sits beside: 12px
// type, 5px 12px padding, radius 20 — visual siblings, no oversize.
export function FilterButton({ count = 0, open, onToggle, label = 'Filters' }) {
  return (
    <button onClick={onToggle}
      style={{ padding: '5px 12px', borderRadius: '20px', border: '0.5px solid rgba(0,0,0,0.15)', background: open || count > 0 ? '#fff' : 'transparent', fontSize: '12px', fontWeight: count > 0 ? 500 : 400, color: count > 0 ? '#1a1a18' : '#8a8a84', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', lineHeight: 'inherit' }}>
      {label}{count > 0 ? ` · ${count}` : ''}
    </button>
  )
}

// Sort rows for the combined Filter & sort popover: the modern menu rows
// (✓ on active, hover tint) rendered as the popover's TOP section. Sort
// has a default, not a 'cleared' state — Clear all never touches it.
export function SortRows({ value, onChange, options }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <style>{`.bee-sort-item:hover { background: #f7f6f4 }`}</style>
      {options.map(o => (
        <button key={o.key} className="bee-sort-item" onClick={() => onChange(o.key)}
          style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', margin: '0 -8px', borderRadius: '8px', border: 'none', background: 'transparent', fontSize: '12px', color: o.key === value ? '#1a1a18' : '#6b6b66', fontWeight: o.key === value ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
          <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center', color: '#1D9E75', flexShrink: 0 }}>{o.key === value ? '✓' : ''}</span>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function FilterPopover({ open, count = 0, onClear, children, width = 260 }) {
  if (!open) return null
  return (
    // Height cap in dvh (vh fallback) — iOS vh is the large viewport, so
    // a vh-capped popover could run past the visible bottom (OverlayShell
    // has the full story).
    <div className="bee-filter-pop" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 50, width: `${width}px`, overflowY: 'auto', background: '#fff', border: '0.5px solid rgba(0,0,0,0.12)', borderRadius: '10px', boxShadow: '0 8px 30px rgba(26,26,24,0.12)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <style>{`.bee-filter-pop { max-height: 62vh; max-height: 62dvh; }`}</style>
      {children}
      {count > 0 && (
        <button onClick={onClear}
          style={{ border: 'none', background: 'transparent', padding: 0, fontSize: '11px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', textDecoration: 'underline', textUnderlineOffset: '2px' }}>
          Clear all
        </button>
      )}
    </div>
  )
}

export function FilterSection({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <p style={{ fontSize: '10px', fontWeight: 500, color: '#8a8a84', letterSpacing: '0.6px', textTransform: 'uppercase' }}>{label}</p>
      {children}
    </div>
  )
}

export function CheckRow({ label, checked, onToggle }) {
  return (
    <button onClick={onToggle}
      style={{ display: 'flex', alignItems: 'center', gap: '8px', border: 'none', background: 'transparent', padding: 0, fontSize: '12px', color: checked ? '#1a1a18' : '#8a8a84', fontWeight: checked ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
      <span style={{ width: '14px', height: '14px', borderRadius: '4px', border: `0.5px solid ${checked ? '#1a1a18' : 'rgba(0,0,0,0.25)'}`, background: checked ? '#1a1a18' : '#fff', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', flexShrink: 0 }}>{checked ? '✓' : ''}</span>
      {label}
    </button>
  )
}

// Single-select pill row (null = off). options: [{ key, label }]
export function TogglePills({ options, value, onChange, prefix = null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#8a8a84', flexWrap: 'wrap' }}>
      {prefix}
      {options.map(o => (
        <button key={o.key} onClick={() => onChange(value === o.key ? null : o.key)}
          style={{ padding: '3px 10px', borderRadius: '20px', border: `0.5px solid ${value === o.key ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.12)'}`, background: value === o.key ? '#fff' : 'transparent', fontSize: '11px', fontWeight: value === o.key ? 500 : 400, color: value === o.key ? '#1a1a18' : '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Discoverable sort marker (A2 idiom): rest = muted chevron pair, active
// = dark chevron pointing the direction.
export function SortChevrons({ active, dir }) {
  if (!active) {
    return (
      <span style={{ display: 'inline-flex', flexDirection: 'column', marginLeft: '3px', color: '#c9c7c0', lineHeight: 0 }}>
        <IconChevronRight size={8} style={{ transform: 'rotate(-90deg)', marginBottom: '-3px' }} />
        <IconChevronRight size={8} style={{ transform: 'rotate(90deg)' }} />
      </span>
    )
  }
  return <IconChevronRight size={10} style={{ transform: dir === 'asc' ? 'rotate(-90deg)' : 'rotate(90deg)', marginLeft: '3px', color: '#1a1a18' }} />
}

export function SortHeaderStyle() {
  return <style>{`.bee-sort-header { cursor: pointer } .bee-sort-header:hover { color: #1a1a18 !important; background: #f7f6f4 }`}</style>
}

// Zero-match safety: never a silently empty surface.
export function FilteredEmpty({ count, onClear, noun = 'rows' }) {
  return (
    <div style={{ padding: '32px', textAlign: 'center', color: '#b5b3ac', fontSize: '12px' }}>
      No {noun} match the active filters (Filters · {count}).{' '}
      <button onClick={onClear} style={{ border: 'none', background: 'transparent', padding: 0, fontSize: '12px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', textUnderlineOffset: '2px' }}>
        Clear all
      </button>
    </div>
  )
}
