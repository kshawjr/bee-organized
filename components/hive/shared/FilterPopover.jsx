// components/hive/shared/FilterPopover.jsx — THE control idiom, defined
// once for every beta surface:
//   FilterButton  — the 'Filters · N' pill
//   FilterPopover — positioned card (sections + Clear all at the bottom)
//   FilterSection / CheckRow / TogglePills — section building blocks
//   SortChevrons  — discoverable sort marker: muted chevron PAIR at rest,
//                   dark single chevron + direction when active
//   SortHeaderStyle — hover tint for sortable headers (.bee-sort-header)
//   SortSelect    — the quiet 'Sort' select for board/inbox/directory
//   FilteredEmpty — zero-match safety: names the active count + inline
//                   Clear all (the d710247 rule, on every surface)
'use client'

import React, { useState, useEffect, useRef } from 'react'
import { IconChevronRight } from '@/components/ui/icons'

export function FilterButton({ count = 0, open, onToggle }) {
  return (
    <button onClick={onToggle}
      style={{ padding: '5px 12px', borderRadius: '20px', border: '0.5px solid rgba(0,0,0,0.15)', background: open || count > 0 ? '#fff' : 'transparent', fontSize: '12px', fontWeight: count > 0 ? 500 : 400, color: count > 0 ? '#1a1a18' : '#8a8a84', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
      Filters{count > 0 ? ` · ${count}` : ''}
    </button>
  )
}

export function FilterPopover({ open, count = 0, onClear, children, width = 260 }) {
  if (!open) return null
  return (
    <div style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 50, width: `${width}px`, maxHeight: '62vh', overflowY: 'auto', background: '#fff', border: '0.5px solid rgba(0,0,0,0.12)', borderRadius: '10px', boxShadow: '0 8px 30px rgba(26,26,24,0.12)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
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

// Modern quiet sort control: hairline pill trigger + custom popover menu
// (check glyph on the active option, hover tint, click-outside + Escape
// close, arrow/Enter keyboard nav, 120ms fade-slide open).
export function SortSelect({ value, onChange, options }) {
  const [open, setOpen] = useState(false)
  const [focusIdx, setFocusIdx] = useState(-1)
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const itemRefs = useRef([])
  const active = options.find(o => o.key === value) || options[0]

  useEffect(() => {
    if (!open) return
    const onDoc = (ev) => { if (rootRef.current && !rootRef.current.contains(ev.target)) setOpen(false) }
    const onKey = (ev) => { if (ev.key === 'Escape') { setOpen(false); triggerRef.current?.focus() } }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  useEffect(() => {
    if (open && focusIdx >= 0) itemRefs.current[focusIdx]?.focus()
  }, [open, focusIdx])

  const openMenu = () => {
    setOpen(true)
    setFocusIdx(Math.max(0, options.findIndex(o => o.key === value)))
  }

  const onTriggerKey = (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openMenu() }
  }
  const onItemKey = (ev, i) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setFocusIdx((i + 1) % options.length) }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setFocusIdx((i - 1 + options.length) % options.length) }
    else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onChange(options[i].key); setOpen(false); triggerRef.current?.focus() }
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <style>{`@keyframes beeSortIn { from { opacity: 0; transform: translateY(-2px) } to { opacity: 1; transform: translateY(0) } }`}</style>
      <button
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKey}
        style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '5px 12px', borderRadius: '20px', border: '0.5px solid rgba(0,0,0,0.15)', background: open ? '#fff' : 'transparent', fontSize: '12px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
      >
        Sort: <span style={{ color: '#1a1a18', fontWeight: 500 }}>{active.label}</span>
        <IconChevronRight size={10} style={{ transform: open ? 'rotate(-90deg)' : 'rotate(90deg)', color: '#8a8a84' }} />
      </button>
      {open && (
        <div role="listbox" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 50, minWidth: '190px', background: '#fff', border: '0.5px solid rgba(0,0,0,0.12)', borderRadius: '10px', boxShadow: '0 8px 30px rgba(26,26,24,0.12)', padding: '4px', animation: 'beeSortIn 120ms ease-out' }}>
          <style>{`.bee-sort-item:hover { background: #f7f6f4 }`}</style>
          {options.map((o, i) => (
            <button
              key={o.key}
              ref={el => { itemRefs.current[i] = el }}
              role="option"
              aria-selected={o.key === value}
              className="bee-sort-item"
              onClick={() => { onChange(o.key); setOpen(false) }}
              onKeyDown={(ev) => onItemKey(ev, i)}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '7px 10px', borderRadius: '8px', border: 'none', background: 'transparent', fontSize: '12px', color: o.key === value ? '#1a1a18' : '#6b6b66', fontWeight: o.key === value ? 500 : 400, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}
            >
              <span style={{ width: '14px', display: 'inline-flex', justifyContent: 'center', color: '#1D9E75' }}>{o.key === value ? '✓' : ''}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
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
