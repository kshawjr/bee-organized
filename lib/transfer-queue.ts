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

// ── (retired 20 Oct 2026) which location the zip would have matched ─────────
// zipHintFor / fetchZipHintMatches / attachZipHints gave the Needs-transfer row
// its own answer about a lead's zip ("→ Reno"), separate from the Slack card's
// suggestion. Two answers on one row was the bug; the row now shows the card's
// own suggestion (lib/route-suggestion suggestRoutesForLeads, read through
// GET /api/route-suggestions).
