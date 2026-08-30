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

// Labeled variant for the lead NOTIFICATIONS (email row + Slack card). Reuses
// formatLeadAddress for the de-duped value string — so a full-joined `address`
// column (the Jobber-import convention) never re-renders its own parts (the
// Wendy Blanch bug) — then adapts the LABEL to what's present. zip-alone is the
// DOMINANT case for website leads (157 of 166 in a recent 30-day window carried
// a zip; only 17 had a street or city), so a fixed "Address:" over a bare postal
// code reads wrong:
//   street present  → "Address"   (the address column carries a street line)
//   city/state only → "Location"
//   zip only        → "Zip"
//   nothing         → null        (the caller omits the row entirely)
// Street-presence is approximated by a non-empty `address` column, matching this
// module's storage convention (the column holds the street line, or the full
// joined string on imported rows — both of which lead with a street).
export function formatLeadAddressLabeled(
  lead: LeadAddressParts | null | undefined,
): { label: string; value: string } | null {
  const value = formatLeadAddress(lead ?? {})
  if (!value) return null
  const hasStreet = !!String(lead?.address ?? '').trim()
  const hasCityOrState =
    !!String(lead?.city ?? '').trim() || !!String(lead?.state ?? '').trim()
  const label = hasStreet ? 'Address' : hasCityOrState ? 'Location' : 'Zip'
  return { label, value }
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

// ─── FORMER ADDRESSES (the two-address feature) ───────────────────────
//
// A client's CURRENT address stays in the four columns above, with its
// Jobber property link in leads.jobber_property_id. When an owner answers
// "They moved" on an address edit, the address they moved FROM is appended
// to leads.former_addresses (migrations/lead_former_addresses.sql) —
// strictly additive history, never edited from the card, each entry
// carrying the Jobber property it IS so inbound property events can route
// to it instead of stomping the current address.

export interface FormerAddress {
  street: string
  city: string
  state: string
  zip: string
  display: string
  jobber_property_id: string | null
  moved_at: string
}

// The entry the "They moved" branch appends — built from the lead's
// BEFORE-state (the address being vacated) and its property link at that
// moment. Returns null when there is nothing worth keeping (a move onto a
// previously empty address keeps no history).
export function buildFormerAddress(
  stored: LeadAddressParts,
  jobberPropertyId: string | null | undefined,
  nowIso: string,
): FormerAddress | null {
  const display = formatLeadAddress(stored)
  if (!display) return null
  return {
    street: deriveStreet(stored.address, stored),
    city: String(stored.city ?? '').trim(),
    state: String(stored.state ?? '').trim(),
    zip: String(stored.zip ?? '').trim(),
    display,
    jobber_property_id: jobberPropertyId ? String(jobberPropertyId) : null,
    moved_at: nowIso,
  }
}

// Tolerant reader — rows predating the migration (or fixtures) read as [].
export function parseFormerAddresses(raw: unknown): FormerAddress[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((e): e is FormerAddress => !!e && typeof e === 'object' && !!(e as any).display)
}

// Postgres "column does not exist", named — the lead PATCH's move branch
// refuses to proceed (calm error, old address never silently dropped)
// while the migration is pending. Same posture as lib/feedback-internal.
export function isMissingFormerAddressesColumn(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  const msg = String(e.message ?? '').toLowerCase()
  if (!msg.includes('former_addresses')) return false
  const code = String(e.code ?? '')
  return code === '42703' || code === 'PGRST204' || msg.includes('column') || msg.includes('schema cache')
}
