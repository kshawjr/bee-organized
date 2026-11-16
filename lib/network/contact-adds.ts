// lib/network/contact-adds.ts
// ───────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 4b — ADDING TO A CONTACT. Pure: it
// decides what each add may write; it reads and writes nothing itself.
//
// Six things can now be done from the contact sheet. Three of them already
// have a home in Bee Hub, and the sheet uses that home, unchanged, so that
// there is one system and not two:
//
//   a touchpoint   POST /api/touchpoints    one new touchpoints row; that
//                                           route also stamps the contact's
//                                           last-contacted date
//   a follow-up    POST /api/reminders      one new reminders row. It IS a
//                                           reminder: same table, same Home
//                                           block, same Reminders page
//   tags           POST / DELETE            one partner_tags link added or
//                  /api/partner-tags        removed per tag that changed
//
// The other three live on the contact's own row, and go through the sheet's
// own save (PATCH /api/network/contacts/<id>) under slice 4a's rule: the
// server compares with the row as stored and writes only what differs.
//
//   a note         `addNote: { text }`. The SERVER appends it to the notes
//                  already stored, so a note someone else added a moment ago
//                  is never lost, and stamps the time and the author itself.
//   addresses      `addresses: { from, to }`. Refused if the stored list is
//                  no longer `from`. An entry nobody touched is kept exactly
//                  as stored, key for key.
//   company link   `companyId: { from, to }`. The link is an id in the
//                  companies table, picked from that table. It is never
//                  worked out from the company text, and it never changes it.
//
// Each of those writes its one column and updated_at, and nothing when
// nothing differs.
// ───────────────────────────────────────────────────────────

import { quickDates, isValidYmd, REMINDER_NOTE_MAX } from '@/lib/reminders'

export const NOTE_MAX = 2000
export const ADDRESS_MAX = 5
export const ADDRESS_TYPES = ['Business', 'Office', 'Home', 'Mailing', 'Other'] as const
export const ADDRESS_PARTS = ['street', 'apt', 'city', 'state', 'zip'] as const
const ADDRESS_KEYS = ['type', 'value', ...ADDRESS_PARTS] as const

/** The partners columns slice 4b can write through the sheet's own save. */
export const ADD_COLUMNS = { addNote: 'notes', addresses: 'addresses', companyId: 'company_id' } as const
export const ADD_KEYS = Object.keys(ADD_COLUMNS) as (keyof typeof ADD_COLUMNS)[]

/** The touchpoint types Bee Hub already has (components/hive/TouchpointModal METHODS). */
export const TOUCH_METHODS = [
  { value: 'call', label: 'Call' },
  { value: 'sms', label: 'Text' },
  { value: 'email', label: 'Email' },
  { value: 'in_person', label: 'In person' },
] as const
/** And its optional outcomes (components/hive/shared/touchOutcome OUTCOMES). */
export const TOUCH_OUTCOMES = [
  { value: 'reached', label: 'Reached' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'voicemail', label: 'Left voicemail' },
] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const text = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim()

/** The same thing whatever order its keys were written in. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}
const asList = (v: unknown): any[] => (Array.isArray(v) ? v : [])

export type AddPlan =
  | { ok: true; update: Record<string, unknown>; written: string[]; notes: string[] }
  | { ok: false; status: 400 | 409 | 422; error: string; field?: string; current?: unknown }

type Refusal = Extract<AddPlan, { ok: false }>
const refuse = (status: 400 | 409 | 422, error: string, field?: string, current?: unknown): Refusal => ({ ok: false, status, error, field, current })

/** A new note, appended to what is stored. */
export function planNote(row: Record<string, unknown>, addNote: unknown, ctx: { author: string; now: Date }): { notes: unknown[] } | Refusal {
  if (!addNote || typeof addNote !== 'object' || Array.isArray(addNote)) return refuse(400, 'note_needs_text', 'addNote')
  const t = text((addNote as any).text)
  if (!t) return refuse(422, 'note_needs_text', 'addNote')
  if (t.length > NOTE_MAX) return refuse(422, 'note_too_long', 'addNote')
  const stored = asList(row.notes)
  // The same shape the notes already hold: { id, text, ts, user }.
  return { notes: [...stored, { id: `n${ctx.now.getTime()}`, text: t, ts: ctx.now.toISOString(), user: text(ctx.author) || 'Bee Hub' }] }
}

/** One address line, the way Bee Hub's add form writes it (NetworkAddSheet). */
export function composeAddress(a: Record<string, string>): string {
  return [[a.street, a.apt].filter(Boolean).join(' '), a.city, a.state, a.zip].filter(Boolean).join(', ')
}

/**
 * The address list as it will be stored. An entry that matches a stored one
 * is that stored entry, untouched. An entry with any of street / apt / city /
 * state / zip is a full address and gets its one-line `value` rebuilt; an
 * entry with only a line of text keeps the older two-key shape.
 */
export function normalizeAddresses(stored: unknown, to: unknown): { ok: true; value: unknown[] } | { ok: false; error: string } {
  if (!Array.isArray(to)) return { ok: false, error: 'addresses_must_be_a_list' }
  const kept = asList(stored)
  const keptBy = new Map(kept.map((a) => [stable(a), a]))
  const out: unknown[] = []
  for (const raw of to) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'address_unreadable' }
    const same = keptBy.get(stable(raw))
    if (same) { out.push(same); continue }
    for (const k of Object.keys(raw)) if (!(ADDRESS_KEYS as readonly string[]).includes(k)) return { ok: false, error: 'address_unreadable' }
    const a: Record<string, string> = {}
    for (const k of ADDRESS_KEYS) if (k in (raw as object)) a[k] = text((raw as any)[k])
    if (Object.values(a).some((v) => v.length > 200)) return { ok: false, error: 'address_too_long' }
    const full = ADDRESS_PARTS.some((k) => k in a)
    const type = a.type || 'Business'
    if (full) {
      if (!ADDRESS_PARTS.some((k) => a[k])) continue // an empty block is no address
      if (!a.street && !a.city) return { ok: false, error: 'address_needs_street_or_city' }
      const parts = Object.fromEntries(ADDRESS_PARTS.map((k) => [k, a[k] || ''])) as Record<string, string>
      out.push({ type, value: composeAddress(parts), ...parts })
    } else {
      if (!a.value) continue
      out.push({ type, value: a.value })
    }
  }
  if (out.length > ADDRESS_MAX) return { ok: false, error: 'too_many_addresses' }
  return { ok: true, value: out }
}

/**
 * What the three row-level adds write. `body` is the request; `ctx.company`
 * is the companies row the route looked up for `companyId.to` (null when
 * there is none). The answer names only columns that really change.
 */
export function planContactAdds(
  row: Record<string, unknown>,
  body: unknown,
  ctx: { author: string; now: Date; company: { id: string; location_id: string; deleted_at: unknown } | null },
): AddPlan {
  const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>
  const update: Record<string, unknown> = {}

  if ('addNote' in b) {
    const n = planNote(row, b.addNote, ctx)
    if ('ok' in n) return n
    update.notes = n.notes
  }

  if ('addresses' in b) {
    const c = b.addresses as any
    if (!c || typeof c !== 'object' || !('to' in c)) return refuse(400, 'change_needs_to', 'addresses')
    const stored = asList(row.addresses)
    if ('from' in c && stable(asList(c.from)) !== stable(stored)) return refuse(409, 'changed_by_someone_else', 'addresses', stored)
    const to = normalizeAddresses(stored, c.to)
    if (!to.ok) return refuse(422, to.error, 'addresses')
    if (stable(to.value) !== stable(stored)) update.addresses = to.value
  }

  if ('companyId' in b) {
    const c = b.companyId as any
    if (!c || typeof c !== 'object' || !('to' in c)) return refuse(400, 'change_needs_to', 'companyId')
    const stored = text(row.company_id) || null
    if ('from' in c && (text(c.from) || null) !== stored) return refuse(409, 'changed_by_someone_else', 'companyId', stored)
    const to = text(c.to) || null
    if (to !== stored) {
      if (to) {
        if (!UUID.test(to)) return refuse(422, 'company_not_found', 'companyId')
        const co = ctx.company
        if (!co || co.id !== to || co.deleted_at) return refuse(422, 'company_not_found', 'companyId')
        if (co.location_id !== row.location_id) return refuse(422, 'company_other_location', 'companyId')
      }
      update.company_id = to
    }
  }

  return { ok: true, update, written: Object.keys(update), notes: [] }
}

// ── the screen's half ────────────────────────────────────────

/** Tags to link and to unlink: only the ones that changed. */
export function tagChanges(before: readonly string[], after: readonly string[]): { add: string[]; remove: string[] } {
  const uniq = (l: readonly string[]) => l.filter((id, i) => l.indexOf(id) === i)
  return { add: uniq(after).filter((id) => !before.includes(id)), remove: uniq(before).filter((id) => !after.includes(id)) }
}

/** What the sheet posts to /api/touchpoints: exactly what the old record posted. */
export function touchpointBody(contactId: string, form: { method: string; status?: string | null; notes?: string }) {
  return { partner_id: contactId, kind: 'reach_out', method: form.method, label: 'Reach-out', status: form.status || null, notes: text(form.notes) || null }
}

/** What the sheet posts to /api/reminders, or the plain reason it cannot. */
export function followUpBody(contactId: string, form: { dueOn: string; note: string }): { ok: true; body: { partner_id: string; due_on: string; note: string } } | { ok: false; error: string; field: string } {
  if (!isValidYmd(form.dueOn)) return { ok: false, error: 'follow_up_needs_a_date', field: 'dueOn' }
  const note = text(form.note)
  if (!note) return { ok: false, error: 'follow_up_needs_a_note', field: 'note' }
  if (note.length > REMINDER_NOTE_MAX) return { ok: false, error: 'follow_up_note_too_long', field: 'note' }
  return { ok: true, body: { partner_id: contactId, due_on: form.dueOn, note } }
}
export { quickDates }

/** A stored address as the form's boxes, and which shape it is. */
export function addressToForm(a: any) {
  const full = a && ADDRESS_PARTS.some((k) => k in a)
  return {
    stored: a ?? null, full: !!full, type: text(a?.type) || 'Business',
    street: text(a?.street), apt: text(a?.apt), city: text(a?.city), state: text(a?.state), zip: text(a?.zip), value: text(a?.value),
  }
}
export const blankAddress = () => addressToForm({ type: 'Business', street: '', apt: '', city: '', state: '', zip: '' })

/** The form's boxes as what is sent. A block nobody touched is sent as stored. */
export function addressFromForm(f: ReturnType<typeof addressToForm>): Record<string, unknown> {
  const was = f.stored ? addressToForm(f.stored) : null
  const keys = ['type', 'street', 'apt', 'city', 'state', 'zip', 'value'] as const
  if (was && keys.every((k) => text((f as any)[k]) === (was as any)[k])) return f.stored
  return f.full
    ? { type: f.type, street: text(f.street), apt: text(f.apt), city: text(f.city), state: text(f.state), zip: text(f.zip) }
    : { type: f.type, value: text(f.value) }
}

export const ADD_ERROR_WORDS: Record<string, string> = {
  note_needs_text: 'Write the note first.',
  note_too_long: 'That note is too long. Keep it under 2,000 characters.',
  addresses_must_be_a_list: 'That address could not be read.',
  address_unreadable: 'That address could not be read.',
  address_too_long: 'One of those address lines is too long.',
  address_needs_street_or_city: 'An address needs a street or a city.',
  too_many_addresses: 'A contact can hold up to five addresses.',
  company_not_found: 'That company is no longer in your Companies list.',
  company_other_location: 'That company belongs to a different location.',
  follow_up_needs_a_date: 'Pick the day to follow up.',
  follow_up_needs_a_note: 'Say what the follow-up is about.',
  follow_up_note_too_long: 'Keep the follow-up note under 500 characters.',
  // what the existing routes answer
  due_on_required: 'Pick the day to follow up.',
  note_required: 'Say what the follow-up is about.',
  record_not_found: 'This contact is no longer in Network.',
  partner_not_found: 'This contact is no longer in Network.',
  tag_lookup_not_found: 'That tag is no longer in the tag list.',
  tag_lookup_wrong_location: 'That tag belongs to a different location.',
  forbidden_read_only_location: 'This location is paused, so nothing can be changed.',
}
