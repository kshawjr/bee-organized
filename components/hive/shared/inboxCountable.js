// components/hive/shared/inboxCountable.js
// ─────────────────────────────────────────────────────────────
// PURE module — the SINGLE "does this lead count for the Inbox?" test,
// shared by the two derivations that must agree on the same number:
//   · the Inbox nav badge (HiveShell) — New+Attempting in scope
//   · the "N hidden by filters" strip (InboxScreen) — the leads the badge
//     counts but a VIEW filter is keeping off the list
//
// #89 fixed the badge/list drift once by lifting the soft-removal predicate
// (isSoftRemovedFromInbox) into a shared module. Issue 119 does the same for the
// count itself: badge = New/Attempting AND not soft-removed. Rather than let
// InboxScreen re-inline that rule to compute its hidden count (the exact
// mistake that caused #89), both sides call THIS.
//
// NOT here — deliberately, same reasoning as inboxSoftRemoval's header:
//   · passesInboxFilters (source / phone / email / touch-band / age) — the
//     user's own VIEW filter. Folding it in would zero the badge whenever
//     someone filters, reading as "no work". The strip counts exactly the
//     leads this test KEEPS that the filter then drops.
//   · the atLocOther exclusion — loc_other rows are the transfer queue, never
//     New/Attempting for a real location; the badge never counts them (they
//     are out of scope on a real location, and the badge is suppressed on
//     'All Locations'). Callers that build a per-location list drop them
//     separately; leaving them out of THIS keeps badge and strip aligned.
// ─────────────────────────────────────────────────────────────

import { deriveClientStatus } from './clientStatus'
import { isSoftRemovedFromInbox } from './inboxSoftRemoval'

/**
 * @param person        mapped Person (leads row + joined children)
 * @param openClientIds Set of client_ids with an OPEN engagement
 * @param wonClientIds  Set of client_ids with a Closed Won engagement (or null)
 * @param nowMs         current epoch ms (passed in so pure/testable)
 * @param sessionSets   optional Inbox per-action optimistic Sets
 *                      ({ junkedIds, snoozedIds, dismissedIds, transferredIds }).
 *                      Omit for the badge, which has no access to them.
 * @returns true when the lead is a live Inbox item — New or Attempting and
 *          not soft-removed. This is the number the nav badge shows.
 */
export function isInboxCountable(person, openClientIds, wonClientIds, nowMs = Date.now(), sessionSets = {}) {
  if (isSoftRemovedFromInbox(person, nowMs, sessionSets)) return false
  const s = deriveClientStatus(person, openClientIds, nowMs, wonClientIds)
  return s === 'New' || s === 'Attempting'
}
