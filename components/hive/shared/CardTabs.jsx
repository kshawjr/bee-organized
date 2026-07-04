// components/hive/shared/CardTabs.jsx
// ─────────────────────────────────────────────────────────────
// The lead-detail cards' tab bar (Overview / Timeline / Files). A
// POST-STREAMING JS STEPPER: the host owns `active` state and renders
// ONLY the active tab's content — never display:none (the shell hides
// content during streaming otherwise, and hidden-but-mounted tabs would
// fire their fetches eagerly). Overview must be the host's initial
// state so the default tab SSRs synchronously.
//
// ≥44px tap targets (the cards are the primary mobile triage surface);
// active tab = inset underline (no layout shift), inactive muted.
// §8.5: pure presentational, props only.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'

export default function CardTabs({ tabs = [], active, onChange }) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: '2px', borderBottom: '0.5px solid rgba(0,0,0,0.08)' }}>
      {tabs.map(t => {
        const on = active === t.key
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={on}
            aria-label={`${t.label} tab`}
            onClick={() => onChange(t.key)}
            style={{
              minHeight: '44px', padding: '0 14px',
              border: 'none', background: 'transparent', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: '12px', fontWeight: 500,
              color: on ? '#1a1a18' : '#8a8a84',
              boxShadow: on ? 'inset 0 -2px 0 #1a1a18' : 'none',
            }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}
