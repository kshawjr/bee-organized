// components/hive/shared/TagFilterSection.jsx
// ─────────────────────────────────────────────────────────────
// THE tag filter — one copy for every screen that lists people (Network,
// Everyone; Inbox and Engagements next). Lifted from NetworkScreen, not
// forked. Sits inside a FilterPopover:
//   · only tags some row on the screen carries, each with its count
//   · its own search box to narrow a long list
//   · Relationship (list order) then Trade (A–Z), as in every tag picker
//   · any-of ticks; a picked tag stays listed while a search hides the
//     rest, so it can always be unticked
// The host owns the picked ids and the rows (§8.5: props only).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useMemo, useState } from 'react'
import { T } from './tokens'
import { FilterSection, CheckRow } from './FilterPopover'
import { tagText } from './tagText'
import { tagOptionsInUse } from './tagFilter'
import { sectionTags } from '@/lib/tags'

export default function TagFilterSection({
  tags = [],          // THE one tag list [{ id, label, icon, section, sort_order }]
  rows = [],          // the screen's in-scope rows (each with tagIds)
  picked = [],        // tag ids
  onToggle = () => {},
  emptyNote = 'No one here is tagged yet — add tags from a record.',
  testId = 'tag-options',
}) {
  const [q, setQ] = useState('')
  const options = useMemo(() => tagOptionsInUse(tags, rows), [tags, rows])
  const needle = q.trim().toLowerCase()
  const shown = useMemo(
    () => options.filter(t => !needle || t.label.toLowerCase().includes(needle) || picked.includes(t.id)),
    [options, needle, picked]
  )
  // A location's own tags head their section with its name, when known.
  const ownerName = useMemo(() => options.find(t => t.location_id && t.ownerName)?.ownerName || null, [options])
  const sections = useMemo(() => sectionTags(shown, ownerName ? `${ownerName}'s own` : null), [shown, ownerName])

  return (
    <FilterSection label="Tags">
      {options.length === 0 ? (
        <p style={{ fontSize: '11px', color: T.ink.quiet }}>{emptyNote}</p>
      ) : (
        <>
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search tags…"
            aria-label="Search tags"
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', marginBottom: '6px', borderRadius: T.radius.control, border: T.border.control, background: T.surface.raised, fontSize: '12px', fontFamily: 'inherit', color: T.ink.primary, outline: 'none' }}
          />
          <div data-testid={testId} style={{ maxHeight: '220px', overflowY: 'auto' }}>
            {sections.map(sec => (
              <div key={sec.key} data-section={sec.key} style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
                <p style={{ fontSize: '10px', fontWeight: 500, color: T.ink.quiet, letterSpacing: '0.4px', textTransform: 'uppercase', margin: 0 }}>{sec.label}</p>
                {sec.rows.map(t => (
                  <CheckRow key={t.id} label={`${tagText(t)} (${t.count})`} checked={picked.includes(t.id)} onToggle={() => onToggle(t.id)} />
                ))}
              </div>
            ))}
            {shown.length === 0 && (
              <p style={{ fontSize: '11px', color: T.ink.quiet }}>No tag matches “{q.trim()}”</p>
            )}
          </div>
        </>
      )}
    </FilterSection>
  )
}
