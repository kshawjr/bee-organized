// components/hive/EngagementFilters.jsx — the work-lens filter control
// (button + popover), shared by EngagementBoard and EngagementList over
// ONE filter state owned by HiveShell (single instance + one storage
// key, so the lenses and the open-count can never disagree; switching
// lenses mid-triage keeps the subset).
'use client'

import React, { useState, useMemo } from 'react'
import { ENGAGEMENT_STAGES } from './shared/stageConfig'
import { deriveStatusChip, engagementFilterCount } from './shared/engagementStatus'
import { FilterButton, FilterPopover, FilterSection, CheckRow, TogglePills, SortRows } from './shared/FilterPopover'

const OPEN_STAGES = ENGAGEMENT_STAGES.filter(s => !s.terminal)

// Display labels for status options (keys = deriveStatusChip styleKeys
// actually present in the loaded rows — dead options never show).
export const STATUS_LABELS = {
  'Request': 'requested', amber: 'requested (stale)',
  sent: 'sent', approved: 'approved', changes_requested: 'changes requested',
  scheduled: 'scheduled', in_progress: 'in progress', upcoming: 'upcoming',
  owing: 'owing', never_invoiced: 'never invoiced', paid: 'paid', nurturing: 'nurturing',
}

export default function EngagementFilters({ engagements = [], filters, setFilters, onClear, nowMs = Date.now(), sortValue = null, sortOptions = null, onSortChange = null }) {
  const [open, setOpen] = useState(false)
  const count = engagementFilterCount(filters)

  const statusOptions = useMemo(() => {
    const present = new Set()
    for (const e of engagements) {
      const k = deriveStatusChip(e, { nowMs })?.styleKey
      if (k && STATUS_LABELS[k]) present.add(k)
    }
    return Object.keys(STATUS_LABELS).filter(k => present.has(k))
  }, [engagements]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleIn = (key, value) => setFilters(f => ({
    ...f,
    [key]: f[key].includes(value) ? f[key].filter(v => v !== value) : [...f[key], value],
  }))

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <FilterButton count={count} open={open} onToggle={() => setOpen(v => !v)} label={sortOptions ? 'Filter & sort' : 'Filters'} />
      <FilterPopover open={open} count={count} onClear={onClear}>
        {sortOptions && (
          <FilterSection label="Sort">
            <SortRows value={sortValue} onChange={onSortChange} options={sortOptions} />
          </FilterSection>
        )}
        <FilterSection label="Stage">
          {OPEN_STAGES.map(s => (
            <CheckRow key={s.key} label={s.displayLabel} checked={filters.stages.includes(s.key)} onToggle={() => toggleIn('stages', s.key)} />
          ))}
        </FilterSection>
        {statusOptions.length > 0 && (
          <FilterSection label="Status">
            {statusOptions.map(k => (
              <CheckRow key={k} label={STATUS_LABELS[k]} checked={filters.statuses.includes(k)} onToggle={() => toggleIn('statuses', k)} />
            ))}
          </FilterSection>
        )}
        <FilterSection label="Value">
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#8a8a84' }}>
            $
            <input type="number" min="0" placeholder="min" value={filters.min} onChange={e => setFilters(f => ({ ...f, min: e.target.value }))}
              style={{ flex: 1, minWidth: 0, padding: '5px 8px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none' }} />
            –
            <input type="number" min="0" placeholder="max" value={filters.max} onChange={e => setFilters(f => ({ ...f, max: e.target.value }))}
              style={{ flex: 1, minWidth: 0, padding: '5px 8px', border: '0.5px solid rgba(0,0,0,0.15)', borderRadius: '8px', fontSize: '12px', fontFamily: 'inherit', outline: 'none' }} />
          </div>
        </FilterSection>
        <FilterSection label="Activity">
          <TogglePills prefix="Quiet" value={filters.age}
            options={[{ key: 7, label: '>7d' }, { key: 30, label: '>30d' }, { key: 90, label: '>90d' }]}
            onChange={(v) => setFilters(f => ({ ...f, age: v }))} />
        </FilterSection>
        <FilterSection label="More">
          <CheckRow label="Has owing" checked={filters.owing} onToggle={() => setFilters(f => ({ ...f, owing: !f.owing }))} />
          <CheckRow label="Repeat clients only" checked={filters.repeat} onToggle={() => setFilters(f => ({ ...f, repeat: !f.repeat }))} />
          <CheckRow label="New clients only" checked={filters.fresh} onToggle={() => setFilters(f => ({ ...f, fresh: !f.fresh }))} />
        </FilterSection>
        <FilterSection label="Founded by">
          {['request', 'quote', 'job', 'manual'].map(k => (
            <CheckRow key={k} label={k} checked={filters.foundedBy.includes(k)} onToggle={() => toggleIn('foundedBy', k)} />
          ))}
        </FilterSection>
      </FilterPopover>
    </div>
  )
}
