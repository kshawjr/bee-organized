// components/hive/shared/networkGroups.js
// ─────────────────────────────────────────────────────────────
// PURE module (§8.5 — no imports but the shared tag filter) — the Network screen's brains:
// mixed-row assembly, the tag filter, and the staleness rule.
// NetworkScreen renders what THIS computes, so every counting/filtering
// decision is unit-testable without a mount.
//
// ONE FLAT LIST (tag merge, 2026-10-15 — Kevin's ruling). The specialty
// bands are gone: a person's band was their FIRST specialty, and
// specialties are now unordered tags (one list, lib/tags.ts). An owner
// sees a handful of Network people, so band headings were noise that only
// existed because there was no real filter. Now: people and companies
// together, sorted by name; the tag filter does the sorting-into-kinds,
// and matches on ANY of a person's tags (the old filter only saw the
// first specialty, so 13 multi-specialty people were invisible under
// their others).
//
// STALE: 60 days without a logged partner touchpoint
// (partners.last_contacted_at — the Phase 1 stored cache). A NULL is
// "no touchpoints logged yet", which is UNKNOWN, not stale — the column
// was born empty for everyone; treating null as cold would light the
// whole screen red on day one and mean nothing.
// ─────────────────────────────────────────────────────────────

export const STALE_DAYS = 60

const DAY_MS = 86400000

// ── staleness ────────────────────────────────────────────────
// → 'stale' | 'fresh' | 'unknown' (never contacted — see header)
export function contactRecency(lastContactedAt, nowMs, staleDays = STALE_DAYS) {
  if (!lastContactedAt) return 'unknown'
  const t = new Date(lastContactedAt).getTime()
  if (!Number.isFinite(t)) return 'unknown'
  return nowMs - t > staleDays * DAY_MS ? 'stale' : 'fresh'
}

// ── partner stage → token chip family key ────────────────────
// Semantic mapping onto the LOCKED family pairs (shared/tokens T.family)
// — the hive world never touches Classic's per-stage hexes.
export function stageFamilyKey(stage) {
  switch (stage) {
    case 'New Contact': return 'blue'
    case 'Reaching Out': return 'amber'
    case 'Building': return 'teal'
    case 'Active Partner': return 'green'
    case 'Dormant': return 'quiet'
    case 'Customer': return 'purple'
    default: return 'gray'
  }
}

// ── tag filter ───────────────────────────────────────────────
// Lifted into shared/tagFilter.js (every people list uses it); re-exported
// here so existing imports keep working.
export { matchesTags, tagOptionsInUse } from './tagFilter.js'

// A company carries no tags and no stage of its own, so under a filter it
// is judged by its PEOPLE: it shows when any person linked to it
// (companyId) passes the filter. Filtering "Realtor" shows Meridian
// Realty because Karen is a realtor there — the same people-first rule
// the retired bands used to place a company. people: the in-scope people
// ALREADY narrowed by the filter (not by the search box).
export function companiesWithMatchingPeople(companies = [], people = []) {
  const ids = new Set(people.map((p) => p?.companyId).filter(Boolean))
  return companies.filter((c) => ids.has(c.id))
}

// ── mixed-row assembly ───────────────────────────────────────
// partners/companies: live (non-deleted) mapPartnerRow/mapCompanyRow
// shapes. rollups: Map('kind:id' → { count, converted, revenue }) from
// /api/network/summary — null while loading (rows then carry rollup:null,
// which the UI renders as "—", NEVER as zero).
//
// Returns ONE list sorted by name: { rowType:'person'|'company', record,
// rollup, lastContactedAt, peopleCount? }.
export function buildNetworkRows({ partners = [], companies = [], rollups = null }) {
  const rollupFor = (kind, id) => (rollups ? rollups.get(`${kind}:${id}`) || { count: 0, converted: 0, revenue: 0 } : null)

  const peopleByCompany = new Map()
  for (const p of partners) {
    if (p?.companyId) {
      if (!peopleByCompany.has(p.companyId)) peopleByCompany.set(p.companyId, [])
      peopleByCompany.get(p.companyId).push(p)
    }
  }

  const rows = []
  for (const p of partners) {
    rows.push({
      rowType: 'person',
      record: p,
      rollup: rollupFor('partner', p.id),
      lastContactedAt: p.lastContactedAt || null,
    })
  }
  for (const c of companies) {
    const linked = peopleByCompany.get(c.id) || []
    // A company's last-talked derives from its PEOPLE — companies have no
    // touchpoint subject of their own (deliberate Phase 1 scope), and
    // "when did we last talk to anyone there" is the honest read.
    const lastTalk = linked
      .map((p) => p.lastContactedAt)
      .filter(Boolean)
      .sort()
      .pop() || null
    rows.push({
      rowType: 'company',
      record: c,
      rollup: rollupFor('company', c.id),
      lastContactedAt: lastTalk,
      peopleCount: linked.length,
    })
  }
  return rows.sort((a, b) => (a.record.name || '').localeCompare(b.record.name || '', undefined, { sensitivity: 'base' }))
}

// ── stats ────────────────────────────────────────────────────
// totals: /api/network/summary totals (null while loading → stat renders
// "—", never a fake zero). goneCold counts only KNOWN-stale people —
// null last_contacted_at is unknown, not cold (see header).
export function networkStats({ partners = [], companies = [], totals = null, nowMs }) {
  return {
    inNetwork: partners.length + companies.length,
    leadsReferred: totals ? totals.count : null,
    converted: totals ? totals.converted : null,
    revenue: totals ? totals.revenue : null,
    goneCold: partners.filter((p) => contactRecency(p.lastContactedAt, nowMs) === 'stale').length,
  }
}
