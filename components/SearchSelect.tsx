'use client'

import { useState, useRef, useEffect } from 'react'

interface Option {
  value: string
  label: string
}

interface Props {
  options: Option[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  width?: string
}

export default function SearchSelect({ options, value, onChange, placeholder = 'Select...', width = '180px' }: Props) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const filtered = options.filter(o =>
    o.label.toLowerCase().includes(search.toLowerCase())
  )

  const selected = options.find(o => o.value === value)

  return (
    <div ref={ref} style={{ position: 'relative', width }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%',
          padding: '8px 12px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          color: selected ? 'var(--text-primary)' : 'var(--text-muted)',
          fontSize: '14px',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>{selected ? selected.label : placeholder}</span>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          right: 0,
          marginTop: '4px',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: '6px',
          zIndex: 50,
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
          overflow: 'hidden',
        }}>
          <div style={{ padding: '6px' }}>
            <input
              autoFocus
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search..."
              style={{
                width: '100%',
                padding: '6px 8px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                color: 'var(--text-primary)',
                fontSize: '13px',
                outline: 'none',
                boxSizing: 'border-box' as const,
              }}
            />
          </div>
          <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
            {value && (
              <button
                onClick={() => { onChange(''); setOpen(false); setSearch('') }}
                style={{ width: '100%', padding: '8px 12px', background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '13px', textAlign: 'left', cursor: 'pointer' }}
              >
                Clear
              </button>
            )}
            {filtered.map(option => (
              <button
                key={option.value}
                onClick={() => { onChange(option.value); setOpen(false); setSearch('') }}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  background: option.value === value ? 'var(--bg-elevated)' : 'transparent',
                  border: 'none',
                  color: option.value === value ? 'var(--brand)' : 'var(--text-primary)',
                  fontSize: '13px',
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                {option.label}
              </button>
            ))}
            {filtered.length === 0 && (
              <p style={{ padding: '8px 12px', color: 'var(--text-muted)', fontSize: '13px' }}>No results</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}