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

// ─── THE CLIENT'S OTHER ADDRESSES ─────────────────────────────────────
//
// A client's PRIMARY address stays in the four columns above, with its
// Jobber property link in leads.jobber_property_id and its label in
// leads.address_label. Every OTHER address the client holds lives as an
// entry in leads.former_addresses.
//
// THE COLUMN NAME IS A FOSSIL. It was written for a MOVE — one current
// address, the rest history — and that model was wrong twice over. Jobber
// keeps every property live and bookable, so a client can have work running
// at two houses at once (Heather Popelka, North Pittsburgh). And in eight
// weeks and ~106 address edits the move branch ran ZERO times: the column is
// empty on all 21,055 rows. So the shape is now a plain list of the client's
// other addresses, each one live unless retired. The column keeps its name
// because renaming it would touch the inbound webhook's jsonb containment
// filter for no owner-visible gain; the meaning is here, in the type.
//
// Each entry carries the Jobber property it IS, so inbound property events
// route to it instead of stomping the primary address.
//
// status: 'active' — offered at send time, shown on the card
//         'retired' — Bee Hub stops offering it; JOBBER IS UNCHANGED. There
//                     is no archive in Jobber (deletion is the only option
//                     and it takes the property's quotes and jobs with it),
//                     so retiring is our opinion about what to offer next,
//                     never a change to the other system.
// Legacy entries carry neither status nor label; they read as active and
// unlabelled, so nothing written before this is lost or hidden.

export type AddressStatus = 'active' | 'retired'

export interface FormerAddress {
  street: string
  city: string
  state: string
  zip: string
  display: string
  jobber_property_id: string | null
  moved_at: string
  // Added with the address model. All optional on read — see above.
  label?: string | null
  label_note?: string | null
  status?: AddressStatus
  added_at?: string
}

// An entry is live unless it explicitly says otherwise. A missing status is
// the legacy case and must read as active — never as hidden.
export function isRetiredAddress(e: { status?: unknown } | null | undefined): boolean {
  return String((e as any)?.status ?? '') === 'retired'
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

// The entry the ADD path appends — an address the client also has, built
// from typed parts rather than from the lead's before-state. jobberPropertyId
// is the property just created for it (null when the client isn't in Jobber
// yet; the send creates it later).
export function buildAddedAddress(
  parts: { street: string; city: string; state: string; zip: string },
  jobberPropertyId: string | null | undefined,
  label: string | null,
  labelNote: string | null,
  nowIso: string,
): FormerAddress | null {
  const street = String(parts.street ?? '').trim()
  if (!street) return null
  const city = String(parts.city ?? '').trim()
  const state = String(parts.state ?? '').trim()
  const zip = String(parts.zip ?? '').trim()
  const display = composeLeadAddress({ street, city, state, zip })
  if (!display) return null
  return {
    street, city, state, zip, display,
    jobber_property_id: jobberPropertyId ? String(jobberPropertyId) : null,
    moved_at: nowIso,
    added_at: nowIso,
    label: label ?? null,
    label_note: labelNote ?? null,
    status: 'active',
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
