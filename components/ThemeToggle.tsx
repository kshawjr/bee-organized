'use client'

import { useEffect, useState } from 'react'

type ThemeOption = 'light' | 'dark' | 'system'

export default function ThemeToggle() {
  const [selected, setSelected] = useState<ThemeOption>('system')

  function applyTheme(option: ThemeOption) {
    if (option === 'system') {
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      document.documentElement.setAttribute('data-theme', systemDark ? 'dark' : 'light')
    } else {
      document.documentElement.setAttribute('data-theme', option)
    }
  }

  useEffect(() => {
    const saved = (localStorage.getItem('theme') as ThemeOption) || 'system'
    setSelected(saved)
    applyTheme(saved)

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    function handleChange() {
      if ((localStorage.getItem('theme') || 'system') === 'system') {
        applyTheme('system')
      }
    }
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  function choose(option: ThemeOption) {
    setSelected(option)
    localStorage.setItem('theme', option)
    applyTheme(option)
  }

  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: '8px',
      overflow: 'hidden',
      display: 'flex',
    }}>
      {(['light', 'dark', 'system'] as ThemeOption[]).map(option => (
        <button
          key={option}
          onClick={() => choose(option)}
          style={{
            flex: 1,
            padding: '6px 4px',
            background: selected === option ? 'var(--brand)' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: selected === option ? '#000' : 'var(--text-muted)',
            fontSize: '11px',
            fontWeight: selected === option ? 600 : 400,
            textTransform: 'capitalize',
          }}
        >
          {option === 'light' ? '☀️' : option === 'dark' ? '🌙' : '💻'} {option}
        </button>
      ))}
    </div>
  )
}