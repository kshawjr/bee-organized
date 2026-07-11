// components/hive/shared/leadPatchMap.js
// ─────────────────────────────────────────────────────────────
// PURE module — translates a lead-column patch (what the cards PATCH to
// /api/leads/[id]) into Person-shape fields (what BeeHub's people state
// holds, per lib/people-mapper). The propagation seam: after a card
// saves a lead field, HiveShell hands the translated patch UP through
// onPersonPatched so Inbox rows / filters / reopened cards reflect the
// change without a reload (§8.5 direction rule: BeeHub passes the
// callback DOWN, the shell only hands data UP).
//
// Deliberately narrow: only columns the beta cards actually edit.
// Unknown keys are DROPPED (never guessed) — a wrong key here would
// silently corrupt a Person object.
// ─────────────────────────────────────────────────────────────

const LEAD_COL_TO_PERSON_FIELD = {
  source: 'source',
  project_type: 'project',
  referred_by_kind: 'referredByKind',
  referred_by_id: 'referredBy',
  request_details: 'jobDetail',
  snoozed_until: 'snoozeUntil', // Timeline's un-snooze → Inbox reflects live
  is_junk: 'isJunk',            // card ··· menu junk → Inbox row drops live
  // Build-3 preference/assignment writes (PreferencesBlock + AssignedToField)
  marketing_opt_out: 'marketingOptOut',
  paused: 'paused',
  assigned_to: 'assignedTo',
  phone: 'phone',               // ContactField inline edit → Inbox tel:/filters live
  email: 'email',
  // AddressField inline edit. Person has ONE flat address field (the
  // display string); city/state/zip live only inside the addresses
  // jsonb → no Person keys to map, deliberately dropped. The composed
  // `address` col the field PATCHes is the full display string, so the
  // flat field stays correct on its own.
  address: 'address',
}

export function leadColsToPersonFields(cols) {
  const out = {}
  for (const [k, v] of Object.entries(cols || {})) {
    const personKey = LEAD_COL_TO_PERSON_FIELD[k]
    if (personKey) out[personKey] = v
  }
  // phone_normalized is a GENERATED column — the client never knows the
  // server's new value. Null the stale copy so consumers fall back to
  // digits-of-phone (InboxScreen's tel: href does exactly that); leaving
  // it would dial the OLD number after an edit.
  if ('phone' in out) out.phoneNormalized = null
  return out
}
