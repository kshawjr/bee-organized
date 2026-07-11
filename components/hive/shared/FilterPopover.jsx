// components/hive/shared/FilterPopover.jsx — THE control idiom, defined
// once for every beta surface:
//   FilterButton  — the 'Filters · N' pill
//   FilterPopover — positioned card (sections + Clear all at the bottom)
//   FilterSection / CheckRow / TogglePills — section building blocks
//   SortChevrons  — discoverable sort marker: muted chevron PAIR at rest,
//                   dark single chevron + direction when active
//   SortHeaderStyle — hover tint for sortable headers (.bee-sort-header)
//   SortRows      — sort options as the combined popover's top section
//   ClearAllButton — THE 'Clear all' rendering (12px muted underline),
//                   shared by the popover footer + FilteredEmpty
//   FilteredEmpty — zero-match safety: names the active count + inline
//                   Clear all (the d710247 rule, on every surface)
'use client'

import React from 'react'
import { IconChevronRight } from '@/components/ui/icons'
import { HAIRLINE_BORDER, TEXT_SUCCESS, TEXT_MUTED } from '@/components/ui/tokens'
import { T } from './tokens'

// ONE 'Clear all' rendering (12px, muted, underlined) — the popover
// footer and FilteredEmpty both consume THIS so the two can't split.
export function ClearAllButton({ onClick, style = {} }) {
  return (
    <button className="bee-clear-all" onClick={onClick}
      style={{ border: 'none', background: 'transparent', padding: 0, fontSize: '12px', color: `var(--text-muted, ${TEXT_MUTED})`, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', textUnderlineOffset: '2px', ...style }}>
      Clear all
    </button>
  )
}

// Pill sized EXACTLY like the FilterChips idiom it sits beside: 12px
// type, 5px 12px padding, radius 20 — visual siblings, no oversize.
export function FilterButton({ count = 0, open, onToggle, label = 'Filters' }) {
  return (
    <button onClick={onToggle}
      style={{ padding: '5px 12px', borderRadius: T.radius.pill, border: `0.5px solid var(--hairline-border, ${HAIRLINE_BORDER})`, background: open || count > 0 ? T.surface.raised : 'transparent', fontSize: '12px', fontWeight: count > 0 ? 500 : 400, color: count > 0 ? T.ink.primary : T.ink.muted, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', lineHeight: 'inherit' }}>
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
      <style>{`.bee-sort-item:hover { background: ${T.surface.hover} }`}</style>
      {options.map(o => (
        <button key={o.key} className="bee-sort-item" onClick={() => onChange(o.key)}
          style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '6px 8px', margin: '0 -8px', borderRadius: T.radius.control, border: 'none', background: 'transparent', fontSize: '12px', color: o.key === value ? T.ink.primary : T.ink.secondary, fontWeight: o.key === value ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
          <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center', color: `var(--text-success, ${TEXT_SUCCESS})`, flexShrink: 0 }}>{o.key === value ? '✓' : ''}</span>
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
    <div className="bee-filter-pop" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 50, width: `${width}px`, overflowY: 'auto', background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.inset, boxShadow: T.shadow.pop, padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <style>{`.bee-filter-pop { max-height: 62vh; max-height: 62dvh; }`}</style>
      {children}
      {count > 0 && <ClearAllButton onClick={onClear} style={{ textAlign: 'left' }} />}
    </div>
  )
}

export function FilterSection({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <p style={{ fontSize: '10px', fontWeight: 500, color: T.ink.muted, letterSpacing: '0.6px', textTransform: 'uppercase' }}>{label}</p>
      {children}
    </div>
  )
}

export function CheckRow({ label, checked, onToggle }) {
  return (
    <button onClick={onToggle}
      style={{ display: 'flex', alignItems: 'center', gap: '8px', border: 'none', background: 'transparent', padding: 0, fontSize: '12px', color: checked ? T.ink.primary : T.ink.muted, fontWeight: checked ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
      <span style={{ width: '14px', height: '14px', borderRadius: '4px', border: `0.5px solid ${checked ? T.ink.primary : T.hairline.strong}`, background: checked ? T.ink.primary : T.surface.raised, color: T.ink.inverse, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', flexShrink: 0 }}>{checked ? '✓' : ''}</span>
      {label}
    </button>
  )
}

// Single-select pill row (null = off). options: [{ key, label }]
export function TogglePills({ options, value, onChange, prefix = null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: T.ink.muted, flexWrap: 'wrap' }}>
      {prefix}
      {options.map(o => (
        <button key={o.key} onClick={() => onChange(value === o.key ? null : o.key)}
          style={{ padding: '3px 10px', borderRadius: T.radius.pill, border: `0.5px solid ${value === o.key ? T.hairline.strong : T.hairline.line}`, background: value === o.key ? T.surface.raised : 'transparent', fontSize: '11px', fontWeight: value === o.key ? 500 : 400, color: value === o.key ? T.ink.primary : T.ink.muted, cursor: 'pointer', fontFamily: 'inherit' }}>
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
      <span style={{ display: 'inline-flex', flexDirection: 'column', marginLeft: '3px', color: T.ink.faint, lineHeight: 0 }}>
        <IconChevronRight size={8} style={{ transform: 'rotate(-90deg)', marginBottom: '-3px' }} />
        <IconChevronRight size={8} style={{ transform: 'rotate(90deg)' }} />
      </span>
    )
  }
  return <IconChevronRight size={10} style={{ transform: dir === 'asc' ? 'rotate(-90deg)' : 'rotate(90deg)', marginLeft: '3px', color: T.ink.primary }} />
}

export function SortHeaderStyle() {
  return <style>{`.bee-sort-header { cursor: pointer } .bee-sort-header:hover { color: ${T.ink.primary} !important; background: ${T.surface.hover} }`}</style>
}

// Zero-match safety: never a silently empty surface.
export function FilteredEmpty({ count, onClear, noun = 'rows' }) {
  return (
    <div style={{ padding: '32px', textAlign: 'center', color: T.ink.quiet, fontSize: '12px' }}>
      No {noun} match the active filters (Filters · {count}).{' '}
      <ClearAllButton onClick={onClear} />
    </div>
  )
}
