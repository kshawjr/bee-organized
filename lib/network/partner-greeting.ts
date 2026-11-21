// lib/network/partner-greeting.ts
// ─────────────────────────────────────────────────────────────
// Partner emails, slice 1 (2026-11-21) — the name {{partner_name}} greets a
// referral partner by. Pure: no database, no email.
//
// THE RULE, in this order:
//   1. an ORGANIZATION (network_types has 'organization') → its whole saved
//      name, always. "Little Guys Movers" → "Little Guys Movers". The flag
//      wins over anything in the first-name box, so an organization whose
//      first name was ever filled in is still greeted by its own name.
//   2. a JOINT name ("Drew & Bill Crowley", "Pat and Sam Lee") → the whole
//      saved name, never split. Same test as lib/network/names.ts isJointName.
//   3. a first name saved → that first name. "Taylor Capen" → "Taylor".
//   4. no first name saved → the whole saved name ("Madonna", "Drew & Bill
//      Crowley" saved whole with no first name).
//   5. nothing saved at all (blank or only spaces) → "" — the tag renders
//      blank, exactly as a client's {{first_name}} does for a client with no
//      name. A sender (slice 3+) can test for "" and hold the email.
//
// NOT DONE, on purpose: a business typed into a PERSON's First / Last boxes
// ("Little" / "Guys Movers", organization not ticked) greets "Little". Telling
// that apart from a real person called Little would be guessing, and Kevin
// ruled out guessing. The fix is the Organization tick on the contact (rule 1).
// ─────────────────────────────────────────────────────────────

import { normalizeNamePart } from '@/lib/lead-name'
import { isJointName } from './names'

/** The partners row columns the greeting reads (migrations/partners.sql, network_names_columns.sql, network_model_columns.sql). */
export type PartnerNameRow = {
  name: string | null | undefined
  first_name?: string | null | undefined
  network_types?: readonly unknown[] | null | undefined
}

export function partnerGreetingName(p: PartnerNameRow | null | undefined): string {
  const whole = normalizeNamePart(p?.name ?? '')
  const first = normalizeNamePart(p?.first_name ?? '')
  const isOrg = Array.isArray(p?.network_types) && p!.network_types!.includes('organization')
  if (isOrg) return whole || first
  if (whole && isJointName(whole)) return whole
  return first || whole
}
