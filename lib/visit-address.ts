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
