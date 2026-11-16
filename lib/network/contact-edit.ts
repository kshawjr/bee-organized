// lib/network/contact-edit.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 4a — THE SAVING RULE. Pure: it decides
// what a save may write; it reads and writes nothing itself.
//
// THE FAULT THIS REPLACES. The old contact record sends a save as "here is
// the contact"; when it has no earlier copy to compare with, that becomes the
// WHOLE contact, and every field on the row is overwritten with whatever the
// screen happened to hold. (That is why rows could not be opened on All
// Locations in slice 3.) A screen should never be trusted to know what
// changed.
//
// THE RULE. A save names the fields the person changed, and for each one
// what it said when they opened it (`from`) and what they made it (`to`).
// The SERVER then decides, against the row as it is stored right now:
//
//   · a field not on the list below cannot be written at all;
//   · a field whose stored value already equals `to` is not written;
//   · a field whose stored value no longer equals `from` was changed by
//     someone else in the meantime: NOTHING is written and the save is
//     refused, so no edit is silently lost in either direction;
//   · what is left is written, and only that, plus updated_at;
//   · if nothing is left, nothing is written, not even updated_at.
//
// ONE CONSEQUENCE, stated rather than hidden: a birthday reminder cannot
// exist without a birthday (the table refuses it). Clearing a birthday that
// has a reminder therefore also turns the reminder off, and the answer says
// so in `written`.
//
// WHAT IS NOT EDITABLE HERE, on purpose: types, partner level and partner
// stage (they need the confirmation step, slice 6); tags, addresses, the
// company link, notes and next steps (slice 4b, each through its own door);
// and met_date, which holds the literal text "Just now" on 87 contacts and is
// neither shown nor written by anything in the new Network.
// ─────────────────────────────────────────────────────────────

import { phoneForWrite } from '@/lib/phone'

/** The fields a save may name → the partners column each one is. */
export const EDITABLE_FIELDS = {
  name: 'name',
  title: 'title',
  company: 'company',
  phone: 'phone',
  email: 'email',
  website: 'website',
  howWeMet: 'how_we_met',
  birthday: 'birthday',
  birthdayReminder: 'birthday_reminder',
} as const

export type EditableField = keyof typeof EDITABLE_FIELDS
export const EDITABLE_FIELD_NAMES = Object.keys(EDITABLE_FIELDS) as EditableField[]
/** Every column a save could ever write, updated_at included. Nothing else. */
export const WRITABLE_COLUMNS: readonly string[] = [...Object.values(EDITABLE_FIELDS), 'updated_at']

export type FieldChange = { from?: unknown; to: unknown }
export type ChangeSet = Partial<Record<EditableField, FieldChange>>

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS_IN = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

export type Normalized = { ok: true; value: string | boolean | null } | { ok: false; error: string }
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim()
const good = (value: string | boolean | null): Normalized => ({ ok: true, value })
const bad = (error: string): Normalized => ({ ok: false, error })

/** "mar 22" → "Mar 22". Month and day only; an impossible day is refused. */
export function normalizeBirthday(v: unknown): Normalized {
  const s = text(v)
  if (!s) return good(null)
  const m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})$/i)
  if (!m) return bad('birthday_unreadable')
  const month = MONTHS.findIndex((x) => x.toLowerCase() === m[1]!.toLowerCase())
  const day = Number(m[2])
  if (month < 0 || day < 1 || day > DAYS_IN[month]!) return bad('birthday_unreadable')
  return good(`${MONTHS[month]} ${day}`)
}

/**
 * What a typed value becomes before it is compared or stored. Text is
 * trimmed and an empty box means "nothing" (null), never an empty string.
 */
export function normalizeField(field: EditableField, v: unknown): Normalized {
  if (field === 'birthdayReminder') return typeof v === 'boolean' ? good(v) : bad('reminder_must_be_yes_or_no')
  if (field === 'birthday') return normalizeBirthday(v)
  const s = text(v)
  if (field === 'name') {
    if (!s) return bad('name_required')
    return s.length > 200 ? bad('name_too_long') : good(s)
  }
  if (!s) return good(null)
  if (s.length > 500) return bad(`${field}_too_long`)
  if (field === 'email') {
    const e = s.toLowerCase()
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 255 ? good(e) : bad('email_looks_wrong')
  }
  if (field === 'phone') {
    // Bee Hub's one phone rule (lib/phone.ts). A second number or words in
    // the box would be kept as a note on the timeline by the old record;
    // this save writes ONE column, so it asks for one number instead.
    const w = phoneForWrite(s)
    if (w.kind === 'unreadable') return bad('phone_unreadable')
    if (w.note) return bad('one_phone_number_only')
    return good(w.value)
  }
  return good(s)
}

/** A stored value, read the same way a typed one is, for comparing. */
function storedValue(field: EditableField, row: Record<string, unknown>): string | boolean | null {
  const raw = row[EDITABLE_FIELDS[field]]
  if (field === 'birthdayReminder') return raw === true
  const s = text(raw)
  return s ? s : null
}

/** Is what was typed the same as what is stored? Phones and emails compare as they would be saved. */
function sameAsStored(field: EditableField, stored: string | boolean | null, value: string | boolean | null): boolean {
  if (stored === value) return true
  if (typeof stored !== 'string' || typeof value !== 'string') return false
  if (field === 'email') return stored.toLowerCase() === value.toLowerCase()
  return false
}

export type SavePlan =
  | { ok: true; update: Record<string, string | boolean | null>; written: string[]; notes: string[] }
  | { ok: false; status: 400 | 409 | 422; error: string; field?: string; current?: string | boolean | null }

/**
 * Decide what a save writes. `row` is the stored row (column names);
 * `changes` is what the screen says the person changed. The update handed
 * back holds ONLY the columns that really change; updated_at is the caller's
 * to add, and only when `written` is not empty.
 */
export function planContactSave(row: Record<string, unknown>, changes: unknown): SavePlan {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return { ok: false, status: 400, error: 'changes_required' }
  const entries = Object.entries(changes as Record<string, unknown>)
  if (entries.length === 0) return { ok: false, status: 400, error: 'changes_required' }

  const next: Partial<Record<EditableField, string | boolean | null>> = {}
  for (const [field, change] of entries) {
    if (!EDITABLE_FIELD_NAMES.includes(field as EditableField)) return { ok: false, status: 400, error: 'field_not_editable', field }
    if (!change || typeof change !== 'object' || !('to' in (change as object))) return { ok: false, status: 400, error: 'change_needs_to', field }
    const f = field as EditableField
    const c = change as FieldChange
    const to = normalizeField(f, c.to)
    if (!to.ok) return { ok: false, status: 422, error: to.error, field }
    const stored = storedValue(f, row)
    // Changed by someone else since this person opened it? Refuse the lot.
    if ('from' in c) {
      const from = f === 'birthdayReminder' ? c.from === true : (text(c.from) || null)
      if (!sameAsStored(f, stored, from)) return { ok: false, status: 409, error: 'changed_by_someone_else', field, current: stored }
    }
    if (!sameAsStored(f, stored, to.value)) next[f] = to.value
  }

  // A reminder needs a birthday (the table's own rule).
  const notes: string[] = []
  const birthdayAfter = 'birthday' in next ? next.birthday : storedValue('birthday', row)
  const reminderAfter = 'birthdayReminder' in next ? next.birthdayReminder : storedValue('birthdayReminder', row)
  if (reminderAfter === true && !birthdayAfter) {
    if (next.birthdayReminder === true) return { ok: false, status: 422, error: 'reminder_needs_a_birthday', field: 'birthdayReminder' }
    next.birthdayReminder = false
    notes.push('The birthday reminder was turned off because the birthday was removed.')
  }

  const update: Record<string, string | boolean | null> = {}
  for (const f of EDITABLE_FIELD_NAMES) if (f in next) update[EDITABLE_FIELDS[f]] = next[f] as string | boolean | null
  return { ok: true, update, written: Object.keys(update), notes }
}

/**
 * The screen's half: from what was loaded and what the form now holds, name
 * only the fields the person changed, each with what it said before. A field
 * left alone is not in the answer, so it is never sent.
 */
export function changesBetween(
  loaded: Partial<Record<EditableField, unknown>>,
  form: Partial<Record<EditableField, unknown>>,
): ChangeSet {
  const out: ChangeSet = {}
  for (const f of EDITABLE_FIELD_NAMES) {
    if (!(f in form)) continue
    const before = f === 'birthdayReminder' ? loaded[f] === true : text(loaded[f])
    const after = f === 'birthdayReminder' ? form[f] === true : text(form[f])
    if (before !== after) out[f] = { from: f === 'birthdayReminder' ? before : (before || null), to: f === 'birthdayReminder' ? after : (after || null) }
  }
  return out
}

/** Plain words for each refusal, for the sheet to show beside the field. */
export const SAVE_ERROR_WORDS: Record<string, string> = {
  name_required: 'A contact needs a name.',
  name_too_long: 'That name is too long.',
  email_looks_wrong: 'That email does not look right. It should read like name@example.com.',
  phone_unreadable: 'That does not read as a phone number.',
  one_phone_number_only: 'Enter one phone number here. A second number can go in a note.',
  birthday_unreadable: 'Pick a month and a day that exists.',
  reminder_needs_a_birthday: 'Add a birthday before asking for a reminder.',
  changed_by_someone_else: 'Someone else changed this while you were editing. Nothing was saved. The sheet now shows what it says.',
  field_not_editable: 'That cannot be changed here.',
}
export const saveErrorWords = (error: string) => SAVE_ERROR_WORDS[error] || 'That could not be saved. Nothing was changed.'
