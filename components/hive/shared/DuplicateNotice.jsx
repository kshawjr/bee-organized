// components/hive/shared/DuplicateNotice.jsx
// ─────────────────────────────────────────────────────────────
// "This may be a copy of …" — the client card's notice for a record that
// carries leads.possible_duplicate_of. The profile route resolves the stored
// ids to { id, name, state } (shared/duplicateFlag.js); this only draws them.
//
//   ok   — the name, as a link that opens that record
//   junk — the name, still a link, marked "in the bin"
//   gone — deleted, another location's, or the lookup failed: said
//          plainly ("no longer available" is true of all three), no link
//
// Every id is shown, in stored order. Nothing renders when the list is empty.
// §8.5: pure presentational, props only.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { T } from './tokens'
import { IconAlertTriangle } from '@/components/ui/icons'

export default function DuplicateNotice({ items = [], onOpen = () => {} }) {
  const list = Array.isArray(items) ? items.filter(x => x && x.id) : []
  if (!list.length) return null
  const one = list.length === 1
  return (
    <div role="note" aria-label="Possible duplicate" data-testid="duplicate-notice"
      style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', background: T.state.warning.soft, borderRadius: T.radius.control, padding: '10px 12px' }}>
      <span style={{ color: T.state.warning.fg, display: 'inline-flex', flexShrink: 0, marginTop: '1px' }}><IconAlertTriangle size={15} /></span>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <p style={{ fontSize: '13px', fontWeight: 500, color: T.state.warning.deep }}>
          {one ? 'This may be a copy of another client' : `This may be a copy of ${list.length} other clients`}
        </p>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {list.map(d => (
            <li key={d.id} data-testid="duplicate-notice-item" style={{ fontSize: '12px', color: T.ink.secondary }}>
              {d.state === 'gone'
                ? <span>A record that's no longer available</span>
                : (
                  <>
                    <button type="button" onClick={() => onOpen(d.id)}
                      style={{ border: 'none', background: 'transparent', padding: 0, font: 'inherit', fontSize: '12px', color: T.accent.deep, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '2px' }}>
                      {d.name}
                    </button>
                    {d.state === 'junk' && <span style={{ color: T.ink.muted }}> · in the bin</span>}
                  </>
                )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
