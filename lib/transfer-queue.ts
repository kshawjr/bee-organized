// lib/transfer-queue.ts
//
// The unrouted queue — leads sitting at loc_other waiting for a person to
// route them ("Corporate · Not yet routed", top of the Inbox).
//
// WHY THIS FILE EXISTS (30 Sept 2026). The queue used to load the 50 newest
// leads and nothing more. At ~30 a month that never mattered. Zip routing made
// it roughly 190 a month, so a backlog over 50 became possible — and the
// OLDEST would have dropped silently off the bottom, the ones waiting longest.
//
// Kevin's decision: do not show more at once. Show TEN at a time with a way
// forward and back, and say how many there are in total.
//
// So the two numbers are now separate, and neither is a cap on what can be
// reached:
//   · everything waiting is LOADED (paged past Supabase's 1,000-row ceiling)
//   · ten are SHOWN at a time
//
// OLDEST FIRST. It is a queue of people waiting: the one who has waited
// longest is the next one to route. It also keeps the pages still while they
// are being worked — newest-first would push every row down a place each time
// a new lead arrived.

import { LOC_OTHER_SLUG } from './hub-scope'
import { applyLeadActiveFilter } from './lead-suppression'
import { decideZipRoute, normalizeZip, type ZipLocationRow } from './zip-routing'

// Supabase returns at most 1,000 rows per response whatever .range() asks for,
// so the load walks the queue in pages of that size.
const LOAD_PAGE = 1000
// A stop so a runaway can never hang the page load: 20,000 waiting leads is
// not a queue any more. Reaching it is logged loudly by the caller.
export const TRANSFER_QUEUE_LOAD_PAGES_MAX = 20

/**
 * Every lead waiting at loc_other, oldest first. `truncated` is true only if
 * the runaway stop was reached.
 */
export async function fetchTransferQueueRows(
  sb: { from: (table: string) => any },
): Promise<{ rows: any[]; error: { message: string } | null; truncated: boolean }> {
  const rows: any[] = []
  for (let page = 0; page < TRANSFER_QUEUE_LOAD_PAGES_MAX; page++) {
    const from = page * LOAD_PAGE
    const { data, error } = await applyLeadActiveFilter(
      sb
        .from('leads')
        .select('*')
        .eq('location_id', LOC_OTHER_SLUG)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + LOAD_PAGE - 1),
    )
    if (error) return { rows, error, truncated: false }
    rows.push(...(data || []))
    if (!data || data.length < LOAD_PAGE) return { rows, error: null, truncated: false }
  }
  return { rows, error: null, truncated: true }
}

// The ten on screen: lib/transfer-queue-page.ts (kept apart because the Inbox
// is a browser component and must not pull this file's server reads with it).
export { TRANSFER_QUEUE_PAGE_SIZE, pageOfQueue, type QueuePage } from './transfer-queue-page'

// ── which location the zip would have matched ───────────────────────────────
// A lead lands at loc_other when its zip matched nobody, matched TWO locations
// (the Denver overlaps), or matched one that is not live yet. In the last two
// cases the territory list already knows who it is probably for — say so on
// the row, so nobody has to open the lead to find out where it is.

export type ZipHintMatch = {
  id: string                 // location uuid — what the transfer picker selects by
  slug: string
  name: string
  lifecycle_status: string | null
}

export type ZipHint = {
  zip: string
  // 'one' = a single location claims the zip · 'several' = a conflict ·
  // 'none' = no location has it.
  kind: 'one' | 'several' | 'none'
  matches: ZipHintMatch[]
}

/**
 * The hint for one lead. Uses decideZipRoute — the SAME rule intake routes by
 * — so the row can never suggest something intake would not have considered.
 * null when the lead has no usable zip (nothing to say).
 */
export function zipHintFor(rawZip: unknown, byZip: Map<string, ZipHintMatch[]>): ZipHint | null {
  const zip = normalizeZip(rawZip)
  if (!zip) return null
  const claimed = byZip.get(zip) || []
  const rows: ZipLocationRow[] = claimed.map((m) => ({ location_id: m.slug, lifecycle_status: m.lifecycle_status }))
  const decision = decideZipRoute(zip, rows)
  const matches = decision.candidates
    .map((slug) => claimed.find((m) => m.slug === slug))
    .filter(Boolean) as ZipHintMatch[]
  return { zip, kind: matches.length === 0 ? 'none' : matches.length === 1 ? 'one' : 'several', matches }
}

/**
 * One read for the whole queue: who claims each of these zips. Fail-soft —
 * on any error it returns null and the rows simply show no suggestion (a
 * missing hint must never look like "no location has this zip").
 */
export async function fetchZipHintMatches(
  sb: { from: (table: string) => any },
  rawZips: unknown[],
): Promise<Map<string, ZipHintMatch[]> | null> {
  const zips = Array.from(new Set(rawZips.map(normalizeZip).filter(Boolean))) as string[]
  const out = new Map<string, ZipHintMatch[]>()
  for (let i = 0; i < zips.length; i += 200) {
    const { data, error } = await sb
      .from('location_zips')
      .select('zip, location:locations!inner(id, name, location_id, lifecycle_status)')
      .in('zip', zips.slice(i, i + 200))
    if (error) {
      console.warn(`[transfer-queue] zip suggestion lookup failed: ${error.message} — rows will show no suggested location`)
      return null
    }
    for (const r of data || []) {
      const l = Array.isArray(r.location) ? r.location[0] : r.location
      if (!l || !l.location_id || l.location_id === LOC_OTHER_SLUG) continue
      const list = out.get(r.zip) || []
      if (!list.some((m) => m.slug === l.location_id)) {
        list.push({ id: l.id, slug: l.location_id, name: l.name || l.location_id, lifecycle_status: l.lifecycle_status ?? null })
      }
      out.set(r.zip, list)
    }
  }
  return out
}

/** Stamp each queued person with its zipHint (null = nothing to say). */
export function attachZipHints<P extends { originZip?: unknown }>(
  people: P[],
  byZip: Map<string, ZipHintMatch[]> | null,
): Array<P & { zipHint: ZipHint | null }> {
  return people.map((p) => ({ ...p, zipHint: byZip ? zipHintFor(p.originZip, byZip) : null }))
}
