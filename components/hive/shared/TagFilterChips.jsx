// components/hive/shared/TagFilterChips.jsx
// ─────────────────────────────────────────────────────────────
// The picked tag filters as removable chips, so the filter is visible
// without opening the popover. Shared by every people list (lifted from
// NetworkScreen). Renders bare chips — the host places them in its own
// chip row. §8.5: props only.
// ─────────────────────────────────────────────────────────────
'use client'

import React from 'react'
import { T } from './tokens'
import { tagText } from './tagText'

export default function TagFilterChips({ picked = [], tagById = new Map(), onRemove = () => {} }) {
  return picked.map(id => {
    const t = tagById.get(id)
    return (
      <span key={`tag-${id}`} data-active-tag={id} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 6px 4px 10px', borderRadius: T.radius.pill, background: T.accent.soft, border: `0.5px solid ${T.hairline.strong}`, fontSize: '12px', fontWeight: 500, color: T.accent.deep }}>
        {t ? tagText(t) : 'Tag'}
        <button aria-label={`Remove tag filter ${t?.label || ''}`} onClick={() => onRemove(id)}
          style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '13px', lineHeight: 1, color: T.ink.quiet, fontFamily: 'inherit', padding: '0 2px' }}>×</button>
      </span>
    )
  })
}
