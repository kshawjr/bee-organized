// lib/address-choice.ts
//
// PURE helpers for "which address is this job for?" — shared by the
// Send-to-Jobber wizard (client) and the send route (server), so the
// list the owner picks from and the list the server validates against
// are built by the same code.
//
// THE PREMISE. A Bee Hub lead stores ONE address (the four columns) plus
// ONE Jobber property link (leads.jobber_property_id). The two-address
// feature (d8aa5ef) added leads.former_addresses: the addresses this
// client has held before, each carrying the Jobber property it IS.
// Jobber itself has no such hierarchy — a client just has properties,
// all of them equally live and bookable. So when a client moves and
// then has work at BOTH homes (Heather Popelka, North Pittsburgh), the
// former entry is not history at all: it is a second live address that
// Bee Hub had no way to send to.
//
// This module does not change what is stored. It just reads the two
// places an address can live and presents them as one flat, ordered
// list of things a job can be sent to. Current is always first, so
// "default to the current one" is "take choices[0]".
//
// The KEY is what crosses the wire in the POST body. It is positional
// ('former:0') rather than an address string because the address is the
// thing most likely to be re-typed, and positional keys can be
// validated against the row without trusting anything the client sent.

import { formatLeadAddress, deriveStreet, parseFormerAddresses, isRetiredAddress } from './lead-address'
import type { LeadAddressParts, FormerAddress } from './lead-address'
import { addressLabelText } from './address-labels'

export const CURRENT_CHOICE_KEY = 'current'

export interface AddressChoice {
  key: string // 'current' | 'former:<index>'
  display: string // the de-duped one-line string the card shows
  street: string
  city: string
  state: string
  zip: string
  // The Jobber property this address IS, when we know it. The current
  // address carries leads.jobber_property_id; a former entry carries the
  // id captured when it was vacated. Null on unlinked or pre-migration
  // rows — the server falls back to a street match.
  jobberPropertyId: string | null
  isCurrent: boolean
  // Label for the wizard's picker row, already resolved to display text
  // ('Second home', or an Other entry's note). Null when unlabelled.
  labelText: string | null
}

// The current address, as a choice. Returns null when the lead has no
// address at all (request_only / virtual-assessment leads) — there is
// nothing to pick, and the route's existing address guard still speaks.
function currentChoice(
  current: LeadAddressParts | null | undefined,
  jobberPropertyId: string | null | undefined,
  label: unknown,
  labelNote: unknown,
): AddressChoice | null {
  const display = formatLeadAddress(current ?? {})
  if (!display) return null
  return {
    key: CURRENT_CHOICE_KEY,
    display,
    street: deriveStreet(current?.address, current ?? {}),
    city: String(current?.city ?? '').trim(),
    state: String(current?.state ?? '').trim(),
    zip: String(current?.zip ?? '').trim(),
    jobberPropertyId: jobberPropertyId ? String(jobberPropertyId) : null,
    isCurrent: true,
    labelText: addressLabelText(label, labelNote),
  }
}

// The full pick-list: current first, then the stored former addresses in
// the order they were appended (oldest first — the order the move flow
// writes and the card renders, so the wizard and the card agree).
//
// `formerRaw` is tolerant: the jsonb column, the camelCase mapper field,
// or undefined on a pre-migration row all read as "no former addresses",
// which collapses this to the one-address case — the unchanged path.
export function buildAddressChoices(
  current: LeadAddressParts | null | undefined,
  jobberPropertyId: string | null | undefined,
  formerRaw: unknown,
  label?: unknown,
  labelNote?: unknown,
): AddressChoice[] {
  const out: AddressChoice[] = []
  const cur = currentChoice(current, jobberPropertyId, label, labelNote)
  if (cur) out.push(cur)
  parseFormerAddresses(formerRaw).forEach((f: FormerAddress, i: number) => {
    const display = String(f.display ?? '').trim()
    if (!display) return
    // A RETIRED address is not offered at send time — that is the entire
    // meaning of retiring it. The picker component is untouched; it simply
    // receives a shorter list, so a client left with one live address goes
    // back to the no-picker, no-extra-click path.
    //
    // The KEY stays positional over the FULL stored array (index i, not the
    // output position), so a key the wizard sends still names the same entry
    // after something ahead of it is retired.
    if (isRetiredAddress(f)) return
    out.push({
      key: `former:${i}`,
      display,
      // Former entries store their parts explicitly (buildFormerAddress
      // ran deriveStreet at capture time), so no re-derivation here.
      street: String(f.street ?? '').trim(),
      city: String(f.city ?? '').trim(),
      state: String(f.state ?? '').trim(),
      zip: String(f.zip ?? '').trim(),
      jobberPropertyId: f.jobber_property_id ? String(f.jobber_property_id) : null,
      isCurrent: false,
      labelText: addressLabelText(f.label, f.label_note),
    })
  })
  return out
}

// Resolve a key the client sent back to a choice, or null when it names
// nothing this lead holds. Absent / empty / 'current' resolves to the
// current address — so an OLD client that never sends the field, and a
// new one that explicitly picks the default, take the identical path.
export function resolveAddressChoice(
  choices: AddressChoice[],
  key: string | null | undefined,
): AddressChoice | null {
  if (!choices.length) return null
  const k = String(key ?? '').trim()
  if (!k || k === CURRENT_CHOICE_KEY) return choices.find(c => c.isCurrent) ?? null
  return choices.find(c => c.key === k) ?? null
}

// Did the owner pick something other than the current address? The one
// question the route branches on: a former-address send must resolve an
// EXISTING Jobber property (never create one) and must not re-point
// leads.jobber_property_id.
export function isFormerChoiceKey(key: string | null | undefined): boolean {
  const k = String(key ?? '').trim()
  return !!k && k !== CURRENT_CHOICE_KEY
}
