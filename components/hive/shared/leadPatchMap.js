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

import { deriveStreet, formatLeadAddress } from '@/lib/lead-address'

const LEAD_COL_TO_PERSON_FIELD = {
  source: 'source',
  project_type: 'project',
  referred_by_kind: 'referredByKind',
  referred_by_id: 'referredBy',
  request_details: 'jobDetail',
  snoozed_until: 'snoozeUntil', // Timeline's un-snooze → Inbox reflects live
  is_junk: 'isJunk',            // card ··· menu junk → Inbox row drops live
  // "Move to Network" soft-hide → the Inbox row drops live. Inbox-scoped
  // only, exactly like the column: deriveClientStatus stays blind to it, so
  // the person keeps their true status everywhere else.
  inbox_dismissed_at: 'inboxDismissedAt',
  // Build-3 preference writes (PreferencesBlock)
  marketing_opt_out: 'marketingOptOut',
  paused: 'paused',
  // LEGACY / effectively dead: AssignedToField was removed from ClientProfile
  // when assignment went plural, and no card PATCHes assigned_to any more —
  // assignment is written through PUT /api/leads/:id/assignees and read from
  // the lead_assignees junction. Kept because the map is defensive, not because
  // anything fires it. NOTE THE SHAPE MISMATCH if you ever revive a caller:
  // Person.assignedTo is an ARRAY, this maps a single column value. Every
  // reader normalizes via asAssigneeIds(), so a stray singular is tolerated —
  // but a new writer should target the assignees route, not this seam.
  assigned_to: 'assignedTo',
  phone: 'phone',               // ContactField inline edit → Inbox tel:/filters live
  email: 'email',
  // AddressField inline edit. `address` is the composed full line; the
  // parts ride as originCity/originState/originZip, exactly as
  // lib/people-mapper builds them on load. They used to be DROPPED, so a
  // client whose address was just saved still looked city-less to the
  // Send to Jobber screen (Lynette Ewy, KC, 2026-10-20) — it asked for
  // parts the record already had, and the retyped parts doubled the line.
  // The address list entry is kept in step by mergePersonPatch below.
  address: 'address',
  city: 'originCity',
  state: 'originState',
  zip: 'originZip',
  // NOT a column: the client record's Tags row hands its link ids up here
  // after /api/lead-tags has written them, so Everyone's tag filter and
  // tag search reflect the change without a reload (same seam as above).
  tag_ids: 'tagIds',
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

// Merge translated fields into a Person — what BeeHub's people state does
// with every hand-up. A plain spread, except for an ADDRESS change: the
// Person's address list must move with it, the way the server moves it
// (PATCH /api/leads/:id rewrites the first Service entry's value AND its
// street/city/state/zip) and the way lib/people-mapper rebuilds it on the
// next load (no stored list → one entry from the columns). Without this the
// Send to Jobber screen (lib/visit-address personVisitAddress reads
// addresses[0] first) checked the OLD address until a reload.
export function mergePersonPatch(person, fields) {
  const next = { ...person, ...fields }
  if (!fields || !('address' in fields)) return next
  const parts = {
    address: String(next.address ?? '').trim(),
    city: String(next.originCity ?? '').trim(),
    state: String(next.originState ?? '').trim(),
    zip: String(next.originZip ?? '').trim(),
  }
  const display = formatLeadAddress(parts)
  const list = Array.isArray(person?.addresses) ? person.addresses : []
  if (list.length === 0) {
    next.addresses = parts.address
      ? [{ type: 'Service', value: parts.address, street: parts.address, city: parts.city, state: parts.state, zip: parts.zip }]
      : []
    return next
  }
  const idx = Math.max(0, list.findIndex(a => a && a.type === 'Service'))
  next.addresses = !display
    ? list.filter((_, i) => i !== idx)
    : list.map((a, i) => (i === idx
        ? { ...a, value: display, street: deriveStreet(parts.address, parts), city: parts.city, state: parts.state, zip: parts.zip }
        : a))
  return next
}
