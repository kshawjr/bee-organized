// components/hive/shared/TagsRow.jsx
// ─────────────────────────────────────────────────────────────
// Tag pills + the '+ Tag' entry — THE one tags UI (ClientProfile left
// column and, step 2B, the Network person record — never a second
// build).
//
// Tag system step 2A: the old inline checklist popover is replaced by
// the shared PickerModal. Since the tag merge (2026-10-15, lib/tags.ts)
// both kinds pick from THE one tag list (category 'tags' — corporate +
// the location's own, searchable) and nobody creates from here: tags are
// corporate-only, added on the Configure tab. The modal only PICKS;
// every junction write goes through the kind's route:
//   kind 'client'  → /api/lead-tags     (lead_id,    lead_tags)
//   kind 'partner' → /api/partner-tags  (partner_id, partner_tags)
// Save diffs the picked set against the current tags and applies each
// change with the same honest semantics the per-toggle popover had:
// each confirmed write updates the host immediately (onChange), and a
// failure mid-way throws back into the modal (which stays open showing
// the error) without lying about the writes that did land.
//
// Each pill keeps its quiet × for direct removal outside the modal.
// Host owns the tags array ([{ id, label, icon }]) — a pill reads
// "🏠 Realtor" (tagText: the tag's own icon, if it has one). §8.5: props only.
// recordId is the junction's record key; leadId is kept as an alias for
// the pre-2B client call sites.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState } from 'react'
import { T } from './tokens'
import { MicroLabel, pillStyle } from './cardKit'
import PickerModal from './PickerModal'
import { tagText } from './tagText'

const KINDS = {
  client: { api: '/api/lead-tags', idParam: 'lead_id' },
  partner: { api: '/api/partner-tags', idParam: 'partner_id' },
}

export default function TagsRow({ leadId = null, recordId = null, kind = 'client', locationId = null, tags = [], onChange = () => {}, setToast = () => {}, readOnly = false }) {
  const [open, setOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const k = KINDS[kind] || KINDS.client
  const id = recordId ?? leadId

  async function removeTag(t) {
    if (busyId) return
    setBusyId(t.id)
    try {
      const res = await fetch(`${k.api}?${k.idParam}=${encodeURIComponent(id)}&tag_lookup_id=${encodeURIComponent(t.id)}`, { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      onChange(tags.filter(x => x.id !== t.id))
      setToast({ kind: 'success', msg: `Removed ${t.label}` })
    } catch (e) {
      setToast({ kind: 'error', msg: `Tag remove failed: ${e.message}` })
    } finally { setBusyId(null) }
  }

  // PickerModal onSave — apply the diff through the junction routes.
  // Sequential on purpose: each success lands in the host before the
  // next write, so a mid-way failure leaves the UI truthful.
  async function saveSelection(picked) {
    let current = tags
    const pickedIds = new Set(picked.map(p => p.id))
    const currentIds = new Set(current.map(t => t.id))
    let changed = 0
    for (const p of picked) {
      if (currentIds.has(p.id)) continue
      const res = await fetch(k.api, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [k.idParam]: id, tag_lookup_id: p.id }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      current = [...current, { id: p.id, label: p.label, icon: p.icon || null }]
      onChange(current)
      changed++
    }
    for (const t of tags) {
      if (pickedIds.has(t.id)) continue
      const res = await fetch(`${k.api}?${k.idParam}=${encodeURIComponent(id)}&tag_lookup_id=${encodeURIComponent(t.id)}`, { method: 'DELETE' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`)
      current = current.filter(x => x.id !== t.id)
      onChange(current)
      changed++
    }
    if (changed > 0) setToast({ kind: 'success', msg: 'Tags updated' })
  }

  return (
    <div>
      <MicroLabel>Tags</MicroLabel>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
        {tags.map(t => (
          <span key={t.id} style={pillStyle()}>
            {tagText(t)}
            {!readOnly && (
              <button className="bee-small-action" aria-label={`Remove tag ${t.label}`} disabled={busyId === t.id}
                onClick={() => removeTag(t)}
                style={{ border: 'none', background: 'transparent', padding: 0, fontSize: T.badge.actionFont, lineHeight: 1, color: T.ink.quiet, cursor: 'pointer', fontFamily: 'inherit' }}>
                ✗
              </button>
            )}
          </span>
        ))}
        {tags.length === 0 && <span style={{ fontSize: '11px', color: T.ink.quiet }}>No tags</span>}
        {!readOnly && (
          <button className="bee-small-action" onClick={() => setOpen(true)} aria-label="Add tag"
            style={{ ...pillStyle({ dashed: true }), cursor: 'pointer' }}>
            + Tag
          </button>
        )}
      </div>
      {open && (
        <PickerModal
          category="tags"
          locationId={locationId}
          selected={tags.map(t => t.id)}
          mode="multi"
          showIcons
          title="Tags"
          subtitle="One list for clients and Network people"
          onSave={saveSelection}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
