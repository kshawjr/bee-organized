// lib/jobber-address-writeback.ts
//
// Fetch-at-push BILLING-address sync plan for the lead-edit trigger —
// the address sibling of lib/jobber-contact-writeback.ts.
//
// Deliberately CLIENT-scoped: clientEdit's billingAddress input edits
// the client's billing address only. We never touch Jobber PROPERTY
// records — properties carry jobs/visits and editing one from a lead
// field has real blast radius (approved design: billing-only).
//
// Input subfield names (street1/street2/city/province/postalCode/
// country) follow ClientCreateInput.billingAddress, which clientEdit
// mirrors. A schema mismatch can only fail the mutation — the caller
// treats that as a non-fatal 'failed' outcome, never a wrong-record
// write.
//
// Rules (the contact-writeback rails, applied to one composite field):
//   - lead address matches Jobber's current billing address
//     (normalized) → NO mutation (echo guard: re-saving what Jobber
//     already holds converges with zero writes).
//   - differs → full replacement of the billing address: street1 is
//     our street line, street2 is cleared (a changed address must not
//     inherit the old unit suffix), country is PRESERVED from Jobber
//     (we don't store it and must not null it).
//   - lead address empty → no mutation (we never erase Jobber data).

import { normalizeAddressKey } from './lead-address'

export type AddressWritebackOutcome = 'updated' | 'added' | 'unchanged' | 'failed'
export type AddressPlan = 'edit' | 'add' | 'none'

export interface JobberBillingAddress {
  street?: string | null
  street1?: string | null
  street2?: string | null
  city?: string | null
  province?: string | null
  postalCode?: string | null
  country?: string | null
}

export interface AddressTarget {
  street: string
  city: string
  state: string
  zip: string
}

// Jobber's `street` is the combined street1+street2; prefer the split
// fields when present so the comparison key matches what an edit writes.
function billingKey(b: JobberBillingAddress | null | undefined): string {
  if (!b) return ''
  const streetPart = String(b.street1 ?? '').trim()
    ? [b.street1, b.street2].map(s => String(s ?? '').trim()).filter(Boolean).join(' ')
    : String(b.street ?? '').trim()
  return normalizeAddressKey([streetPart, b.city, b.province, b.postalCode].map(s => String(s ?? '').trim()).join(' '))
}

export function buildBillingAddressInput(
  target: AddressTarget,
  current: JobberBillingAddress | null | undefined,
): { input: Record<string, any> | null; plan: AddressPlan } {
  const targetKey = normalizeAddressKey([target.street, target.city, target.state, target.zip].join(' '))
  if (!targetKey) return { input: null, plan: 'none' } // never erase Jobber-side data
  if (billingKey(current) === targetKey) return { input: null, plan: 'none' } // already converged

  const input: Record<string, any> = {
    street1: target.street,
    street2: '', // full replacement — never carry the old unit onto a new street
    city: target.city,
    province: target.state,
    postalCode: target.zip,
  }
  const country = String(current?.country ?? '').trim()
  if (country) input.country = country // preserve what we don't store

  return { input, plan: billingKey(current) ? 'edit' : 'add' }
}

export function resolveAddressWriteback(plan: AddressPlan, failed: boolean): AddressWritebackOutcome {
  if (plan === 'none') return 'unchanged'
  if (failed) return 'failed'
  return plan === 'edit' ? 'updated' : 'added'
}
