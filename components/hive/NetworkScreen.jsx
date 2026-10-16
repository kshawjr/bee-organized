// components/hive/NetworkScreen.jsx
// ─────────────────────────────────────────────────────────────
// NETWORK — the referral-relationship repository (Phase 2). Replaces the
// Classic Contacts list: the last Classic screen in the nav. Beta-chunk
// module (§8.5): props only, no BeeHub imports, tokens only.
//
// STRUCTURE (approved mockups):
//   · (the "What's next" strip that sat here was retired 2026-09-30 —
//     Reminders replaced next_steps; they show on Home and the Reminders
//     page, not on this screen)
//   · stats — in network · leads referred · converted · referral revenue
//     · gone cold 60d+. Referral numbers come from /api/network/summary
//     (REAL joins, Phase 1); until it resolves they render "—", NEVER a
//     fake zero (the Home-redesign honesty rule)
//   · ONE flat list sorted by name (tag merge 2026-10-15 — the specialty
//     bands are retired, see shared/networkGroups) with MIXED rows: a
//     company is ONE row (square avatar, "N people"), a person is a row
//     (round avatar, their tags + company as subtitle). Square vs round
//     is the whole affordance — no type labels.
//   · the Tags filter — searchable, multi-pick, any-of — over THE one tag
//     list (lib/tags.ts), showing only tags someone here carries, with
//     counts. It is what the bands used to do, without the headings.
//
// DATA: partners/companies arrive as props (the SSR-loaded App state the
// Classic screen already read — location-scoped by UUID upstream, the
// Phase 1-4b model). The ONE fetch here is the bulk referral summary;
// per-referrer numbers land as rollups. partner.lastContactedAt is the
// Phase 1 stored cache (maintained only by lib/touchpoints.ts) — NULL
// means "no touchpoints logged yet" (unknown), which renders quiet, not
// red (see networkGroups header).
// ─────────────────────────────────────────────────────────────
'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { T } from './shared/tokens'
import { useStoredState } from './shared/useStoredControls'
import InitialsAvatar from './shared/InitialsAvatar'
import { HAIRLINE_BORDER } from '@/components/ui/tokens'
import { matchPeople } from './shared/clientMatch'
import {
  FilterButton, FilterPopover, FilterSection, TogglePills, CheckRow, FilteredEmpty,
} from './shared/FilterPopover'
import {
  buildNetworkRows, networkStats, contactRecency,
  stageFamilyKey, matchesTags, tagOptionsInUse, companiesWithMatchingPeople,
} from './shared/networkGroups'
import { tagText } from './shared/tagText'
import { sectionTags } from '@/lib/tags'
import { CHIP_STYLES } from './shared/stageConfig'
import PickALocation from './shared/PickALocation'

const PARTNER_STAGE_KEYS = ['New Contact', 'Reaching Out', 'Building', 'Active Partner', 'Dormant']

const fam = (key) => CHIP_STYLES[key] || CHIP_STYLES.gray

const money = (n) => `$${Math.round(n).toLocaleString()}`

const DAY_MS = 86400000
function fmtLastTalk(iso, nowMs) {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  const days = Math.floor((nowMs - t) / DAY_MS)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 60) return `${days}d ago`
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === new Date(nowMs).getFullYear() ? undefined : 'numeric' })
}

// Square = company, round = person — the ONLY type affordance (2a).
function CompanyAvatar({ name }) {
  const initials = (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'
  return (
    <div data-avatar="company" style={{ width: T.avatar.identity, height: T.avatar.identity, borderRadius: T.radius.control, background: T.brand.sage, color: T.brand.onSage, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: T.avatar.identityFont, fontWeight: 600, flexShrink: 0 }}>
      {initials}
    </div>
  )
}

function StatTile({ label, value, danger = false }) {
  return (
    <div style={{ flex: 1, minWidth: '96px', background: T.surface.raised, border: T.border.card, borderRadius: T.radius.inset, padding: '10px 12px' }}>
      <p style={{ fontSize: '18px', fontWeight: 600, color: danger ? T.state.danger.fg : T.ink.primary, letterSpacing: T.type.trackNum, fontVariantNumeric: T.type.tabular }}>{value}</p>
      <p style={{ fontSize: '10px', color: T.ink.muted, marginTop: '2px', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 500 }}>{label}</p>
    </div>
  )
}

export default function NetworkScreen({
  partners = [],
  companies = [],
  locFilter = 'all',
  tags = [],                  // THE one tag list [{ id, label, icon, key? }] — what tagIds read as
  readOnly = false,
  onOpenPerson = () => {},
  onOpenCompany = () => {},
  onAdd = () => {},           // ('partner' | 'company')
  // Fix 2 Phase 4b, extended to Network: true when the page is on 'All
  // Locations' for an elevated user, where NO partner/company rows are loaded.
  // The record list shows the shared picker prompt; the tenant-wide referral
  // rollup (the genuinely cross-location piece) stays live in the stats strip.
  // Server truth (!!initialAllOverview upstream), NOT locFilter === 'all' —
  // a franchise user's scope label must never trip it.
  locationRequired = false,
  // Opens the location switcher from inside the prompt (App owns the picker).
  onOpenLocationPicker = null,
  // True when the SSR network load hit its row ceiling — the list below is
  // incomplete, and this screen says so rather than rendering quietly short.
  truncated = false,
}) {
  const nowMs = Date.now()

  // ── scope (partners/companies carry location UUIDs — Phase 1-4b) ──
  const scopedPartners = useMemo(() => (
    (locFilter === 'all' ? partners : partners.filter(p => p.locationId === locFilter)).filter(p => !p.isDeleted)
  ), [partners, locFilter])
  const scopedCompanies = useMemo(() => (
    (locFilter === 'all' ? companies : companies.filter(c => c.locationId === locFilter)).filter(c => !c.isDeleted)
  ), [companies, locFilter])

  // ── the bulk referral summary (REAL numbers; '—' until resolved) ──
  const [summary, setSummary] = useState(null)   // { referrers, totals } | null
  const [summaryErr, setSummaryErr] = useState(null)
  useEffect(() => {
    let dead = false
    setSummary(null); setSummaryErr(null)
    const qs = locFilter && locFilter !== 'all' ? `?location_id=${encodeURIComponent(locFilter)}` : ''
    fetch(`/api/network/summary${qs}`)
      .then(async r => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`); return r.json() })
      .then(json => { if (!dead) setSummary(json) })
      .catch(e => { if (!dead) setSummaryErr(String(e?.message || e)) })
    return () => { dead = true }
  }, [locFilter])

  const rollups = useMemo(() => {
    if (!summary?.referrers) return null
    return new Map(summary.referrers.map(r => [`${r.kind}:${r.id}`, r]))
  }, [summary])

  // ── search (clientMatch — email/phone/name aware) + filters ──
  const [search, setSearch] = useState('')
  const q = search.trim().toLowerCase()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [stageFilter, setStageFilter] = useState(null)
  const [tagFilter, setTagFilter] = useState([])     // tag ids — any-of
  const [tagSearch, setTagSearch] = useState('')
  const filterCount = (stageFilter ? 1 : 0) + tagFilter.length
  const clearFilters = () => { setStageFilter(null); setTagFilter([]) }
  const toggleTag = (id) => setTagFilter(f => f.includes(id) ? f.filter(x => x !== id) : [...f, id])
  // Tags draw as their own icon + label ("🏠 Realtor", shared/tagText).
  const tagById = useMemo(() => new Map(tags.map(t => [t.id, t])), [tags])
  const tagLabel = (id) => tagById.get(id)?.label

  // Saved views — SAME store the Phase 1 persistence fix established
  // (bee_network_saved_views). Views now carry {stageFilter, tagIds}.
  // A view saved before the tag merge carried specFilter (a specialty
  // slug) — it maps onto the tag with that slug (the merge keeps slugs as
  // attrs.key), so an owner's old "Realtors" view still works.
  const [savedViewsStore, setSavedViewsStore] = useStoredState('bee_network_saved_views', { views: [], activeViewId: null })
  const applyView = (v) => {
    setStageFilter(v.filters?.stageFilter || null)
    let ids = Array.isArray(v.filters?.tagIds) ? v.filters.tagIds : []
    if (!ids.length && v.filters?.specFilter) {
      const hit = tags.find(t => t.key === v.filters.specFilter)
      if (hit) ids = [hit.id]
    }
    setTagFilter(ids)
    setSavedViewsStore(s => ({ ...s, activeViewId: v.id }))
  }
  const deleteView = (id) => setSavedViewsStore(s => ({
    views: s.views.filter(v => v.id !== id),
    activeViewId: s.activeViewId === id ? null : s.activeViewId,
  }))
  const saveView = (name) => {
    const id = `v${Date.now()}`
    setSavedViewsStore(s => ({ views: [...s.views, { id, name, filters: { stageFilter: stageFilter || '', tagIds: tagFilter } }], activeViewId: id }))
  }
  const [namingView, setNamingView] = useState(false)
  const [viewName, setViewName] = useState('')

  // People passing the filters, BEFORE the search box — the companies'
  // filter rule reads this (a company is judged by its people).
  const peopleInFilter = useMemo(() => {
    let rows = scopedPartners
    if (stageFilter) rows = rows.filter(p => p.stage === stageFilter)
    if (tagFilter.length) rows = rows.filter(p => matchesTags(p, tagFilter))
    return rows
  }, [scopedPartners, stageFilter, tagFilter])

  const filteredPartners = useMemo(() => {
    if (!q) return peopleInFilter
    const matched = new Set(matchPeople(peopleInFilter, q).map(m => m.person.id))
    return peopleInFilter.filter(p => matched.has(p.id) || (p.company || '').toLowerCase().includes(q))
  }, [peopleInFilter, q])

  // Companies carry no tags and no stage. Under a filter a company shows
  // when one of ITS people passes it (shared/networkGroups); the rest are
  // hidden, and the list says how many — a company silently vanishing
  // reads as a bug.
  const searchedCompanies = useMemo(() => (
    !q ? scopedCompanies : scopedCompanies.filter(c =>
      (c.name || '').toLowerCase().includes(q) || (c.industry || '').toLowerCase().includes(q))
  ), [scopedCompanies, q])
  const filteredCompanies = useMemo(() => (
    filterCount > 0 ? companiesWithMatchingPeople(searchedCompanies, peopleInFilter) : searchedCompanies
  ), [searchedCompanies, peopleInFilter, filterCount])
  const hiddenCompanies = searchedCompanies.length - filteredCompanies.length

  // ── the one list ──
  const rows = useMemo(
    () => buildNetworkRows({ partners: filteredPartners, companies: filteredCompanies, rollups }),
    [filteredPartners, filteredCompanies, rollups]
  )

  // The filter's options: tags someone here carries, with counts; the
  // search box narrows them. A picked tag stays listed even if a search
  // hides it, so it can always be unticked.
  const tagOptions = useMemo(() => tagOptionsInUse(tags, scopedPartners), [tags, scopedPartners])
  const tagNeedle = tagSearch.trim().toLowerCase()
  const shownTagOptions = tagOptions.filter(t => !tagNeedle || t.label.toLowerCase().includes(tagNeedle) || tagFilter.includes(t.id))
  // Relationship (list order) then Trade (A–Z), as in every tag picker.
  const shownTagSections = useMemo(() => sectionTags(shownTagOptions), [shownTagOptions])

  // ── stats ──
  const stats = useMemo(() => networkStats({ partners: scopedPartners, companies: scopedCompanies, totals: summary?.totals ?? null, nowMs }), [scopedPartners, scopedCompanies, summary]) // eslint-disable-line react-hooks/exhaustive-deps

  const rowTone = fam('teal')

  return (
    <div style={{ maxWidth: '860px', margin: '0 auto', padding: '16px 16px 80px', fontFamily: 'inherit' }}>
      <style>{`.bee-net-row:hover { border-color: ${T.hairline.strong} }`}</style>

      {/* ── header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>Network</h1>
          <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '2px' }}>
            {/* On 'all' no rows are loaded, so a count here would be a fake
                zero — name the scope instead. */}
            {locationRequired ? 'Referral totals across all locations' : `${stats.inNetwork} in your referral network`}
          </p>
        </div>
        {!readOnly && !locationRequired && (
          // ONE entry point — the merged NetworkAddSheet asks Person vs
          // Company via its own segmented toggle.
          <button onClick={() => onAdd()}
            style={{ padding: '8px 16px', borderRadius: T.radius.control, border: 'none', background: T.accent.fg, color: T.accent.onFill, fontSize: '13px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>
            + Add
          </button>
        )}
      </div>

      {/* ── truncation notice (Phase 4b) — the load hit its row ceiling ──
          A quietly short list is the silent-failure mode this effort is
          retiring: the screen renders, the network is simply missing rows,
          and nobody is told. Mirrors the Home leadsTruncated banner. */}
      {truncated && (
        <div data-testid="network-truncated" style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', background: T.state.danger.soft, border: `1px solid ${T.state.danger.fg}40`, borderRadius: T.radius.card, padding: '11px 14px', marginBottom: '14px' }}>
          <span style={{ fontSize: '15px', lineHeight: 1.2 }}>⚠️</span>
          <div>
            <p style={{ fontSize: '13px', fontWeight: 600, color: T.state.danger.fg, marginBottom: '2px' }}>Some network records weren&apos;t loaded</p>
            <p style={{ fontSize: '12px', color: T.state.danger.fg, lineHeight: 1.5 }}>
              This location has more partners or companies than a single page load
              carries, so the list below is <strong>incomplete</strong>. Nothing is
              lost — reach out so the limit can be raised.
            </p>
          </div>
        </div>
      )}

      {/* ── stats (honest numbers — '—' while the summary loads) ──
          On 'all' the two row-derived tiles (In network, Gone cold) have no
          rows to count and would render fake zeros — they are dropped, the
          same suppression posture as the shell's tab badges. The three
          summary-backed tiles stay: /api/network/summary is tenant-wide for
          an elevated caller, and cross-location referral totals are exactly
          what the corporate overview is for. */}
      <div data-testid="network-stats" style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
        {!locationRequired && <StatTile label="In network" value={stats.inNetwork} />}
        <StatTile label="Leads referred" value={stats.leadsReferred ?? '—'} />
        <StatTile label="Converted" value={stats.converted ?? '—'} />
        <StatTile label="Referral revenue" value={stats.revenue == null ? '—' : money(stats.revenue)} />
        {!locationRequired && <StatTile label="Gone cold 60d+" value={stats.goneCold} danger={stats.goneCold > 0} />}
      </div>
      {summaryErr && (
        <p style={{ fontSize: '11px', color: T.state.danger.fg, marginBottom: '12px' }}>
          Referral numbers unavailable ({summaryErr}) — the list still works.
        </p>
      )}

      {/* ── the record list asks for a location on 'all' (Phase 4b) ──
          The SAME prompt component the Inbox / Client List / Engagements use —
          never a second empty state, never a blended list. Everything below
          this point enumerates a location's records. */}
      {locationRequired ? (
        <PickALocation lens="network" onPick={onOpenLocationPicker} />
      ) : (
      <>
      {/* ── search + filters + saved views ── */}
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search people, companies, phone, email…"
          style={{ flex: 1, boxSizing: 'border-box', padding: '9px 14px', borderRadius: T.radius.control, border: `0.5px solid var(--hairline-border, ${HAIRLINE_BORDER})`, background: T.surface.raised, fontSize: '13px', fontFamily: 'inherit', color: T.ink.primary, outline: 'none' }}
        />
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <FilterButton count={filterCount} open={filtersOpen} onToggle={() => setFiltersOpen(o => !o)} />
          <FilterPopover open={filtersOpen} count={filterCount} onClear={clearFilters}>
            <FilterSection label="Stage">
              <TogglePills options={PARTNER_STAGE_KEYS.map(k => ({ key: k, label: k }))} value={stageFilter} onChange={setStageFilter} />
            </FilterSection>
            <FilterSection label="Tags">
              {tagOptions.length === 0 ? (
                <p style={{ fontSize: '11px', color: T.ink.quiet }}>No one here is tagged yet — add tags from a person's record.</p>
              ) : (
                <>
                  <input
                    value={tagSearch}
                    onChange={e => setTagSearch(e.target.value)}
                    placeholder="Search tags…"
                    aria-label="Search tags"
                    style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', marginBottom: '6px', borderRadius: T.radius.control, border: T.border.control, background: T.surface.raised, fontSize: '12px', fontFamily: 'inherit', color: T.ink.primary, outline: 'none' }}
                  />
                  <div data-testid="network-tag-options" style={{ maxHeight: '220px', overflowY: 'auto' }}>
                    {shownTagSections.map(sec => (
                      <div key={sec.key} data-section={sec.key} style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
                        <p style={{ fontSize: '10px', fontWeight: 500, color: T.ink.quiet, letterSpacing: '0.4px', textTransform: 'uppercase', margin: 0 }}>{sec.label}</p>
                        {sec.rows.map(t => (
                          <CheckRow key={t.id} label={`${tagText(t)} (${t.count})`} checked={tagFilter.includes(t.id)} onToggle={() => toggleTag(t.id)} />
                        ))}
                      </div>
                    ))}
                    {shownTagOptions.length === 0 && (
                      <p style={{ fontSize: '11px', color: T.ink.quiet }}>No tag matches “{tagSearch.trim()}”</p>
                    )}
                  </div>
                </>
              )}
            </FilterSection>
          </FilterPopover>
        </div>
      </div>

      {(savedViewsStore.views.length > 0 || filterCount > 0) && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
          {/* The picked tags, removable — the filter is visible without
              opening the popover. */}
          {tagFilter.map(id => (
            <span key={`tag-${id}`} data-active-tag={id} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '4px 6px 4px 10px', borderRadius: T.radius.pill, background: T.accent.soft, border: `0.5px solid ${T.hairline.strong}`, fontSize: '12px', fontWeight: 500, color: T.accent.deep }}>
              {tagById.has(id) ? tagText(tagById.get(id)) : 'Tag'}
              <button aria-label={`Remove tag filter ${tagLabel(id) || ''}`} onClick={() => toggleTag(id)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: '13px', lineHeight: 1, color: T.ink.quiet, fontFamily: 'inherit', padding: '0 2px' }}>×</button>
            </span>
          ))}
          {savedViewsStore.views.map(v => {
            const active = savedViewsStore.activeViewId === v.id
            return (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center', borderRadius: T.radius.pill, overflow: 'hidden', border: active ? `0.5px solid ${T.hairline.strong}` : T.border.thin, background: active ? T.accent.soft : T.surface.raised }}>
                <button onClick={() => applyView(v)} style={{ padding: '4px 8px 4px 12px', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px', fontWeight: 500, color: active ? T.accent.deep : T.ink.secondary }}>
                  {v.name}
                </button>
                <button aria-label={`Delete view ${v.name}`} onClick={() => deleteView(v.id)} style={{ padding: '4px 8px 4px 2px', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: T.ink.quiet, lineHeight: 1, fontFamily: 'inherit' }}>×</button>
              </div>
            )
          })}
          {filterCount > 0 && !namingView && (
            <button onClick={() => setNamingView(true)} style={{ padding: '4px 12px', borderRadius: T.radius.pill, background: T.accent.faint, border: T.border.dashed, cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px', color: T.ink.secondary, fontWeight: 500 }}>
              + Save view
            </button>
          )}
          {namingView && (
            <span style={{ display: 'inline-flex', gap: '6px' }}>
              <input autoFocus value={viewName} onChange={e => setViewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && viewName.trim()) { saveView(viewName.trim()); setViewName(''); setNamingView(false) } if (e.key === 'Escape') { setNamingView(false); setViewName('') } }}
                placeholder="View name"
                style={{ padding: '4px 10px', border: T.border.control, borderRadius: T.radius.control, fontSize: '12px', fontFamily: 'inherit', color: T.ink.primary, outline: 'none' }} />
              <button disabled={!viewName.trim()} onClick={() => { saveView(viewName.trim()); setViewName(''); setNamingView(false) }}
                style={{ padding: '4px 10px', borderRadius: T.radius.control, border: 'none', background: viewName.trim() ? T.accent.fg : T.surface.sunken, color: viewName.trim() ? T.accent.onFill : T.ink.disabled, fontSize: '12px', fontWeight: 500, cursor: viewName.trim() ? 'pointer' : 'not-allowed', fontFamily: 'inherit' }}>Save</button>
            </span>
          )}
        </div>
      )}

      {/* ── the one list ── */}
      {rows.length === 0 && (
        filterCount > 0
          ? <FilteredEmpty count={filterCount} onClear={clearFilters} noun="network records" />
          : (
            <div style={{ padding: '40px 20px', textAlign: 'center', background: T.surface.raised, border: T.border.card, borderRadius: T.radius.card }}>
              <p style={{ fontSize: '14px', fontWeight: 600, color: T.ink.primary, marginBottom: '4px' }}>
                {q ? 'No one matches that search' : 'Your network starts here'}
              </p>
              <p style={{ fontSize: '12px', color: T.ink.quiet }}>
                {q ? 'Try a name, company, phone, or email' : 'Add the realtors, senior-living communities, and companies who send you work'}
              </p>
            </div>
          )
      )}

      {hiddenCompanies > 0 && (
        <p data-testid="network-companies-hidden" style={{ fontSize: '11px', color: T.ink.quiet, margin: '0 2px 8px' }}>
          {hiddenCompanies} {hiddenCompanies === 1 ? 'company' : 'companies'} hidden — companies don’t have tags or a stage of their own, so one shows only when someone who works there matches.
        </p>
      )}
      <div data-testid="network-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {rows.map(row => {
          const rec = row.record
          const isCompany = row.rowType === 'company'
          const recency = contactRecency(row.lastContactedAt, nowMs)
          const talk = fmtLastTalk(row.lastContactedAt, nowMs)
          const stage = !isCompany && rec.stage ? rec.stage : null
          const stageFam = stage ? fam(stageFamilyKey(stage)) : null
          return (
            <div key={`${row.rowType}-${rec.id}`} className="bee-net-row" data-rowtype={row.rowType}
              onClick={() => (isCompany ? onOpenCompany(rec) : onOpenPerson(rec))}
              style={{ display: 'flex', alignItems: 'center', gap: '12px', background: T.surface.raised, border: T.border.thin, borderRadius: T.radius.inset, padding: '11px 14px', cursor: 'pointer', transition: 'border-color 0.15s' }}>
              {isCompany
                ? <CompanyAvatar name={rec.name} />
                : <InitialsAvatar name={rec.name} bg={rowTone.bg} text={rowTone.text} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                  <p title={rec.name} style={{ fontSize: '14px', fontWeight: 600, color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rec.name}</p>
                  {stage && (
                    <span data-stage-chip style={{ fontSize: T.badge.font, fontWeight: T.badge.weight, color: stageFam.text, background: stageFam.bg, borderRadius: T.radius.chip, padding: '2px 8px', whiteSpace: 'nowrap', flexShrink: 0 }}>{stage}</span>
                  )}
                </div>
                <p style={{ fontSize: '11px', color: T.ink.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '1px' }}>
                  {isCompany
                    ? `${row.peopleCount} ${row.peopleCount === 1 ? 'person' : 'people'}${rec.industry ? ` · ${rec.industry}` : ''}`
                    : [(rec.tagIds || []).map(id => tagById.get(id)).filter(Boolean).map(tagText).join(', '), rec.title, rec.company].filter(Boolean).join(' · ') || '—'}
                </p>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <p style={{ fontSize: '12px', fontWeight: 500, color: T.ink.primary, fontVariantNumeric: T.type.tabular }}>
                  {row.rollup == null
                    ? '—'
                    : `${row.rollup.count} referred${row.rollup.revenue > 0 ? ` · ${money(row.rollup.revenue)}` : ''}`}
                </p>
                <p data-recency={recency} style={{ fontSize: '11px', marginTop: '1px', color: recency === 'stale' ? T.state.danger.fg : T.ink.quiet, fontWeight: recency === 'stale' ? 500 : 400 }}>
                  {talk ? `talked ${talk}` : 'no touchpoints yet'}
                </p>
              </div>
            </div>
          )
        })}
      </div>
      </>
      )}
    </div>
  )
}
