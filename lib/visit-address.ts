// lib/visit-address.ts
//
// OUR rule for an address someone has to drive to — not Jobber's. Jobber's
// AddressAttributes makes every part optional, even street1 (introspected
// live 2026-10-16), so a lone zip passes its check and books a visit nobody
// can attend. Bee Hub requires street, city AND state before an in-person
// assessment or a job goes to Jobber. Zip is optional (Google fills it).
//
// One rule, two enforcers: the Send to Jobber screen (asks for the missing
// parts on the spot) and the send route (refuses anything less, whatever the
// screen did).

import { deriveStreet } from './lead-address'

export type VisitAddress = { street: string; city: string; state: string; zip: string }

export const VISIT_ADDRESS_REQUIRED = ['street', 'city', 'state'] as const
export type VisitAddressPart = (typeof VISIT_ADDRESS_REQUIRED)[number]

const clean = (v: unknown) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim())

export function missingVisitAddressParts(a: Partial<Record<string, unknown>> | null | undefined): VisitAddressPart[] {
  return VISIT_ADDRESS_REQUIRED.filter(k => !clean(a?.[k]))
}

export function isVisitAddressComplete(a: Partial<Record<string, unknown>> | null | undefined): boolean {
  return missingVisitAddressParts(a).length === 0
}

// "street, city and state" — for the refusal wording.
export function describeMissing(parts: VisitAddressPart[]): string {
  if (parts.length <= 1) return parts.join('')
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
}

// The client's primary address as the send route sends it to Jobber.
// Prefer the address list (current write path for new manual leads); fall
// through to the legacy columns when the entry is missing or has no street —
// Jobber-imported leads only populate the columns, and a stub entry (e.g.
// `{ type: 'Service' }`) would otherwise mask a valid legacy address.
//
// `street` is the STREET ONLY. leads.address holds the full joined line
// ("street, city, state, zip" — the import's convention, lib/lead-address.ts),
// and sending that whole line as street1 alongside city/province/postalCode
// is what made Jobber show city, state and zip twice — and the property
// webhook then echoed the doubled line back into leads.address (~420 rows
// since May). deriveStreet strips the tail, repeats included.
// `storedStreet` is the line as stored, so a property one of those sends
// created in Jobber (street1 = the full line) is still recognised.
export function pickPrimaryAddress(lead: any): (VisitAddress & { storedStreet: string }) | null {
  const a0 = Array.isArray(lead?.addresses) ? lead.addresses[0] : null
  const stored0 = clean(a0?.street || a0?.value)
  if (stored0) {
    const parts = { city: clean(a0.city), state: clean(a0.state), zip: clean(a0.zip) }
    return { street: deriveStreet(stored0, parts), ...parts, storedStreet: stored0 }
  }
  const stored = clean(lead?.address)
  if (stored) {
    const parts = { city: clean(lead.city), state: clean(lead.state), zip: clean(lead.zip) }
    return { street: deriveStreet(stored, parts), ...parts, storedStreet: stored }
  }
  return null
}

// The client's primary address the way the send route reads it
// (pickPrimaryAddress): the first address-list entry with a street, else the
// legacy columns. On a mapped person the legacy city/state/zip ride as
// originCity/originState/originZip (lib/people-mapper.ts).
export function personVisitAddress(person: any): VisitAddress | null {
  const a0 = Array.isArray(person?.addresses) ? person.addresses[0] : null
  const street0 = clean(a0?.street || a0?.value)
  if (street0) {
    return { street: street0, city: clean(a0.city), state: clean(a0.state), zip: clean(a0.zip) }
  }
  const street = clean(person?.address)
  if (street) {
    return { street, city: clean(person.originCity), state: clean(person.originState), zip: clean(person.originZip) }
  }
  return null
}
