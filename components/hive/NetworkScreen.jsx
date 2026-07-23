// components/hive/NetworkScreen.jsx
// ─────────────────────────────────────────────────────────────
// NETWORK — the referral-relationship repository (Phase 2). Replaces the
// Classic Contacts list: the last Classic screen in the nav. Beta-chunk
// module (§8.5): props only, no BeeHub imports, tokens only.
//
// STRUCTURE (approved mockups):
//   · "What's next" strip — partners.next_steps surfaced OUTSIDE the
//     record for the first time: overdue (danger) + due-this-week, each
//     item opens its record
//   · stats — in network · leads referred · converted · referral revenue
//     · gone cold 60d+. Referral numbers come from /api/network/summary
//     (REAL joins, Phase 1); until it resolves they render "—", NEVER a
//     fake zero (the Home-redesign honesty rule)
//   · bands by SPECIALTY (shared/networkGroups) with MIXED rows — Option
//     C: a company is ONE row (square avatar, "N people"), a person is a
//     row (round avatar, company as subtitle). Square vs round is the
//     whole affordance — no type labels.
//   · two special bands at the bottom: Potential customers (purple),
//     Just met · no intent yet (gray)
//
// The grouped-band chrome is the ClientGroupedList idiom (collapse
// memory under its OWN key, search force-expands, InitialsAvatar, tinted
// band + white rows) — shared pieces reused, not forked.
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
import { IconChevronRight } from '@/components/ui/icons'
import { HAIRLINE_BORDER } from '@/components/ui/tokens'
import { matchPeople } from './shared/clientMatch'
import {
  FilterButton, FilterPopover, FilterSection, TogglePills, FilteredEmpty,
} from './shared/FilterPopover'
import {
  buildNetworkBands, nextStepsDigest, networkStats, contactRecency,
  stageFamilyKey, POTENTIAL_BAND, JUST_MET_BAND,
} from './shared/networkGroups'
import { CHIP_STYLES } from './shared/stageConfig'

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
  specialties = [],           // admin list [{ id, label }] — band vocabulary + order
  readOnly = false,
  onOpenPerson = () => {},
  onOpenCompany = () => {},
  onAdd = () => {},           // ('partner' | 'company')
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
  const [specFilter, setSpecFilter] = useState(null)
  const filterCount = [stageFilter, specFilter].filter(Boolean).length

  // Saved views — SAME store the Phase 1 persistence fix established
  // (bee_network_saved_views). Legacy Classic views carried
  // {stageFilter, tierFilter, specFilter, tagFilter}; stage + specialty
  // still apply, the two retired filters are ignored.
  const [savedViewsStore, setSavedViewsStore] = useStoredState('bee_network_saved_views', { views: [], activeViewId: null })
  const applyView = (v) => {
    setStageFilter(v.filters?.stageFilter || null)
    setSpecFilter(v.filters?.specFilter || null)
    setSavedViewsStore(s => ({ ...s, activeViewId: v.id }))
  }
  const deleteView = (id) => setSavedViewsStore(s => ({
    views: s.views.filter(v => v.id !== id),
    activeViewId: s.activeViewId === id ? null : s.activeViewId,
  }))
  const saveView = (name) => {
    const id = `v${Date.now()}`
    setSavedViewsStore(s => ({ views: [...s.views, { id, name, filters: { stageFilter: stageFilter || '', specFilter: specFilter || '' } }], activeViewId: id }))
  }
  const [namingView, setNamingView] = useState(false)
  const [viewName, setViewName] = useState('')

  const filteredPartners = useMemo(() => {
    let rows = scopedPartners
    if (stageFilter) rows = rows.filter(p => p.stage === stageFilter)
    if (specFilter) rows = rows.filter(p => (p.specialties || [])[0] === specFilter)
    if (!q) return rows
    const matched = new Set(matchPeople(rows, q).map(m => m.person.id))
    return rows.filter(p => matched.has(p.id) || (p.company || '').toLowerCase().includes(q))
  }, [scopedPartners, q, stageFilter, specFilter])

  const filteredCompanies = useMemo(() => {
    let rows = scopedCompanies
    if (stageFilter) return []  // companies carry no pipeline stage
    if (specFilter) rows = rows  // spec filter resolves at band level below
    if (!q) return rows
    return rows.filter(c =>
      (c.name || '').toLowerCase().includes(q) || (c.industry || '').toLowerCase().includes(q))
  }, [scopedCompanies, q, stageFilter])

  // ── bands ──
  const bands = useMemo(() => {
    const all = buildNetworkBands({ partners: filteredPartners, companies: filteredCompanies, specialties, rollups })
    return specFilter ? all.filter(b => b.key === specFilter) : all
  }, [filteredPartners, filteredCompanies, specialties, rollups, specFilter])

  // Collapse memory — its OWN key; a search force-expands (the
  // ClientGroupedList contract).
  const [expandedMap, setExpandedMap] = useStoredState('bee_network_bands_collapsed', {})
  const toggleBand = (key) => setExpandedMap(prev => ({ ...prev, [key]: !prev[key] }))
  const isExpanded = (key) => (q || filterCount > 0 ? true : expandedMap[key] === true)

  // ── what's-next + stats ──
  const digest = useMemo(() => nextStepsDigest(scopedPartners, nowMs), [scopedPartners]) // eslint-disable-line react-hooks/exhaustive-deps
  const stats = useMemo(() => networkStats({ partners: scopedPartners, companies: scopedCompanies, totals: summary?.totals ?? null, nowMs }), [scopedPartners, scopedCompanies, summary]) // eslint-disable-line react-hooks/exhaustive-deps
  const partnerById = useMemo(() => new Map(scopedPartners.map(p => [p.id, p])), [scopedPartners])

  const bandTone = (band) =>
    band.tone === 'potential' ? fam('purple') : band.tone === 'justmet' ? fam('quiet') : fam('teal')

  const strip = [...digest.overdue, ...digest.dueSoon]
  const STRIP_MAX = 6

  return (
    <div style={{ maxWidth: '860px', margin: '0 auto', padding: '16px 16px 80px', fontFamily: 'inherit' }}>
      <style>{`.bee-net-row:hover { border-color: ${T.hairline.strong} }`}</style>

      {/* ── header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 600, color: T.ink.primary, letterSpacing: T.type.trackTitle }}>Network</h1>
          <p style={{ fontSize: '12px', color: T.ink.muted, marginTop: '2px' }}>
            {stats.inNetwork} in your referral network
          </p>
        </div>
        {!readOnly && (
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={() => onAdd('partner')}
              style={{ padding: '8px 14px', borderRadius: T.radius.control, border: 'none', background: T.accent.fg, color: T.accent.onFill, fontSize: '13px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>
              + Add person
            </button>
            <button onClick={() => onAdd('company')}
              style={{ padding: '8px 14px', borderRadius: T.radius.control, border: T.border.control, background: T.surface.raised, color: T.ink.primary, fontSize: '13px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' }}>
              + Add company
            </button>
          </div>
        )}
      </div>

      {/* ── "What's next" strip (next_steps, surfaced at last) ── */}
      {strip.length > 0 && (
        <div data-testid="whats-next" style={{ background: T.surface.raised, border: T.border.card, borderRadius: T.radius.card, boxShadow: T.shadow.card, padding: '12px 14px', marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600, color: T.ink.primary }}>What’s next</span>
            {digest.overdue.length > 0 && (
              <span style={{ fontSize: '11px', fontWeight: 500, color: T.state.danger.fg, background: T.state.danger.soft, borderRadius: T.radius.pill, padding: '2px 9px', fontVariantNumeric: T.type.tabular }}>
                {digest.overdue.length} overdue
              </span>
            )}
            {digest.dueSoon.length > 0 && (
              <span style={{ fontSize: '11px', fontWeight: 500, color: T.ink.muted, background: T.surface.sunken, borderRadius: T.radius.pill, padding: '2px 9px', fontVariantNumeric: T.type.tabular }}>
                {digest.dueSoon.length} this week
              </span>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {strip.slice(0, STRIP_MAX).map((item, i) => (
              <button key={`${item.partnerId}-${i}`}
                onClick={() => { const p = partnerById.get(item.partnerId); if (p) onOpenPerson(p) }}
                style={{ display: 'flex', alignItems: 'baseline', gap: '8px', border: 'none', background: 'transparent', padding: '3px 0', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                <span style={{ fontSize: '11px', fontWeight: 500, color: item.overdue ? T.state.danger.fg : T.ink.muted, flexShrink: 0, fontVariantNumeric: T.type.tabular }}>
                  {item.overdue ? 'overdue' : item.date.slice(5).replace('-', '/')}
                </span>
                <span style={{ fontSize: '12px', color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.text}</span>
                <span style={{ fontSize: '11px', color: T.ink.quiet, flexShrink: 0 }}>· {item.partnerName}</span>
              </button>
            ))}
            {strip.length > STRIP_MAX && (
              <p style={{ fontSize: '11px', color: T.ink.quiet, paddingTop: '2px' }}>+ {strip.length - STRIP_MAX} more inside the records</p>
            )}
          </div>
        </div>
      )}

      {/* ── stats (honest numbers — '—' while the summary loads) ── */}
      <div data-testid="network-stats" style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
        <StatTile label="In network" value={stats.inNetwork} />
        <StatTile label="Leads referred" value={stats.leadsReferred ?? '—'} />
        <StatTile label="Converted" value={stats.converted ?? '—'} />
        <StatTile label="Referral revenue" value={stats.revenue == null ? '—' : money(stats.revenue)} />
        <StatTile label="Gone cold 60d+" value={stats.goneCold} danger={stats.goneCold > 0} />
      </div>
      {summaryErr && (
        <p style={{ fontSize: '11px', color: T.state.danger.fg, marginBottom: '12px' }}>
          Referral numbers unavailable ({summaryErr}) — the list still works.
        </p>
      )}

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
          <FilterPopover open={filtersOpen} count={filterCount} onClear={() => { setStageFilter(null); setSpecFilter(null) }}>
            <FilterSection label="Stage">
              <TogglePills options={PARTNER_STAGE_KEYS.map(k => ({ key: k, label: k }))} value={stageFilter} onChange={setStageFilter} />
            </FilterSection>
            <FilterSection label="Specialty">
              <TogglePills options={specialties.map(s => ({ key: s.id, label: s.label }))} value={specFilter} onChange={setSpecFilter} />
            </FilterSection>
          </FilterPopover>
        </div>
      </div>

      {(savedViewsStore.views.length > 0 || filterCount > 0) && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
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

      {/* ── the bands ── */}
      {bands.length === 0 && (
        filterCount > 0
          ? <FilteredEmpty count={filterCount} onClear={() => { setStageFilter(null); setSpecFilter(null) }} noun="network records" />
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

      {bands.map(band => {
        const tone = bandTone(band)
        const expanded = isExpanded(band.key)
        return (
          <div key={band.key} data-band={band.key} style={{ background: tone.bg, borderRadius: T.radius.card, padding: '10px 10px 12px', marginBottom: '12px' }}>
            <div
              role="button" tabIndex={0} aria-expanded={expanded} aria-label={`${band.label} group`}
              onClick={() => toggleBand(band.key)}
              onKeyDown={ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleBand(band.key) } }}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 4px 8px', cursor: 'pointer' }}>
              <span aria-hidden style={{ width: '9px', height: '9px', borderRadius: T.radius.round, background: tone.text, display: 'inline-block', flexShrink: 0 }} />
              <span style={{ fontSize: '13px', fontWeight: 600, color: tone.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{band.label}</span>
              {/* Header counts LEADS REFERRED + revenue — not rows (2b). */}
              <span style={{ fontSize: '12px', fontWeight: 500, color: tone.text, opacity: 0.75, whiteSpace: 'nowrap', fontVariantNumeric: T.type.tabular }}>
                {band.referred == null ? '· —' : `· ${band.referred} lead${band.referred === 1 ? '' : 's'} referred${band.revenue > 0 ? ` · ${money(band.revenue)}` : ''}`}
              </span>
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', color: tone.text }}>
                <IconChevronRight size={14} style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
              </span>
            </div>
            {expanded && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {band.rows.map(row => {
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
                        : <InitialsAvatar name={rec.name} bg={tone.bg} text={tone.text} />}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                          <p style={{ fontSize: '14px', fontWeight: 600, color: T.ink.primary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{rec.name}</p>
                          {stage && (
                            <span data-stage-chip style={{ fontSize: T.badge.font, fontWeight: T.badge.weight, color: stageFam.text, background: stageFam.bg, borderRadius: T.radius.chip, padding: '2px 8px', whiteSpace: 'nowrap', flexShrink: 0 }}>{stage}</span>
                          )}
                        </div>
                        <p style={{ fontSize: '11px', color: T.ink.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '1px' }}>
                          {isCompany
                            ? `${row.peopleCount} ${row.peopleCount === 1 ? 'person' : 'people'}${rec.industry ? ` · ${rec.industry}` : ''}`
                            : [rec.title, rec.company].filter(Boolean).join(' · ') || rec.relationship || '—'}
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
            )}
          </div>
        )
      })}
    </div>
  )
}
