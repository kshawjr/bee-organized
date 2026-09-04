// lib/address-labels.ts
//
// THE five address labels. A fixed set, not free text (Kevin's ruling).
//
// A label answers the question an address alone cannot: WHICH ONE IS THIS.
// "2101 Lenox Oval" and "118 Elmhurst Rd" tell an owner nothing about which
// house the client actually lives in now, or which is the office. Five
// choices cover what a home-organizing franchise sees, and a fixed set keeps
// the card scannable — thirty owners inventing thirty words for "the old
// place" is what free text would have produced.
//
// 'other' is the escape hatch, and it REQUIRES a note, so an address labelled
// Other still says what it is. That is the whole reason a fixed set is safe:
// nothing is unlabellable, it just has to be spelled out once.
//
// WHERE THE LABEL LIVES: Bee Hub only, for now. Jobber's Property type is not
// confirmed to carry a name field — the developer docs are behind a login that
// returns 403 to us, and the repo's read-only introspection script needs an
// .env.local this machine does not have. Pushing a label into a field that may
// not exist would break propertyCreate/propertyEdit, which are live paths. So
// the label is ours until that one introspection is run; §3 of the report says
// exactly how. What both systems share is the ADDRESS, which is the only thing
// that has to agree.
//
// NEVER put the label in street2. That field prints on quotes and invoices and
// is what the crew navigates to — "Second home" on an invoice line is a defect.

export type AddressLabel = 'home' | 'second_home' | 'office' | 'storage' | 'other'

export interface AddressLabelOption {
  value: AddressLabel
  text: string
  requiresNote: boolean
}

// Order is the order they render. Home first — it is the default and the
// overwhelmingly common answer; Other last, where an escape hatch belongs.
export const ADDRESS_LABELS: readonly AddressLabelOption[] = [
  { value: 'home',        text: 'Home',        requiresNote: false },
  { value: 'second_home', text: 'Second home', requiresNote: false },
  { value: 'office',      text: 'Office',      requiresNote: false },
  { value: 'storage',     text: 'Storage',     requiresNote: false },
  { value: 'other',       text: 'Other',       requiresNote: true  },
] as const

export const ADDRESS_LABEL_VALUES: readonly AddressLabel[] =
  ADDRESS_LABELS.map(l => l.value)

export const DEFAULT_ADDRESS_LABEL: AddressLabel = 'home'

// A note is only meaningful on 'other', and only up to a card-width caption.
export const LABEL_NOTE_MAX = 40

export function isAddressLabel(v: unknown): v is AddressLabel {
  return typeof v === 'string' && (ADDRESS_LABEL_VALUES as readonly string[]).includes(v)
}

// What the card shows. 'other' renders its note instead of the bare word —
// "Other" alone would be the label saying nothing, which is the failure a
// fixed set is otherwise prone to. A noteless 'other' (legacy row, or a
// note cleared out of band) degrades to "Other" rather than to blank.
export function addressLabelText(
  label: unknown,
  note?: unknown,
): string | null {
  if (!isAddressLabel(label)) return null
  if (label === 'other') {
    const n = String(note ?? '').trim()
    return n ? n.slice(0, LABEL_NOTE_MAX) : 'Other'
  }
  return ADDRESS_LABELS.find(l => l.value === label)!.text
}

// Server-side validation, shared by the add and the relabel paths so one
// answer governs both. Returns the normalized pair, or an error code the
// route turns into a 400.
export function validateAddressLabel(
  label: unknown,
  note: unknown,
): { ok: true; label: AddressLabel; note: string | null } | { ok: false; error: string } {
  if (label === undefined || label === null || label === '') {
    return { ok: true, label: DEFAULT_ADDRESS_LABEL, note: null }
  }
  if (!isAddressLabel(label)) return { ok: false, error: 'invalid_address_label' }
  if (label !== 'other') return { ok: true, label, note: null } // a note is meaningless off 'other'
  const n = String(note ?? '').trim()
  if (!n) return { ok: false, error: 'other_label_requires_a_note' }
  return { ok: true, label, note: n.slice(0, LABEL_NOTE_MAX) }
}
