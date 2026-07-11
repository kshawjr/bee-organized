// lib/lead-address.ts
//
// PURE address helpers shared by the hive AddressField (client), the
// leads PATCH route, and the Jobber address write-back (server).
//
// The storage convention (set by the Jobber import, upsertLead):
//   leads.address = the FULL joined string "street, city, state, zip"
//   leads.city / state / zip = the parts, duplicated as columns.
// So `address` usually already CONTAINS city/state/zip — a renderer
// that appends the part columns to it duplicates them ("…, Temecula,
// California, 92592, Temecula, California 92592" — the Wendy Blanch
// bug). formatLeadAddress is the one display path: it appends only the
// parts the string doesn't already carry (legacy street-only rows).
//
// deriveStreet inverts the convention for the Jobber push: billingAddress
// wants street1/city/province/postalCode as separate inputs, and we
// don't store a street column — so we strip the known part columns off
// the tail of the full string.

export interface LeadAddressParts {
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
}

// Comparison key: case/punctuation/whitespace-insensitive.
export function normalizeAddressKey(raw: string | null | undefined): string {
  return String(raw ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// Storage composition — same join the Jobber import uses (upsertLead),
// so UI-saved and imported rows read identically.
export function composeLeadAddress(parts: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null }): string {
  return [parts.street, parts.city, parts.state, parts.zip]
    .map(p => String(p ?? '').trim())
    .filter(Boolean)
    .join(', ')
}

// Display normalization: the full string, with only the MISSING part
// columns appended (city as its own segment, "state zip" grouped like
// the old renderer). Never duplicates a part the string already has.
export function formatLeadAddress(lead: LeadAddressParts | null | undefined): string {
  const address = String(lead?.address ?? '').trim()
  const city = String(lead?.city ?? '').trim()
  const state = String(lead?.state ?? '').trim()
  const zip = String(lead?.zip ?? '').trim()
  if (!address) {
    return [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  }
  const key = normalizeAddressKey(address)
  const missing = (p: string) => p && !key.includes(normalizeAddressKey(p))
  const cityPart = missing(city) ? city : ''
  const stateZip = [state, zip].filter(missing).join(' ')
  return [address, cityPart, stateZip].filter(Boolean).join(', ')
}

// Strip trailing comma-segments that merely repeat the part columns —
// what's left is the street line(s). "29659 Calle Violeta, Temecula,
// California, 92592" with {Temecula, California, 92592} → "29659 Calle
// Violeta". A street-only string passes through untouched.
export function deriveStreet(address: string | null | undefined, parts: LeadAddressParts): string {
  const segs = String(address ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const city = normalizeAddressKey(parts.city)
  const state = normalizeAddressKey(parts.state)
  const zip = normalizeAddressKey(parts.zip)
  const partKeys = new Set(
    [city, state, zip, state + zip, city + state, city + state + zip].filter(Boolean),
  )
  while (segs.length > 1 && partKeys.has(normalizeAddressKey(segs[segs.length - 1]))) {
    segs.pop()
  }
  return segs.join(', ')
}

// Per-PATCH trigger decision (mirrors diffContactPatch): did this patch
// actually change the address, normalized? Echo-safe — a webhook echo
// re-saving Jobber's own value, or a formatting-only reformat, is NOT a
// change (and webhook echoes never PATCH at all; they write via
// upsertLead). `touched` distinguishes "patch didn't mention address"
// from "mentioned but unchanged".
export interface AddressPatchDiff {
  touched: boolean
  changed: boolean
  cleared: boolean
  street: string
  city: string
  state: string
  zip: string
  display: string
  prevDisplay: string
}

const ADDRESS_COLS = ['address', 'city', 'state', 'zip'] as const

export function diffAddressPatch(
  patch: Record<string, unknown>,
  stored: LeadAddressParts,
): AddressPatchDiff {
  const touched = ADDRESS_COLS.some(k => k in patch)
  const pick = (k: (typeof ADDRESS_COLS)[number]): string => {
    const v = k in patch ? patch[k] : (stored as any)[k]
    return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim()
  }
  const next = { address: pick('address'), city: pick('city'), state: pick('state'), zip: pick('zip') }
  const display = formatLeadAddress(next)
  const prevDisplay = formatLeadAddress(stored)
  const changed = touched && normalizeAddressKey(display) !== normalizeAddressKey(prevDisplay)
  return {
    touched,
    changed,
    cleared: changed && !display,
    street: deriveStreet(next.address, next),
    city: next.city,
    state: next.state,
    zip: next.zip,
    display,
    prevDisplay,
  }
}
