// lib/jobber-address-writeback.ts
//
// Fetch-at-push address sync plans for the lead-edit trigger — the
// address sibling of lib/jobber-contact-writeback.ts. Two targets:
//
//   BILLING — clientEdit { billingAddress: AddressAttributes }.
//   PROPERTY (service address — the one that matters, Kevin 7/10 late)
//     — propertyEdit(propertyId, { address: AddressAttributes }), with
//     MANAGED blast radius (approved policy, implement exactly this):
//       exactly ONE property  → update it (an address correction should
//                               correct where work happens — even with
//                               upcoming visits; those get an audit
//                               annotation, never a skip)
//       MULTIPLE properties   → never guess which — skip, billing only,
//                               and say so explicitly in toast + audit
//       ZERO properties       → nothing to update
//
// Schema confirmed LIVE 7/10 (read-only introspection, Kevin-
// authorized): ClientEditInput.billingAddress: AddressAttributes;
// propertyEdit(propertyId: EncodedId!, input: PropertyEditInput!) with
// address: AddressAttributes { street1 street2 city country province
// postalCode }; Client.clientProperties → { totalCount, nodes }.
//
// Rules (the contact-writeback rails, applied per target):
//   - target matches Jobber's current value (normalized) → NO mutation
//     (echo guard: re-saving what Jobber already holds converges with
//     zero writes).
//   - differs → full replacement: street1 is our street line, street2
//     is cleared (a changed address must not inherit the old unit
//     suffix), country is PRESERVED from Jobber per-record (we don't
//     store it and must not null it).
//   - lead address empty → no mutation (we never erase Jobber data).

import { normalizeAddressKey } from './lead-address'

export type AddressWritebackOutcome = 'updated' | 'added' | 'unchanged' | 'failed'
export type AddressPlan = 'edit' | 'add' | 'none'

// Per-target outcomes ride the PATCH response as an object (the
// contact_writeback per-field idiom):
//   billing:  updated | added | unchanged | failed
//   property: updated | unchanged (single, already converged)
//           | skipped_multiple (deliberate — never guess which property)
//           | none (client has no properties) | failed
//   upcoming_visits: single property was UPDATED and has future
//           scheduled visits — audit/toast annotation, never a skip.
export type PropertyWritebackOutcome = 'updated' | 'unchanged' | 'skipped_multiple' | 'none' | 'failed'

export interface AddressWriteback {
  billing: AddressWritebackOutcome
  property: PropertyWritebackOutcome
  upcoming_visits: boolean
}

export interface JobberBillingAddress {
  street?: string | null
  street1?: string | null
  street2?: string | null
  city?: string | null
  province?: string | null
  postalCode?: string | null
  country?: string | null
}

export interface JobberProperty {
  id?: string | null
  address?: JobberBillingAddress | null // PropertyAddress — same subfields we read
}

export interface AddressTarget {
  street: string
  city: string
  state: string
  zip: string
}

// Jobber's `street` is the combined street1+street2; prefer the split
// fields when present so the comparison key matches what an edit writes.
// Shared by the billing and property diffs (PropertyAddress carries the
// same subfields).
export function jobberAddressKey(b: JobberBillingAddress | null | undefined): string {
  if (!b) return ''
  const streetPart = String(b.street1 ?? '').trim()
    ? [b.street1, b.street2].map(s => String(s ?? '').trim()).filter(Boolean).join(' ')
    : String(b.street ?? '').trim()
  return normalizeAddressKey([streetPart, b.city, b.province, b.postalCode].map(s => String(s ?? '').trim()).join(' '))
}

function targetKey(target: AddressTarget): string {
  return normalizeAddressKey([target.street, target.city, target.state, target.zip].join(' '))
}

// Full-replacement AddressAttributes for either mutation surface.
function addressAttributes(target: AddressTarget, current: JobberBillingAddress | null | undefined): Record<string, any> {
  const input: Record<string, any> = {
    street1: target.street,
    street2: '', // full replacement — never carry the old unit onto a new street
    city: target.city,
    province: target.state,
    postalCode: target.zip,
  }
  const country = String(current?.country ?? '').trim()
  if (country) input.country = country // preserve what we don't store
  return input
}

export function buildBillingAddressInput(
  target: AddressTarget,
  current: JobberBillingAddress | null | undefined,
): { input: Record<string, any> | null; plan: AddressPlan } {
  const tKey = targetKey(target)
  if (!tKey) return { input: null, plan: 'none' } // never erase Jobber-side data
  if (jobberAddressKey(current) === tKey) return { input: null, plan: 'none' } // already converged
  return { input: addressAttributes(target, current), plan: jobberAddressKey(current) ? 'edit' : 'add' }
}

export function resolveAddressWriteback(plan: AddressPlan, failed: boolean): AddressWritebackOutcome {
  if (plan === 'none') return 'unchanged'
  if (failed) return 'failed'
  return plan === 'edit' ? 'updated' : 'added'
}

// The MANAGED-blast-radius property decision. `properties` is the
// clientProperties page (totalCount + first-2 nodes — totalCount is the
// arbiter, so a 100-property client never pages).
export type PropertyPlanKind = 'edit' | 'none' | 'skipped_multiple' | 'zero'

export function buildPropertyAddressPlan(
  target: AddressTarget,
  properties: { totalCount?: number | null; nodes?: JobberProperty[] | null } | null | undefined,
): { kind: PropertyPlanKind; propertyId: string | null; input: Record<string, any> | null } {
  const tKey = targetKey(target)
  const nodes = properties?.nodes ?? []
  const total = properties?.totalCount ?? nodes.length
  if (!tKey) return { kind: 'none', propertyId: null, input: null } // never erase
  if (total === 0) return { kind: 'zero', propertyId: null, input: null }
  if (total > 1) return { kind: 'skipped_multiple', propertyId: null, input: null } // never guess
  const prop = nodes[0]
  if (!prop?.id) return { kind: 'zero', propertyId: null, input: null } // defensive: count said 1, page disagreed
  if (jobberAddressKey(prop.address) === tKey) return { kind: 'none', propertyId: String(prop.id), input: null } // converged
  return { kind: 'edit', propertyId: String(prop.id), input: addressAttributes(target, prop.address) }
}

export function resolvePropertyWriteback(kind: PropertyPlanKind, failed: boolean): PropertyWritebackOutcome {
  if (kind === 'skipped_multiple') return 'skipped_multiple'
  if (kind === 'zero') return 'none'
  if (kind === 'none') return 'unchanged'
  return failed ? 'failed' : 'updated'
}

// Future-scheduled-visit detection for the single-property annotation.
// Client-level scheduledItems (VISIT + INCOMPLETE) are exact here: the
// check only runs when the client has exactly one property, so every
// visit is at that property. startAt > now is the definition of
// "upcoming" (LATE-but-incomplete past visits don't count).
export function hasUpcomingVisit(
  items: Array<{ startAt?: string | null }> | null | undefined,
  nowMs: number,
): boolean {
  return (items ?? []).some(v => {
    const t = Date.parse(String(v?.startAt ?? ''))
    return Number.isFinite(t) && t > nowMs
  })
}
