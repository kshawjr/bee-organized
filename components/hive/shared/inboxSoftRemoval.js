// components/hive/shared/inboxSoftRemoval.js
// ─────────────────────────────────────────────────────────────
// PURE module — the Inbox worklist's PERSISTENT soft-removal test, shared
// by the two derivations that MUST agree: the Inbox nav badge count
// (HiveShell) and the Inbox New/Attempting list (InboxScreen).
//
// #89: before this existed, each side inlined its own copy of the removal
// predicate and they drifted. The badge omitted every exclusion and
// counted rows the list hid — a dismissed lead still derives New/Attempting
// (deriveClientStatus is deliberately blind to these fields: dismiss means
// "handled in my inbox", not a status change), so it rode the badge while
// the list dropped it. Prod, Palm Beach: badge 5, list 3 — the two
// inbox_dismissed_at leads were the whole gap.
//
// The removal test therefore lives OUTSIDE deriveClientStatus, here, and
// both status consumers call it. Four exclusions, all persistent (they
// survive a reload — a DB column, not session-only UI state), each also
// honoring the caller's in-session optimistic Set so a just-actioned row
// leaves instantly:
//   · is_junk            — junked leads live in the Recycle Bin
//   · snoozed_until       — a future value = temporarily hidden. Note the
//                           'd': the column is snoozed_until, NOT snooze_until.
//   · inbox_dismissed_at  — "handled in my inbox"; the #89 culprit
//   · transferred         — routed to a real location. No persistent flag on
//                           the row (transfer moves its location, so it leaves
//                           scope on reload); the session Set covers the
//                           optimistic gap until the refetch lands.
//
// NOT here: passesInboxFilters (source / phone / email / touch-band / age).
// Those are the user's own VIEW filters, not removals — folding them into the
// badge would zero the count whenever someone filters their view, reading as
// "no work" when there IS work. The list applies them as a SEPARATE step on
// top of this test; the badge never does.
//
// The session Sets are Inbox-LOCAL by design (they live in InboxScreen state,
// not HiveShell). The badge has no access to them, so it calls this with no
// sets — applying the persistent DB fields alone and reconciling to an
// in-session action on the next people refetch, when the persisted column
// arrives. See InboxScreen's junkedIds/snoozedIds/dismissedIds comment.
// ─────────────────────────────────────────────────────────────

/**
 * @param person       mapped Person (leads row + joined children)
 * @param nowMs        current epoch ms (passed in so pure/testable)
 * @param sessionSets  optional { junkedIds, snoozedIds, dismissedIds, transferredIds }
 *                     — the Inbox's per-action optimistic Sets. Omit for the
 *                     badge, which has no access to them.
 * @returns true when the row should be suppressed from the Inbox worklist AND
 *          its badge count.
 */
export function isSoftRemovedFromInbox(person, nowMs = Date.now(), sessionSets = {}) {
  if (!person) return false
  const { junkedIds, snoozedIds, dismissedIds, transferredIds } = sessionSets
  const id = person.id
  if (person.isJunk || junkedIds?.has(id)) return true
  if (snoozedIds?.has(id) || (person.snoozeUntil && new Date(person.snoozeUntil).getTime() > nowMs)) return true
  if (person.inboxDismissedAt || dismissedIds?.has(id)) return true
  if (transferredIds?.has(id)) return true
  return false
}
