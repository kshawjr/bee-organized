// lib/route-suggestion.ts
// ─────────────────────────────────────────────────────────────
// What the Slack card for a lead in Other should say (stage 3 of the route
// suggestion, 20 Oct 2026). Nothing here posts, transfers or emails: it
// returns the card's content, and a person presses the button.
//
// KEVIN'S DESIGN (decided, not to re-open):
//   • the THREE closest hives, each its own button with its miles on it
//   • "Leave in Other" on every card
//   • "Not in our service area" ONLY when a distance was actually measured
//     and the nearest hive is more than 75 miles away. Never for a lead we
//     simply can't place (no zip, unreadable zip, a zip the Census lacks, no
//     hive that takes leads): we don't know they're out of area. The button
//     sends the existing no_coverage_optin email and closes the lead
//     (app/api/leads/[id]/no-coverage); this file only says whether it
//     belongs on the card.
//   • when the two closest are within a few miles of each other, highlight
//     NEITHER — never auto-pick
//   • a lead whose zip IS claimed is certain, not a guess: the claimant, no
//     distance
//
// TWO NUMBERS THAT ARE OURS, named so they can be changed in one place:
//   • NEAR_TIE_MILES = 5. "Within a few miles" — the closest is highlighted
//     only when the next one is MORE than 5 miles further (gap measured to the
//     tenth of a mile). Riverside 92503: South Orange County 17.3, Temecula
//     17.9 → neither. Kevin said "a few"; 5 is ours, change it here.
//   • Miles are compared as SHOWN (rounded to whole miles) for the 75-mile
//     rule, so a card never says "75 mi" next to "Not in our service area".
//
// WHICH HIVES MAY BE SUGGESTED. The ones a zip may route a lead to
// (lib/zip-routing locationTakesZipLeads: active and onboarding). A paused
// location is read-only, so a lead moved there could not be worked; it is
// skipped and the next one moves up.
//
// A HIGHLIGHT IS ALSO WITHHELD when the closest is past 75 miles: nobody near
// is a natural fit, and a lit-up button 160 miles away reads as advice.
// ─────────────────────────────────────────────────────────────

import { supabaseService } from '@/lib/supabase-service'
import { ZIP_FALLBACK_SLUG, locationTakesZipLeads } from '@/lib/zip-routing'
import {
  nearestLocationsForZips,
  type ProximityResult,
  type ClaimingLocation,
  type StateCheck,
} from '@/lib/zip-proximity'

export const SUGGESTION_COUNT = 3
export const OUT_OF_AREA_MILES = 75
export const NEAR_TIE_MILES = 5

export type SuggestionOption = {
  slug: string
  name: string
  lifecycle_status: string | null
  // Whole miles as the button shows them; null for a claimed zip (no
  // distance involved).
  miles: number | null
  // The button text, e.g. "Lincoln · 19 mi" or "Reno" for a claimant.
  label: string
  highlighted: boolean
}

export type SuggestionKind =
  | 'claimed'          // the zip is on a location's list — certain
  | 'nearby'           // the three closest, by distance
  | 'no_zip'           // the lead gave none — nothing to measure
  | 'unreadable_zip'   // not five digits (a typo, a foreign postcode)
  | 'unknown_zip'      // five digits the Census doesn't carry (PO box, 11111)

export type RouteSuggestion = {
  leadId: string
  kind: SuggestionKind
  zip: string | null
  options: SuggestionOption[]
  // slug of the one highlighted option, or null — never more than one.
  highlight: string | null
  // Why nothing is highlighted, when nothing is and there are options.
  noHighlightReason: 'near_tie' | 'too_far' | 'conflict' | null
  showNotInServiceArea: boolean
  showLeaveInOther: true
  // The lead's state disagrees with its zip — the card should say so, since
  // one of the two is a typo and the distances follow the zip.
  stateWarning: { leadState: string; zip: string } | null
  // Locations skipped because they don't take leads (paused).
  skipped: string[]
}

export type SuggestionLead = {
  id: string
  zip: string | null
  state: string | null
}

const milesLabel = (m: number): string => (m < 1 ? '<1 mi' : `${m} mi`)

export function buildRouteSuggestion(lead: SuggestionLead, proximity: ProximityResult): RouteSuggestion {
  const base = {
    leadId: lead.id,
    showLeaveInOther: true as const,
    skipped: [] as string[],
  }

  if (proximity.status === 'missing' || proximity.status === 'malformed') {
    return {
      ...base,
      kind: proximity.status === 'missing' ? 'no_zip' : 'unreadable_zip',
      zip: null,
      options: [],
      highlight: null,
      noHighlightReason: null,
      showNotInServiceArea: false,
      stateWarning: null,
    }
  }

  const claimants = proximity.claimedBy.filter((c) => c.slug !== ZIP_FALLBACK_SLUG)

  // ── Claimed: certain, no distance ─────────────────────────────
  // Even when the zip has no Census point: who claims it needs no map.
  if (claimants.length > 0) {
    const certain = claimants.length === 1
    return {
      ...base,
      kind: 'claimed',
      zip: proximity.zip,
      options: claimants.map((c: ClaimingLocation) => ({
        slug: c.slug,
        name: c.name,
        lifecycle_status: c.lifecycle_status,
        miles: null,
        label: c.name,
        highlighted: certain,
      })),
      highlight: certain ? claimants[0].slug : null,
      // Two claimants is a conflict corporate hasn't settled: both shown,
      // neither picked.
      noHighlightReason: certain ? null : 'conflict',
      showNotInServiceArea: false,
      stateWarning: proximity.status === 'ok' ? stateWarningFor(proximity.stateCheck, proximity.leadState, proximity.zip) : null,
    }
  }

  if (proximity.status === 'unknown_zip') {
    return {
      ...base,
      kind: 'unknown_zip',
      zip: proximity.zip,
      options: [],
      highlight: null,
      noHighlightReason: null,
      showNotInServiceArea: false,
      stateWarning: null,
    }
  }

  // ── Nearby: the three closest that take leads ─────────────────
  const skipped: string[] = []
  const takers = proximity.nearest.filter((n) => {
    if (n.slug === ZIP_FALLBACK_SLUG) return false
    if (!locationTakesZipLeads(n.lifecycle_status)) { skipped.push(n.slug); return false }
    return true
  })
  const top = takers.slice(0, SUGGESTION_COUNT)
  const rounded = top.map((n) => Math.round(n.miles))
  const tooFar = top.length > 0 && rounded[0] > OUT_OF_AREA_MILES
  // The gap is compared to the tenth of a mile, so floating-point noise (a
  // 5-mile gap computing as 5.0000001) never decides a highlight.
  const nearTie = top.length > 1 && Math.round((top[1].miles - top[0].miles) * 10) / 10 <= NEAR_TIE_MILES
  const highlight = top.length > 0 && !tooFar && !nearTie ? top[0].slug : null

  return {
    ...base,
    skipped,
    kind: 'nearby',
    zip: proximity.zip,
    options: top.map((n, i) => ({
      slug: n.slug,
      name: n.name,
      lifecycle_status: n.lifecycle_status,
      miles: rounded[i],
      label: `${n.name} · ${milesLabel(rounded[i])}`,
      highlighted: n.slug === highlight,
    })),
    highlight,
    noHighlightReason: top.length === 0 || highlight ? null : tooFar ? 'too_far' : 'near_tie',
    // ONLY a measured distance past 75 miles (Kevin, 20 Oct 2026). With no
    // hive to measure to — every candidate paused, or no zip to measure from —
    // we don't know the customer is out of area, only that we can't place
    // them, and that email would tell someone two miles away we don't serve
    // them. tooFar is false whenever top is empty.
    showNotInServiceArea: tooFar,
    stateWarning: stateWarningFor(proximity.stateCheck, proximity.leadState, proximity.zip),
  }
}

function stateWarningFor(check: StateCheck, leadState: string | null, zip: string): RouteSuggestion['stateWarning'] {
  return check === 'mismatch' && leadState ? { leadState, zip } : null
}

// ── the live call ─────────────────────────────────────────────
// ONE function for every surface (Kevin, 20 Oct 2026): the Slack card
// (suggestRouteForLead, below) and Bee Hub's Needs-transfer row
// (GET /api/route-suggestions) both read suggestRoutesForLeads, so the two can
// never give different answers. It reads the leads, then the map ONCE for all
// of them (lib/zip-proximity nearestLocationsForZips), then builds each card
// with buildRouteSuggestion.
//
// A lead not in Other gets null — the suggestion is for Leslie's queue only,
// and a lead with a home would need a reason to move (lib/lead-transfer-rule).
// It reads more than three nearest so that skipping a paused location still
// leaves three to show. Throws on a failed read rather than suggesting from
// half a picture.
export const SUGGESTION_READ_LIMIT = 60

export async function suggestRoutesForLeads(leadIds: string[]): Promise<Map<string, RouteSuggestion | null>> {
  const out = new Map<string, RouteSuggestion | null>()
  const ids = Array.from(new Set(leadIds.filter(Boolean)))
  if (ids.length === 0) return out
  const { data, error } = await supabaseService
    .from('leads')
    .select('id, zip, state, location_id')
    .in('id', ids)
  if (error) throw new Error(`lead read failed: ${error.message}`)
  const leads = ((data as any[]) || []).filter((l) => l.location_id === ZIP_FALLBACK_SLUG)
  const found = new Set(((data as any[]) || []).map((l) => l.id))
  for (const id of ids) if (!found.has(id) || !leads.some((l) => l.id === id)) out.set(id, null)
  if (leads.length === 0) return out
  const proximity = await nearestLocationsForZips(leads.map((l) => ({ zip: l.zip, state: l.state })), SUGGESTION_READ_LIMIT)
  leads.forEach((l, i) => {
    out.set(l.id, buildRouteSuggestion({ id: l.id, zip: l.zip ?? null, state: l.state ?? null }, proximity[i]))
  })
  return out
}

// The Slack card's call: one lead, through the same function. Refuses — with a
// reason — a lead that doesn't exist or isn't in Other.
export async function suggestRouteForLead(leadId: string): Promise<RouteSuggestion> {
  const { data: lead, error } = await supabaseService
    .from('leads')
    .select('id, location_id')
    .eq('id', leadId)
    .maybeSingle()
  if (error) throw new Error(`lead read failed: ${error.message}`)
  if (!lead) throw new Error(`lead ${leadId} not found`)
  if (lead.location_id !== ZIP_FALLBACK_SLUG) {
    throw new Error(`lead ${leadId} is not in Other (it is at ${lead.location_id}) — no suggestion`)
  }
  const s = (await suggestRoutesForLeads([leadId])).get(leadId)
  if (!s) throw new Error(`lead ${leadId} is not in Other — no suggestion`)
  return s
}
