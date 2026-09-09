// lib/property-drift.ts
//
// THE DRIFT DECISION, as pure functions. No Supabase, no Jobber, no clock.
//
// WHY THIS FILE EXISTS. Jobber tells us about a property; we have to decide
// whether it is an address we already know. That decision was about to exist
// in two places — the inbound webhook, and any backfill sweep that goes
// looking for the ~105 clients whose Jobber properties Bee Hub never
// recorded. Two copies of "already known" is two answers to the same
// question, and the one that drifts is the one that writes a duplicate onto
// an owner's card. So the opinion lives here, once, and both callers ask it.
//
// WHAT IT DOES NOT DO. It never decides to touch the primary address columns
// and never decides to move leads.jobber_property_id. That is the rule the
// fourth routing branch in handlePropertyCore was built to protect (d8aa5ef):
// before it, any property event on a multi-property client overwrote the
// lead's CURRENT address and re-pointed its link at whichever property fired
// last. Adding one of the client's OTHER addresses violates neither half of
// that rule — the branch gains an action, it does not lose its guard.
//
// The 'other' + 'Found in Jobber' labelling matches
// scripts/import-six-properties.mjs exactly, so a row written by the webhook
// and a row written by Kevin's held backfill are indistinguishable on the
// card. 'other' REQUIRES a note (lib/address-labels, validateAddressLabel) —
// a bare 'other' degrades to the word "Other", which is the label saying
// nothing, the exact defect a fixed label set exists to prevent.

import {
  composeLeadAddress,
  formatLeadAddress,
  normalizeAddressKey,
  buildAddedAddress,
  isRetiredAddress,
  type FormerAddress,
  type LeadAddressParts,
} from '@/lib/lead-address'

// The label every drift-discovered address carries. Both writers use these.
export const DRIFT_LABEL = 'other' as const
export const DRIFT_LABEL_NOTE = 'Found in Jobber'

// Jobber's SINGLE_PROPERTY_QUERY address shape. `province` is Jobber's name
// for what we store as `state`; nothing else needs translating.
export interface JobberPropertyAddress {
  street?: string | null
  city?: string | null
  province?: string | null
  postalCode?: string | null
}

export type DriftSkipReason = 'no_address' | 'matches_primary' | 'matches_existing'

export type DriftPlan =
  | { action: 'create'; entry: FormerAddress }
  | { action: 'skip'; reason: 'no_address' }
  | { action: 'skip'; reason: 'matches_primary' }
  | { action: 'skip'; reason: 'matches_existing'; index: number; retired: boolean }

export interface PlanDriftInput {
  lead: LeadAddressParts
  formerAddresses: FormerAddress[]
  address: JobberPropertyAddress | null | undefined
  jobberPropertyId: string | null | undefined
  nowIso: string
}

// Is this Jobber property an address the client's card already carries — and
// if not, what entry should be appended?
//
// MATCH ORDER matters, and each step earns its place:
//   1. no street / nothing composable → skip. A blank address row is worse
//      than the drift it would fix; the four id-only rows in the held
//      backfill script are skipped for the same reason.
//   2. it IS the primary address → skip. The primary lives in the columns,
//      not in the list; recording it twice makes the card lie about how many
//      addresses the client has.
//   3. same jobber_property_id → skip. The id is IDENTITY: it survives an
//      address edit on either side, so a corrected street still resolves to
//      the entry we already hold rather than creating a second one.
//   4. same normalized display → skip. Catches entries recorded before the
//      id was known (the held backfill writes two of those with a null id).
//   5. otherwise → create.
//
// A RETIRED match still skips, and STAYS retired. An inbound Jobber event is
// not the owner changing their mind about a retirement they made — Jobber has
// no archive, so the property being alive over there says nothing about
// whether Bee Hub should be offering it at send time. The caller is told
// `retired: true` so its note can say which entry matched and in what state.
//
// Comparison is normalizeAddressKey, the same key the address card uses to
// decide an edit is a no-op — so casing and punctuation cannot manufacture a
// duplicate ("10 Old Rd" vs "10 old rd." are the same address).
export function planDriftAddress(input: PlanDriftInput): DriftPlan {
  const { lead, formerAddresses, address, jobberPropertyId, nowIso } = input

  const street = String(address?.street ?? '').trim()
  const city   = String(address?.city ?? '').trim()
  const state  = String(address?.province ?? '').trim()
  const zip    = String(address?.postalCode ?? '').trim()

  // 1. Nothing usable.
  const display = street ? composeLeadAddress({ street, city, state, zip }) : ''
  if (!street || !display) return { action: 'skip', reason: 'no_address' }

  const key = normalizeAddressKey(display)

  // 2. It is the primary address already.
  const primary = formatLeadAddress(lead)
  if (primary && normalizeAddressKey(primary) === key) {
    return { action: 'skip', reason: 'matches_primary' }
  }

  const list = Array.isArray(formerAddresses) ? formerAddresses : []
  const propId = jobberPropertyId ? String(jobberPropertyId) : ''

  // 3. Same property id — identity wins over text.
  if (propId) {
    const i = list.findIndex(e => String(e?.jobber_property_id ?? '') === propId)
    if (i >= 0) {
      return { action: 'skip', reason: 'matches_existing', index: i, retired: isRetiredAddress(list[i]) }
    }
  }

  // 4. Same address text — an entry recorded before we knew the id.
  const j = list.findIndex(e => !!e?.display && normalizeAddressKey(e.display) === key)
  if (j >= 0) {
    return { action: 'skip', reason: 'matches_existing', index: j, retired: isRetiredAddress(list[j]) }
  }

  // 5. Genuinely new to us.
  const entry = buildAddedAddress(
    { street, city, state, zip },
    propId || null,
    DRIFT_LABEL,
    DRIFT_LABEL_NOTE,
    nowIso,
  )
  // buildAddedAddress only returns null without a street or display, both
  // already proven above — but it is typed nullable, so honour that rather
  // than assert past it.
  if (!entry) return { action: 'skip', reason: 'no_address' }
  return { action: 'create', entry }
}

export type DestroyPlan =
  | { action: 'retire'; index: number; next: FormerAddress[] }
  | { action: 'skip'; reason: 'no_property_id' | 'not_held' | 'already_retired' }

// A property deleted in Jobber that the client holds as one of their OTHER
// addresses. Today nothing happens to it: the send-time picker keeps offering
// it, and the send then FAILS, because a second address resolves to a
// property that must already exist and the push refuses to create one.
//
// RETIRE, never delete. Same semantics as the owner's own "Stop using"
// control: the address, its label and its history stay on the card, Bee Hub
// just stops offering it. An address deleted in Jobber must not silently
// vanish from Bee Hub — the owner's record of where their client lived is
// theirs, not Jobber's, and a row disappearing is a row nobody can ask about.
//
// Already-retired is a skip, not a rewrite: re-stamping an entry the owner
// retired weeks ago would move it in any history that reads the entry, for
// no change in meaning.
export function planDestroyedProperty(
  formerAddresses: FormerAddress[],
  jobberPropertyId: string | null | undefined,
): DestroyPlan {
  const propId = jobberPropertyId ? String(jobberPropertyId) : ''
  if (!propId) return { action: 'skip', reason: 'no_property_id' }

  const list = Array.isArray(formerAddresses) ? formerAddresses : []
  const index = list.findIndex(e => String(e?.jobber_property_id ?? '') === propId)
  if (index < 0) return { action: 'skip', reason: 'not_held' }
  if (isRetiredAddress(list[index])) return { action: 'skip', reason: 'already_retired' }

  const next = list.map((e, i) => (i === index ? { ...e, status: 'retired' as const } : e))
  return { action: 'retire', index, next }
}
