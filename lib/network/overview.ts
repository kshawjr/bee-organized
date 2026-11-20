// lib/network/overview.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture slice 9 — THE CORPORATE OVERVIEW: how every location uses
// Network, one row each. From the design's Corporate.tsx, on real data.
// Pure: the route reads, this counts.
//
// Kevin, 2026-11-20: the useful part is which locations have not started and
// who has a backlog of untyped ("Not sure yet") contacts. So the table leads
// with those, and the order puts locations with a backlog first.
//
// What a row counts, all from what is stored today:
//   contacts     live partners rows (deleted_at empty) at the location
//   partners     contacts whose types include Referral partner
//   notSure      contacts with no type decided (lib/network/types normalizeTypes)
//   goneQuiet    Referral partners at stage "Gone quiet"
//   referred     leads a Network contact sent (leads.referred_by_kind 'partner')
//   won, revenue those leads' Closed Won cards and total paid, through the same
//                lib/referral-rollup the Network list and record use
// Test Location and the transfer queue (loc_test, loc_other) are left out,
// as everywhere else in Nurturing.
// ─────────────────────────────────────────────────────────────

import { normalizeTypes, type NetType } from './types'
import { rollupReferredLeads, type ReferralEngagementRow } from '../referral-rollup'
import { NURTURING_EXCLUDED_LOCATIONS } from './nurturing'

export type OverviewLocation = { id: string; name: string | null; slug: string | null }
export type OverviewContact = { location_id: string | null; network_types: string[] | null; partner_stage: string | null }
export type OverviewReferred = { id: string; name: string | null; created_at: string | null; location_uuid: string | null }

export type OverviewRow = {
  id: string; name: string
  contacts: number; partners: number; notSure: number; goneQuiet: number
  referred: number; won: number; revenue: number
  started: boolean
}

export function buildOverview(args: {
  locations: OverviewLocation[]
  contacts: OverviewContact[]
  referred: OverviewReferred[]
  engagements: ReferralEngagementRow[]
}) {
  const rows = new Map<string, OverviewRow>()
  for (const l of args.locations) {
    if (l.slug && NURTURING_EXCLUDED_LOCATIONS.includes(l.slug)) continue
    rows.set(l.id, { id: l.id, name: l.name || 'Unnamed location', contacts: 0, partners: 0, notSure: 0, goneQuiet: 0, referred: 0, won: 0, revenue: 0, started: false })
  }
  for (const c of args.contacts) {
    const r = c.location_id ? rows.get(c.location_id) : null
    if (!r) continue
    const types: NetType[] = normalizeTypes(c.network_types)
    r.contacts++
    r.started = true
    if (types.includes('partner')) {
      r.partners++
      if (c.partner_stage === 'Gone quiet') r.goneQuiet++
    }
    if (types.length === 1 && types[0] === 'unsure') r.notSure++
  }
  const rolled = rollupReferredLeads(args.referred, args.engagements)
  const where = new Map(args.referred.map((l) => [l.id, l.location_uuid]))
  for (const x of rolled) {
    const r = rows.get(where.get(x.id) || '')
    if (!r) continue
    r.referred++
    if (x.converted) r.won++
    r.revenue += x.revenue
  }
  const list = Array.from(rows.values()).sort((a, b) =>
    b.notSure - a.notSure || b.contacts - a.contacts || a.name.localeCompare(b.name))
  const totals = list.reduce((t, r) => ({
    locations: t.locations + 1, started: t.started + (r.started ? 1 : 0), contacts: t.contacts + r.contacts,
    partners: t.partners + r.partners, notSure: t.notSure + r.notSure, goneQuiet: t.goneQuiet + r.goneQuiet,
    referred: t.referred + r.referred, won: t.won + r.won, revenue: t.revenue + r.revenue,
  }), { locations: 0, started: 0, contacts: 0, partners: 0, notSure: 0, goneQuiet: 0, referred: 0, won: 0, revenue: 0 })
  return { rows: list, totals, notStarted: list.filter((r) => !r.started).map((r) => r.name) }
}
