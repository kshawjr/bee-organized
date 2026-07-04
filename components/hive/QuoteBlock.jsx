// components/hive/QuoteBlock.jsx
// ─────────────────────────────────────────────────────────────
// Indented quote block for request descriptions (webform text) — shown
// under the panel's Request record row and on ClientProfile for
// pre-Jobber people. ~2-line clamp with 'Show more' expanding in place.
// Beta chunk only (imported by EngagementPanel / ClientProfile).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'

export default function QuoteBlock({ text, indent = 0 }) {
  const [expanded, setExpanded] = useState(false)
  const t = (text || '').trim()
  if (!t) return null
  const clampLikely = t.length > 120 || t.includes('\n')
  return (
    <div style={{ marginLeft: indent, padding: '4px 0 4px 10px', borderLeft: '2px solid #ECEAE4' }}>
      <p style={{
        fontSize: '12px', color: '#6b6b66', lineHeight: 1.45, whiteSpace: 'pre-wrap',
        ...(expanded ? {} : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
      }}>
        {t}
      </p>
      {clampLikely && !expanded && (
        <button onClick={(e) => { e.stopPropagation(); setExpanded(true) }}
          style={{ border: 'none', background: 'transparent', padding: 0, marginTop: '2px', fontSize: '11px', color: '#8a8a84', cursor: 'pointer', fontFamily: 'inherit' }}>
          Show more
        </button>
      )}
    </div>
  )
}
