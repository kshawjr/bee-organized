// components/hive/ClientGroupedList.jsx
// ─────────────────────────────────────────────────────────────
// HIVE — the Client List lens (nav restructure 2026-07-18), the grouped
// color-band presentation (approved mockup). Clients grouped by STATUS
// (New · Attempting · Nurturing · Active · Client · Past client · No
// contact), each group a tinted band whose colored header carries a status
// dot + label + count, with the client rows on white cards inside.
//
// COLLAPSIBLE (2026-07-19): every status band toggles its rows. Groups start
// COLLAPSED and each remembers its own last choice — persisted per status id
// under one keyed store (bee_hive_clients_collapsed, SSR-safe via
// useStoredState, SEPARATE from Engagements' memory). A collapsed group
// renders only its header. An active search or tag filter force-expands every
// band so matches are never hidden behind a collapsed header.
//
// TAGS (2026-10-15): the SAME tag filter the Network tab has
// (shared/TagFilterSection + TagFilterChips — one copy, not a fork), over
// each client's tagIds, and the search box also matches tag names ("realtor"
// finds clients tagged Realtor). A row's tags show beside its location, so a
// tag match is visible, not a mystery.
//
// SAME data, SAME source as the directory — NOT a divergent lens:
//   · status + its color come from shared/clientStatus (deriveClientStatus
//     + CLIENT_STATUS_META) mapped through CHIP_STYLES — the one status
//     color source the directory chips already read.
//   · the row avatar is tinted to the group color (InitialsAvatar with the
//     family's bg/text), name + location beside it.
//   · a row click opens the SAME ClientProfile the directory opens
//     (onOpenClient), threaded up through HiveShell.
//
// PER-GROUP CARD NAV (issue 134, Ankur): a row click hands its GROUP's displayed
// row ids (the A-Z-within-band order on screen) as the profile's siblings,
// so the card's ‹ › chevrons page card-to-card WITHIN the status band and
// stop at its ends. Group-scoped on purpose — bands collapse independently,
// so walking across a boundary would land inside a band that isn't open.
// Siblings must always be the DISPLAYED order: an earlier build passed the
// raw filtered order and the chevrons walked a different sequence than the
// screen showed.
//   · location names resolve from the `locations` roster already loaded for
//     the app switcher — no new query.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useMemo, useEffect } from 'react'
import { CHIP_STYLES, CLOSED_WON, isTerminal } from './shared/stageConfig'
import { T } from './shared/tokens'
import { deriveClientStatus, CLIENT_STATUS_ORDER, CLIENT_STATUS_META } from './shared/clientStatus'
import { HAIRLINE_BORDER } from '@/components/ui/tokens'
import { IconChevronRight } from '@/components/ui/icons'
import InitialsAvatar from './shared/InitialsAvatar'
import { useStoredState } from './shared/useStoredControls'
import { FilterButton, FilterPopover, FilteredEmpty } from './shared/FilterPopover'
import TagFilterSection from './shared/TagFilterSection'
import TagFilterChips from './shared/TagFilterChips'
import { matchesTags, matchesTagSearch } from './shared/tagFilter'
import { tagText } from './shared/tagText'

// A small filled dot in the status's dark stop — sourced from CHIP_STYLES
// (the same status color source the directory chip reads), never a literal.
function StatusDot({ color }) {
  return <span aria-hidden style={{ width: '9px', height: '9px', borderRadius: T.radius.round, background: color, display: 'inline-block', flexShrink: 0 }} />
}

// issue 207 — one plain-language line under each status name. Owners (45-65,
// non-technical) read a big Nurturing count off a fresh Jobber import as a pile
// of neglected people; a muted sub-line says what each band actually means. Copy
// is deliberately job-state, not import-provenance: Nurturing is the residual
// "everyone else" bucket (settled-lost per issue 187, aged leads, unconverted
// imports, organic never-booked), so its share coming from the import is entirely
// location-dependent and NOT reliably the majority — "no job on the go right now"
// is the one clause honest for every location. Keyed by the same status keys as
// CLIENT_STATUS_META; every renderable band has a line so none reads as unlabelled.
const STATUS_DEFS = {
  New:        "Just arrived, and nobody's reached out yet. They're in your Inbox.",
  Attempting: "You've reached out, but nothing's booked yet. Also in your Inbox.",
  Nurturing:  'No job on the go right now — worth staying in touch with.',
  Active:     'Working with them now — a request, assessment, quote or job under way. The same people as your Engagements board.',
  Client:     "You've finished and been paid for work. They can come back for more any time.",
  Past:       "You've been paid for work together before.",
  no_contact: "No email or phone on file, so there's no way to reach out.",
}

export default function ClientGroupedList({ people = [], engagements = [], locFilter = 'all', onOpenClient = () => {}, locations = [], tags = [], initialTagId = null, onInitialTagConsumed = () => {} }) {
  const [search, setSearch] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [tagFilter, setTagFilter] = useState([])     // tag ids — any-of
  const toggleTag = (id) => setTagFilter(f => f.includes(id) ? f.filter(x => x !== id) : [...f, id])
  const tagById = useMemo(() => new Map(tags.map(t => [t.id, t])), [tags])
  // ⌘K's "All N clients tagged …" line: open with exactly this tag ticked.
  useEffect(() => {
    if (!initialTagId) return
    setTagFilter([initialTagId]); setSearch('')
    onInitialTagConsumed()
  }, [initialTagId]) // eslint-disable-line react-hooks/exhaustive-deps
  const nowMs = Date.now()

  // Per-group collapse memory — one keyed store, statusKey → true when
  // EXPANDED. Absent = collapsed, so first visit is all-collapsed. Its own
  // key, independent of the Engagements list's collapse memory.
  const [expandedMap, setExpandedMap] = useStoredState('bee_hive_clients_collapsed', {})
  const toggle = (gid) => setExpandedMap(prev => ({ ...prev, [gid]: !prev[gid] }))

  const scoped = useMemo(() => (
    locFilter === 'all' ? people : people.filter(p => p.locationId === locFilter)
  ), [people, locFilter])

  // Open / won client-id sets — same derivation inputs the directory uses,
  // so a just-closed engagement leaves the open set and a just-won one flips
  // its person to Client without a reload.
  const openClientIds = useMemo(() => {
    const s = new Set()
    for (const e of engagements) if (!isTerminal(e.stage)) s.add(e.client_id)
    return s
  }, [engagements])
  const wonClientIds = useMemo(() => new Set(
    engagements.filter(e => e.stage === CLOSED_WON).map(e => e.client_id)
  ), [engagements])

  const locName = (id) => (locations.find(l => l.id === id) || {}).name || null

  // Classify once, then filter. Grouping is by STATUS (present on the shape
  // via the shared derivation) — search is name/email/phone/tag name, the
  // tag filter is any-of over the picked tags.
  const classified = useMemo(() => scoped.map(p => ({
    p, status: deriveClientStatus(p, openClientIds, nowMs, wonClientIds),
  })), [scoped, openClientIds, wonClientIds]) // eslint-disable-line react-hooks/exhaustive-deps

  const q = search.trim().toLowerCase()
  const visible = classified.filter(({ p }) =>
    matchesTags(p, tagFilter) && (!q
      || (p.name || '').toLowerCase().includes(q)
      || (p.email || '').toLowerCase().includes(q)
      || (p.phone || '').toLowerCase().includes(q)
      || !!matchesTagSearch(p, q, tagById)))

  // Bucket into status → rows, name-sorted within each group.
  const groups = useMemo(() => {
    const by = new Map()
    for (const cs of visible) {
      if (!by.has(cs.status)) by.set(cs.status, [])
      by.get(cs.status).push(cs.p)
    }
    for (const arr of by.values()) arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    return by
  }, [visible])

  // A search reveals its matches regardless of the saved collapse state.
  const isExpanded = (gid) => (q || tagFilter.length ? true : expandedMap[gid] === true)
  const totalShown = visible.length

  return (
    <div>
      <style>{`.bee-grp-row:hover { border-color:${T.hairline.strong} }`}</style>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: tagFilter.length ? '8px' : '12px' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, email, phone, tag…"
          aria-label="Search clients"
          style={{
            flex: 1, boxSizing: 'border-box',
            padding: '9px 14px', borderRadius: T.radius.control,
            border: `0.5px solid var(--hairline-border, ${HAIRLINE_BORDER})`, background: T.surface.raised,
            fontSize: '13px', fontFamily: 'inherit', color: T.ink.primary, outline: 'none',
          }}
        />
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <FilterButton count={tagFilter.length} open={filtersOpen} onToggle={() => setFiltersOpen(o => !o)} />
          <FilterPopover open={filtersOpen} count={tagFilter.length} onClear={() => setTagFilter([])}>
            <TagFilterSection tags={tags} rows={scoped} picked={tagFilter} onToggle={toggleTag}
              emptyNote="No one here is tagged yet — add tags from a client's record." testId="clients-tag-options" />
          </FilterPopover>
        </div>
      </div>

      {tagFilter.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
          <TagFilterChips picked={tagFilter} tagById={tagById} onRemove={toggleTag} />
        </div>
      )}

      {totalShown === 0 && (
        tagFilter.length > 0
          ? <FilteredEmpty count={tagFilter.length} onClear={() => setTagFilter([])} noun="clients" />
          : (
            <div style={{ padding: '32px', textAlign: 'center', color: T.ink.quiet, fontSize: '12px' }}>
              {q ? 'No clients match that search' : 'No clients in this view'}
            </div>
          )
      )}

      {CLIENT_STATUS_ORDER.map(statusKey => {
        const rows = groups.get(statusKey)
        if (!rows || rows.length === 0) return null
        const meta = CLIENT_STATUS_META[statusKey]
        const fam = CHIP_STYLES[meta.styleKey] || CHIP_STYLES.gray
        const expanded = isExpanded(statusKey)
        return (
          <div key={statusKey} style={{ background: fam.bg, borderRadius: T.radius.card, padding: '10px 10px 12px', marginBottom: '12px' }}>
            <div
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              aria-label={`${meta.label} group`}
              onClick={() => toggle(statusKey)}
              onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(statusKey) } }}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 4px', cursor: 'pointer' }}
            >
              <StatusDot color={fam.text} />
              <span style={{ fontSize: '13px', fontWeight: 600, color: fam.text, whiteSpace: 'nowrap' }}>{meta.label}</span>
              <span style={{ fontSize: '12px', fontWeight: 500, color: fam.text, opacity: 0.7, fontVariantNumeric: T.type.tabular }}>· {rows.length}</span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', color: fam.text }}>
                <IconChevronRight size={14} style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
              </span>
            </div>
            {/* issue 207 — the status definition, a sibling of the header (NOT inside
                the role=button, so it stays out of the button's aria-label and a
                screen reader can still read it). In the group's own colour, muted via
                opacity — fam.text is the band's dark stop from CHIP_STYLES, so no raw
                hex. Indented 21px to sit under the label (4px header pad + 9px dot +
                8px gap). 11.5px: STATIC descriptive text, not a focusable input, so the
                16px iOS zoom-floor doesn't apply — 11.5px matches the muted secondary
                scale already used in this tree. Rendered whether the band is collapsed
                (the default) or open, so it explains the count owners are most lost on. */}
            {STATUS_DEFS[statusKey] && (
              <p style={{ margin: '3px 4px 8px 21px', fontSize: '11.5px', lineHeight: 1.4, color: fam.text, opacity: 0.72 }}>
                {STATUS_DEFS[statusKey]}
              </p>
            )}
            {expanded && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {rows.map(p => {
                  const loc = locName(p.locationId)
                  // Location, then the client's tags — so a tag match shows why.
                  const sub = [loc, (p.tagIds || []).map(id => tagById.get(id)).filter(Boolean).map(tagText).join(', ')].filter(Boolean).join(' · ')
                  return (
                    <div key={p.id} className="bee-grp-row" onClick={() => onOpenClient(p.id, rows.map(r => r.id))}
                      style={{ display: 'flex', alignItems: 'center', gap: '12px', background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.inset, padding: '11px 14px', cursor: 'pointer', transition: 'border-color 0.15s' }}>
                      <InitialsAvatar name={p.name} bg={fam.bg} text={fam.text} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p title={p.name} style={{ fontSize: '14px', fontWeight: 600, color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</p>
                        {sub && <p title={sub} style={{ fontSize: '11px', color: T.ink.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '1px' }}>{sub}</p>}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
