// components/hive/shared/TagPickField.jsx
// ─────────────────────────────────────────────────────────────
// Tags on a CREATE form — the record doesn't exist yet, so nothing is
// written here. Picked tags show as pills; '+ Tag' opens the shared
// PickerModal over THE one tag list (category 'tags', lib/tags.ts —
// searchable, corporate + this location's own, no create). The host sends
// the ids with its create call (tagIds) and the server links them.
//
// TagsRow is the same look for a record that already exists (it writes
// each change straight away); this is its staged twin.
//
// value: [{ id, label, icon }]   onChange(next)   §8.5: props only.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { T } from './tokens'
import { pillStyle } from './cardKit'
import PickerModal from './PickerModal'
import { tagText } from './tagText'

export const MAX_CREATE_TAGS = 8   // = lib/tags.ts MAX_TAGS_PER_CREATE

export default function TagPickField({ locationId = null, value = [], onChange = () => {}, emptyHint = null }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
        {value.map(t => (
          <span key={t.id} style={pillStyle()}>
            {tagText(t)}
            <button type="button" className="bee-small-action" aria-label={`Remove tag ${t.label}`}
              onClick={() => onChange(value.filter(x => x.id !== t.id))}
              style={{ border: 'none', background: 'transparent', padding: 0, fontSize: T.badge.actionFont, lineHeight: 1, color: T.ink.quiet, cursor: 'pointer', fontFamily: 'inherit' }}>
              ✗
            </button>
          </span>
        ))}
        <button type="button" className="bee-small-action" onClick={() => setOpen(true)} aria-label="Add tag"
          style={{ ...pillStyle({ dashed: true }), cursor: 'pointer' }}>
          + Tag
        </button>
      </div>
      {value.length === 0 && emptyHint && (
        <p style={{ fontSize: '11px', color: T.ink.quiet, marginTop: '6px' }}>{emptyHint}</p>
      )}
      {open && (
        <PickerModal
          category="tags"
          locationId={locationId}
          selected={value.map(t => t.id)}
          mode="multi"
          maxSelected={MAX_CREATE_TAGS}
          showIcons
          sections
          title="Tags"
          subtitle="One list for clients and Network people"
          onSave={picked => onChange(picked.map(p => ({ id: p.id, label: p.label, icon: p.icon || null })))}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
