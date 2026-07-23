// components/hive/shared/PickALocation.jsx
// ─────────────────────────────────────────────────────────────
// The 'All Locations' prompt (Fix 2 Phase 4b) — ONE component for every
// record lens. 'All Locations' is a corporate OVERVIEW, not a data scope: it
// answers "how is the business doing", and every surface that enumerates
// records belonging to a specific location asks you to pick one.
//
// Lived inside HiveShell while it served only the three shell lenses; hoisted
// here when the Network tab (which mounts OUTSIDE the shell, via
// PartnersScreen) joined the same rule — one component, one copy table, no
// second empty state.
//
// The copy is deliberately about HOW THE PRODUCT WORKS, never about missing
// data: "works one location at a time", not "no results" or "nothing loaded".
// And the button opens the switcher right here, so the answer is one click
// away rather than something to go hunting for — that button is most of what
// makes this read as intentional rather than broken.
'use client'

import React from 'react'
import { T } from './tokens'
import { IconMapPin } from '@/components/ui/icons'

export const PICK_COPY = {
  inbox:       'The inbox works one location at a time',
  clients:     'The client list works one location at a time',
  engagements: 'Engagements work one location at a time',
  network:     'The network works one location at a time',
}

export default function PickALocation({ lens, onPick }) {
  return (
    <div style={{ padding: '56px 24px', textAlign: 'center', border: T.border.dashedSoft, borderRadius: T.radius.inset, margin: '8px 0' }}>
      <div style={{ fontSize: '26px', marginBottom: '10px' }}>📍</div>
      <p style={{ fontSize: '14px', fontWeight: 600, color: T.ink.strong, marginBottom: '6px' }}>
        {PICK_COPY[lens] || PICK_COPY.clients}
      </p>
      <p style={{ fontSize: '12.5px', color: T.ink.quiet, lineHeight: 1.6, maxWidth: '400px', margin: '0 auto 16px' }}>
        You&apos;re viewing <strong>All Locations</strong>, which shows the
        cross-location picture: the home overview, unrouted leads, and search.
        Choose a location to work its records.
      </p>
      {onPick && (
        <button
          onClick={onPick}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '7px',
            height: '34px', padding: '0 16px', borderRadius: T.radius.pill,
            border: 'none', background: T.ink.primary, color: T.ink.inverse,
            fontSize: '13px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          <IconMapPin size={14} /> Choose a location
        </button>
      )}
    </div>
  )
}
