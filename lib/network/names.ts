// lib/network/names.ts
// ─────────────────────────────────────────────────────────────
// Network slice 5, third follow-up — a contact's first, last and full name.
// Pure. Kevin's ruling (2026-11-19): Network gets first and last names, the
// same as Clients.
//
// THE CONVENTION IS CLIENTS', NOT A NEW ONE:
//   · the full name is first + " " + last, extra spaces tidied, exactly
//     lib/lead-name.ts composeLeadName (which Clients' editor and route use);
//   · one name split into two is first word / everything after, exactly the
//     website form's splitName (app/api/leads/intake/route.ts) and
//     lib/name-prefill.ts: "Mary Van Der Berg" → Mary / Van Der Berg.
// Two differences, both because a Network contact is not a client:
//   · an ORGANIZATION keeps one name and no first or last. Clients put a
//     business in `company`; on Network `company` is where a person works,
//     so an organization's name is `name` alone.
//   · a JOINT name ("Drew & Bill Crowley") typed or imported as one name is
//     not split: first word / rest would make a last name of "& Bill
//     Crowley". It is kept whole, first and last blank, like the 32 the
//     backfill left alone.
// Names keep their case (lib/lead-name.ts: "jerry" → "Jerry" is a real edit).
// ─────────────────────────────────────────────────────────────

import { composeLeadName, normalizeNamePart } from '@/lib/lead-name'

export type ContactNames = { name: string; first_name: string | null; last_name: string | null }

/** "Drew & Bill Crowley", "Pat and Sam Lee", "Jo + Al", "A/B": two people in one name. */
export const isJointName = (v: unknown) => /[&+/]|(^|\s)and(\s|$)/i.test(normalizeNamePart(v as string))

/** First word / everything after. A joint name, or one word, is not split into a last name. */
export function splitFullName(full: unknown): { first_name: string | null; last_name: string | null } {
  const n = normalizeNamePart(full as string)
  if (!n || isJointName(n)) return { first_name: null, last_name: null }
  const i = n.indexOf(' ')
  if (i === -1) return { first_name: n, last_name: null }
  return { first_name: n.slice(0, i), last_name: n.slice(i + 1) }
}

/**
 * The three name columns for a new contact.
 *   organization  → the name whole, never split; first and last blank
 *   first / last  → used as given; the full name is set from them
 *   one name only → split first word / rest (not a joint name)
 */
export function contactNames(input: { first?: unknown; last?: unknown; name?: unknown; isOrg: boolean }): ContactNames {
  const first = normalizeNamePart(input.first as string)
  const last = normalizeNamePart(input.last as string)
  const whole = normalizeNamePart(input.name as string)
  if (input.isOrg) return { name: whole || composeLeadName({ first_name: first, last_name: last }), first_name: null, last_name: null }
  if (first || last) return { name: composeLeadName({ first_name: first, last_name: last }), first_name: first || null, last_name: last || null }
  return { name: whole, ...splitFullName(whole) }
}
