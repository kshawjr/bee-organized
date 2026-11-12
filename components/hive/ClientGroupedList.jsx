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
//
// SEARCH REACHES EVERY CLIENT (Clients at scale, slice 1 — 2026-11-12). The
// page load stops at 5,000 clients, so at Philadelphia Suburbs (18,931) a
// search of `people` alone could not find 13,931 of them. With a term in the
// box the list ALSO asks GET /api/clients/search and adds the hits it does
// not already hold. Two rules keep that honest:
//   · the browser filter below is untouched and still answers first, so a
//     search can never show FEWER rows than it did before this change — the
//     server only ever adds.
//   · a server hit arrives in the page load's own Person shape and goes
//     through the SAME deriveClientStatus call as a loaded row, so it lands in
//     its real band. Nothing here assigns a band by hand.
// An empty box asks nothing and renders exactly as before.
// The tag FILTER is still a filter over rows in hand: loaded clients plus
// whatever the search brought in. When the load was cut short the screen says
// so rather than letting a short tag list pass for the whole location.
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useState, useMemo, useEffect, useRef } from 'react'
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

// How long the box waits after the last keystroke before asking the server.
export const CLIENT_SEARCH_DEBOUNCE_MS = 250
const NO_REMOTE = { term: null, people: [], total: 0, capped: false, loading: false, failed: false }

// Mirrors lib/client-search cleanClientSearchTerm — what the server will
// actually search for, so a reply can be matched to the box that asked.
const serverTerm = (raw) => (raw || '').replace(/\*/g, ' ').trim().slice(0, 80)

export default function ClientGroupedList({ people = [], engagements = [], locFilter = 'all', onOpenClient = () => {}, locations = [], tags = [], initialTagId = null, onInitialTagConsumed = () => {}, leadsTruncated = false, searchLocationId = null }) {
  const [search, setSearch] = useState('')
  const [remote, setRemote] = useState(NO_REMOTE)
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
  // THE BROWSER FILTER — unchanged, and never replaced by the server's answer.
  const localVisible = classified.filter(({ p }) =>
    matchesTags(p, tagFilter) && (!q
      || (p.name || '').toLowerCase().includes(q)
      || (p.email || '').toLowerCase().includes(q)
      || (p.phone || '').toLowerCase().includes(q)
      || !!matchesTagSearch(p, q, tagById)))

  // ── the server half ────────────────────────────────────────────────────
  // When the page load was cut short, everything NEWER than the oldest loaded
  // client is already in `scoped`; the server is asked only for that date and
  // older, so its cap is spent on the clients this screen cannot see.
  const term = serverTerm(search)
  const olderThan = useMemo(() => {
    if (!leadsTruncated) return null
    let min = null
    for (const p of scoped) if (p.created && (min === null || p.created < min)) min = p.created
    return min
  }, [leadsTruncated, scoped])
  const reqSeq = useRef(0)
  useEffect(() => {
    if (!term) { setRemote(NO_REMOTE); return }
    const seq = ++reqSeq.current
    setRemote(r => ({ ...r, loading: true, failed: false }))
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: term })
        if (searchLocationId) params.set('location', searchLocationId)
        if (olderThan) params.set('olderThan', olderThan)
        const res = await fetch(`/api/clients/search?${params.toString()}`, { credentials: 'include' })
        if (!res.ok) throw new Error(String(res.status))
        const json = await res.json()
        if (seq !== reqSeq.current) return
        setRemote({ term, people: Array.isArray(json.people) ? json.people : [], total: Number(json.total) || 0, capped: !!json.capped, loading: false, failed: false })
      } catch (e) {
        // The loaded rows still show — but SAY the rest was not searched.
        if (seq === reqSeq.current) setRemote({ ...NO_REMOTE, term, failed: true })
      }
    }, CLIENT_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [term, searchLocationId, olderThan])

  // A reply only counts for the term it answered. Hits the page already holds
  // are dropped (the loaded row is the live one); the rest are classified by
  // the SAME derivation as every loaded row, then pass the same tag filter.
  const remoteCurrent = remote.term === term && !!term
  const loadedIds = useMemo(() => new Set(scoped.map(p => p.id)), [scoped])
  const remoteExtra = useMemo(() => {
    if (!remoteCurrent) return []
    return remote.people
      .filter(p => p && p.id && !loadedIds.has(p.id))
      .map(p => ({ p, status: deriveClientStatus(p, openClientIds, nowMs, wonClientIds) }))
  }, [remoteCurrent, remote.people, loadedIds, openClientIds, wonClientIds]) // eslint-disable-line react-hooks/exhaustive-deps
  const visible = remoteExtra.length
    ? [...localVisible, ...remoteExtra.filter(({ p }) => matchesTags(p, tagFilter))]
    : localVisible
  const searching = !!term && (remote.loading || !remoteCurrent) && !remote.failed
  const searchFailed = !!term && remote.failed
  const searchCapped = remoteCurrent && remote.capped

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

      {/* What the search did and did not cover — said, never implied. */}
      {searchFailed && (
        <p role="alert" data-testid="clients-search-failed" style={{ margin: '0 2px 10px', fontSize: '12px', lineHeight: 1.4, color: T.ink.primary }}>
          Couldn't search all your clients just now. These are only matches from the clients already on this screen — try again in a moment.
        </p>
      )}
      {searchCapped && (
        <p role="status" data-testid="clients-search-capped" style={{ margin: '0 2px 10px', fontSize: '12px', lineHeight: 1.4, color: T.ink.muted }}>
          {olderThan
            ? `Showing the newest ${remote.people.length.toLocaleString()} of ${remote.total.toLocaleString()} older clients that match.`
            : `Showing the newest ${remote.people.length.toLocaleString()} of ${remote.total.toLocaleString()} clients that match.`}
          {' '}Type more of the name, email or phone to narrow it down.
          {tagFilter.length > 0 ? ' Your tag filter only narrows the ones shown.' : ''}
        </p>
      )}
      {leadsTruncated && tagFilter.length > 0 && !term && (
        <p role="status" data-testid="clients-tagfilter-partial" style={{ margin: '0 2px 10px', fontSize: '12px', lineHeight: 1.4, color: T.ink.muted }}>
          Tag filters only look through your newest {scoped.length.toLocaleString()} clients. To find anyone older, type in the search box.
        </p>
      )}

      {totalShown === 0 && (
        searching
          ? (
            <div data-testid="clients-search-loading" style={{ padding: '32px', textAlign: 'center', color: T.ink.quiet, fontSize: '12px' }}>
              Searching all your clients…
            </div>
          )
          : tagFilter.length > 0
          ? <FilteredEmpty count={tagFilter.length} onClear={() => setTagFilter([])} noun="clients" />
          : (
            <div style={{ padding: '32px', textAlign: 'center', color: T.ink.quiet, fontSize: '12px' }}>
              {q ? 'No clients match that search' : 'No clients in this view'}
            </div>
          )
      )}
      {totalShown > 0 && searching && (
        <p role="status" data-testid="clients-search-loading" style={{ margin: '0 2px 10px', fontSize: '12px', color: T.ink.quiet }}>
          Searching all your clients…
        </p>
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
