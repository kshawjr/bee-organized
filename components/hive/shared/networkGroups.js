// components/hive/shared/networkGroups.js
// ─────────────────────────────────────────────────────────────
// PURE module (§8.5 — zero imports) — the Network screen's brains:
// band resolution, mixed-row assembly, the what's-next digest, and the
// staleness rule. NetworkScreen renders what THIS computes, so every
// grouping/counting decision is unit-testable without a mount.
//
// BANDS (approved Option C — mixed person+company rows per band):
//   · one band per SPECIALTY actually present, in the admin specialty
//     list's order (partners.specialties[] — a person's band is their
//     FIRST/primary specialty; no migration, no new field)
//   · a COMPANY's band: majority primary-specialty of its linked people,
//     else its industry slug-matched against the specialty ids, else the
//     just-met band
//   · "Potential customers" (purple) — people who may HIRE us, not refer
//     us: stage 'Customer', isCustomer, or the 'warm' (Warm Client) tag.
//     This signal WINS over specialty: the relationship's direction
//     (they buy vs. they send) matters more than their trade.
//   · "Just met · no intent yet" (gray) — no customer signal, no
//     specialty. Collected, not yet directed.
//   Special bands sit at the BOTTOM, in that order.
//
// STALE: 60 days without a logged partner touchpoint
// (partners.last_contacted_at — the Phase 1 stored cache). A NULL is
// "no touchpoints logged yet", which is UNKNOWN, not stale — the column
// was born empty for everyone; treating null as cold would light the
// whole screen red on day one and mean nothing.
// ─────────────────────────────────────────────────────────────

export const POTENTIAL_BAND = '__potential_customers'
export const JUST_MET_BAND = '__just_met'
export const STALE_DAYS = 60

const DAY_MS = 86400000

export const slugify = (s) => (s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

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

// ── band resolution ──────────────────────────────────────────
export function personBand(partner) {
  const stage = partner?.stage || ''
  const tags = partner?.tags || []
  if (stage === 'Customer' || partner?.isCustomer || tags.includes('warm')) return POTENTIAL_BAND
  const primary = (partner?.specialties || [])[0]
  return primary || JUST_MET_BAND
}

export function companyBand(company, linkedPeople = [], specialtyIds = []) {
  // Majority primary specialty of its people…
  const tally = {}
  for (const p of linkedPeople) {
    const b = personBand(p)
    if (b !== POTENTIAL_BAND && b !== JUST_MET_BAND) tally[b] = (tally[b] || 0) + 1
  }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]
  if (top) return top[0]
  // …else the industry string slug-matched against the specialty ids
  // ('Real Estate' → 'real-estate')…
  const slug = slugify(company?.industry)
  if (slug && specialtyIds.includes(slug)) return slug
  // …else it's a collected org with no direction yet.
  return JUST_MET_BAND
}

// ── mixed-row + band assembly ────────────────────────────────
// partners/companies: live (non-deleted) mapPartnerRow/mapCompanyRow
// shapes. specialties: the admin list [{ id, label }] (order = band
// order). rollups: Map('kind:id' → { count, converted, revenue }) from
// /api/network/summary — null while loading (rows then carry rollup:null,
// which the UI renders as "—", NEVER as zero).
//
// Returns ordered bands: { key, label, tone, rows, referred, revenue }.
// Band headers count LEADS REFERRED + revenue — not rows.
// Rows: { rowType:'person'|'company', record, rollup, lastContactedAt,
//         peopleCount? } sorted most-referred first, then name.
export function buildNetworkBands({ partners = [], companies = [], specialties = [], rollups = null }) {
  const specialtyIds = specialties.map((s) => s.id)
  const byBand = new Map()
  const push = (band, row) => {
    if (!byBand.has(band)) byBand.set(band, [])
    byBand.get(band).push(row)
  }
  const rollupFor = (kind, id) => (rollups ? rollups.get(`${kind}:${id}`) || { count: 0, converted: 0, revenue: 0 } : null)

  const peopleByCompany = new Map()
  for (const p of partners) {
    if (p?.companyId) {
      if (!peopleByCompany.has(p.companyId)) peopleByCompany.set(p.companyId, [])
      peopleByCompany.get(p.companyId).push(p)
    }
  }

  for (const p of partners) {
    push(personBand(p), {
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
    push(companyBand(c, linked, specialtyIds), {
      rowType: 'company',
      record: c,
      rollup: rollupFor('company', c.id),
      lastContactedAt: lastTalk,
      peopleCount: linked.length,
    })
  }

  const bandTotal = (rows, field) =>
    rollups ? rows.reduce((s, r) => s + (r.rollup?.[field] ?? 0), 0) : null

  const sortRows = (rows) => rows.sort((a, b) =>
    (b.rollup?.count ?? 0) - (a.rollup?.count ?? 0)
    || ((a.record.name || '').localeCompare(b.record.name || '')))

  const bands = []
  for (const s of specialties) {
    const rows = byBand.get(s.id)
    if (!rows?.length) continue
    bands.push({ key: s.id, label: s.label, tone: 'specialty', rows: sortRows(rows), referred: bandTotal(rows, 'count'), revenue: bandTotal(rows, 'revenue') })
  }
  // Specialty values not in the admin list (edited-away ids) still render
  // rather than silently vanishing rows.
  for (const [key, rows] of byBand) {
    if (key === POTENTIAL_BAND || key === JUST_MET_BAND) continue
    if (specialtyIds.includes(key)) continue
    bands.push({ key, label: key, tone: 'specialty', rows: sortRows(rows), referred: bandTotal(rows, 'count'), revenue: bandTotal(rows, 'revenue') })
  }
  const potential = byBand.get(POTENTIAL_BAND)
  if (potential?.length) {
    bands.push({ key: POTENTIAL_BAND, label: 'Potential customers', tone: 'potential', rows: sortRows(potential), referred: bandTotal(potential, 'count'), revenue: bandTotal(potential, 'revenue') })
  }
  const justMet = byBand.get(JUST_MET_BAND)
  if (justMet?.length) {
    bands.push({ key: JUST_MET_BAND, label: 'Just met · no intent yet', tone: 'justmet', rows: sortRows(justMet), referred: bandTotal(justMet, 'count'), revenue: bandTotal(justMet, 'revenue') })
  }
  return bands
}

// ── what's-next digest ───────────────────────────────────────
// partners.next_steps jsonb ([{id,text,date,done}]) surfaced OUTSIDE the
// record for the first time. Items: open steps with a due date. Overdue =
// strictly before today (local midnight); due-soon = today..+7d.
export function nextStepsDigest(partners = [], nowMs) {
  const today = new Date(nowMs); today.setHours(0, 0, 0, 0)
  const todayMs = today.getTime()
  const weekMs = todayMs + 7 * DAY_MS
  const overdue = []
  const dueSoon = []
  for (const p of partners) {
    for (const step of p?.nextSteps || []) {
      if (step?.done || !step?.date) continue
      const due = new Date(`${step.date}T00:00:00`).getTime()
      if (!Number.isFinite(due)) continue
      const item = { partnerId: p.id, partnerName: p.name, text: step.text, date: step.date }
      if (due < todayMs) overdue.push({ ...item, overdue: true })
      else if (due < weekMs) dueSoon.push({ ...item, overdue: false })
    }
  }
  overdue.sort((a, b) => a.date.localeCompare(b.date))
  dueSoon.sort((a, b) => a.date.localeCompare(b.date))
  return { overdue, dueSoon }
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
