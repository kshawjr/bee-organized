// components/hive/shared/LoadMore.jsx — the dashed load-more button
// shared by the List's closed archive and the Clients directory pager.
// One markup so the two surfaces can't drift; border rides the shared
// --hairline-border token.
'use client'

import React from 'react'
import { HAIRLINE_BORDER, TEXT_MUTED } from '@/components/ui/tokens'
import { T } from './tokens'

export default function LoadMore({ pageSize, remaining, onClick }) {
  return (
    <button onClick={onClick}
      style={{ width: '100%', marginTop: '10px', padding: '9px', background: 'transparent', border: `0.5px dashed var(--hairline-border, ${HAIRLINE_BORDER})`, borderRadius: T.radius.inset, fontSize: '12px', color: `var(--text-muted, ${TEXT_MUTED})`, cursor: 'pointer', fontFamily: 'inherit' }}>
      Load {Math.min(pageSize, remaining)} more of {remaining}
    </button>
  )
}
