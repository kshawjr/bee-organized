'use client'

import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'

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
  const [dropPos, setDropPos] = useState({ bottom: 0, left: 0, width: 0 })
  const [mounted, setMounted] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  function handleOpen() {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setDropPos({
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
        width: rect.width,
      })
    }
    setOpen(o => !o)
  }

  function close() {
    setOpen(false)
    setSearch('')
  }

  const filtered = options.filter(o =>
    o.label.toLowerCase().includes(search.toLowerCase())
  )

  const selected = options.find(o => o.value === value)

  const dropdown = open && mounted ? createPortal(
    <>
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
        onClick={close}
      />
      <div
        style={{
          position: 'fixed',
          bottom: dropPos.bottom,
          left: dropPos.left,
          width: dropPos.width,
          background: 'var(--bg-card)',
          border: '1px solid #d0d0d0',
          borderRadius: '6px',
          zIndex: 9999,
          boxShadow: '0 -4px 20px rgba(0,0,0,0.15)',
          overflow: 'hidden',
        }}
      >
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
              border: '1px solid #d0d0d0',
              borderRadius: '4px',
              color: 'var(--text-primary)',
              fontSize: '13px',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
        <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
          {value && (
            <button
              onClick={() => { onChange(''); close() }}
              style={{ width: '100%', padding: '8px 12px', background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '13px', textAlign: 'left', cursor: 'pointer' }}
            >
              Clear
            </button>
          )}
          {filtered.map(option => (
            <button
              key={option.value}
              onClick={() => { onChange(option.value); close() }}
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
    </>,
    document.body
  ) : null

  return (
    <div style={{ position: 'relative', width }}>
      <button
        ref={buttonRef}
        onClick={handleOpen}
        style={{
          width: '100%',
          padding: '8px 12px',
          background: 'var(--bg-card)',
          border: '1px solid #d0d0d0',
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
      {dropdown}
    </div>
  )
}