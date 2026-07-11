// components/hive/shared/SourceField.jsx
// ─────────────────────────────────────────────────────────────
// The editable Source row — ClientProfile Key Facts (card-restore
// build 1, Kevin's person-vs-deal split: source is FIRST-TOUCH,
// person-scoped — one edit home, and it's the client card; the
// engagement panel carries project type instead).
//
// Anatomy: ContactField's view row (icon · value · standard EditPencil)
// but the editor is MetaSelect's options popover (admin-managed lookup
// labels + None), not a free-text input — source is a pick, never
// prose. Composes MetaSelect via renderTrigger so the menu idiom never
// forks; empty state is the dashed 'add source'.
//
// Write path: PATCH /api/leads/:id { source } (LEAD-level, same write
// EngagementPanel's old pill used). Optimistic: the picked label shows
// immediately, reverts on failure. onSaved(cols) fires after a
// confirmed save — hosts merge + hand up through onLeadPatched.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { IconSparkles } from '@/components/ui/icons'
import MetaSelect from '../MetaSelect'
import { EditPencil } from './inlineEdit'

export default function SourceField({ leadId, value, options = [], onSaved = () => {}, setToast = () => {} }) {
  // undefined = no optimistic override in flight; null is a real value
  // (None clears the column).
  const [pending, setPending] = useState(undefined)
  const shown = pending !== undefined ? pending : (value || null)

  async function save(label) {
    setPending(label)
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: label }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `HTTP ${res.status}`)
      onSaved({ source: label })
      setToast({ kind: 'success', msg: label ? 'Source updated' : 'Source cleared' })
    } catch (e) {
      setPending(undefined) // revert to the prop value
      setToast({ kind: 'error', msg: `Save failed: ${e.message}` })
      return
    }
    setPending(undefined) // prop now carries the saved value
  }

  return (
    <MetaSelect
      label="Source"
      value={shown}
      options={options}
      onPick={save}
      renderTrigger={(toggle) => shown ? (
        <p onClick={toggle} title="Edit source"
          style={{ fontSize: '12px', color: '#1a1a18', display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0, cursor: 'pointer' }}>
          <span style={{ color: '#8a8a84', display: 'inline-flex', flexShrink: 0 }}><IconSparkles size={13} /></span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: '#8a8a84' }}>Source: </span>{shown}
          </span>
          <EditPencil />
        </p>
      ) : (
        <p onClick={toggle} style={{ fontSize: '12px', color: '#c9c7c0', display: 'flex', alignItems: 'center', gap: '7px', cursor: 'pointer' }}>
          <span style={{ display: 'inline-flex' }}><IconSparkles size={13} /></span>
          <span style={{ borderBottom: '1px dashed rgba(0,0,0,0.15)' }}>add source</span>
        </p>
      )}
    />
  )
}
