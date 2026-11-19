// lib/network/contact-create.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 5 — ADDING CONTACTS. Pure: no database,
// no React. It decides, from what was typed or what a file says, exactly
// which rows would be written. The two routes that write them
// (app/api/network/contacts and app/api/network/import) only read what this
// file needs and write what it hands back.
//
// TWO DOORS, ONE ROW SHAPE (newContactRow):
//   · the add flow: one person, typed by hand
//   · an import: many people, from a CSV file
// Both write the same columns, nothing else: name, first_name, last_name
// (lib/network/names.ts: the Clients convention), title, company, phone,
// email, how_we_met, birthday, birthday_reminder, network_types, and for a
// Referral partner only, partner_level and partner_stage. Plus location_id,
// created_by and the old `type` column ('partner', its own default). An
// import may also write notes (a phone it tidied, an Interest it could not
// file elsewhere). Nothing is written to any other column.
//
// KEVIN'S TWO RULINGS ON IMPORT (2026-11-17):
//   1. A tag word in the file that is not one of the location's Network
//      tags: the contact still comes in, the tag is left off, and the word
//      is named once in the summary. A file never MAKES a tag.
//   2. A row whose email is already on a live contact AT THIS LOCATION:
//      the row is skipped, and the summary names who it matched. The
//      existing contact is never changed by a file. Emails are compared
//      lowercased and trimmed (14 stored emails are not lowercased). Another
//      location holding the same person is not a duplicate. Two rows in
//      the SAME file with the same email: the first comes in, the later
//      one is skipped, naming the first by its line.
//   3. A row with NO email (Kevin, 2026-11-18, so a whole file can be run
//      again safely) is a duplicate of a contact here, or an earlier row of
//      the file, when (a) the name AND the phone match, or (b) the name
//      matches and NEITHER has a phone. A contact with a phone is never
//      matched by a row without one. Names: trimmed, inner spaces
//      collapsed, case ignored (nameKey). Phones: digits only, by Bee Hub's
//      one phone key (lib/phone.ts phoneKey). A row WITH an email uses the
//      email rule only.
//
// A ROW THAT CANNOT BE READ (no name, a phone or email or birthday that does
// not read, a field too long) is SKIPPED AND NAMED, by line and reason, and
// the rest of the file comes in: the same as a duplicate (Kevin's
// correction, 2026-11-18: "half a file in is worse than none" was only ever
// about SAVING). Saving stays all or nothing (contact-writes.ts): the rows
// that survive reading either all save or none do. Only a file that is not
// a usable CSV at all (not_csv, no Name column, too big, no rows) is refused
// whole.
//
// THE ADD FLOW checks the same duplicate rules (findDuplicate): an email
// already on a live contact here, or with no email the same name and phone
// (or name, no phone either side), is refused, naming who, unless the
// person ticks "add anyway" on purpose.
//
// What the add flow does NOT carry, on purpose (Kevin, slice 5 brief):
// partner level and stage (slice 6, with their confirmation), consent,
// campaigns and workflows, Mailchimp, the business card reader. A Referral
// partner added by hand is stored with no level and no stage; every screen
// already reads that as Potential, New Contact (lib/network/types.ts).
// ─────────────────────────────────────────────────────────────

import { normalizeField, normalizeBirthday, type EditableField } from './contact-edit'
import { normalizeTypes, NET_TYPES, type NetType } from './types'
import { parseCsv, rowsToContacts } from './csv'
import { contactNames } from './names'
import { phoneKey } from '@/lib/phone'
import { tagKey, tagShowsOn, cleanTagIds, MAX_TAGS_PER_CREATE, TAG_CATEGORY } from '@/lib/tags'

/** The biggest file an import takes, by characters and by rows. */
export const IMPORT_MAX_CHARS = 1_000_000
export const IMPORT_MAX_ROWS = 1000

/** The columns a new contact may be written with. The routes write these and nothing else. */
export const NEW_CONTACT_COLUMNS = [
  'location_id', 'type', 'created_by', 'name', 'first_name', 'last_name', 'title', 'company', 'phone', 'email', 'how_we_met',
  'birthday', 'birthday_reminder', 'network_types', 'partner_level', 'partner_stage', 'notes',
] as const

export type NewContactRow = {
  location_id: string
  type: 'partner'
  created_by: string | null
  name: string
  first_name: string | null
  last_name: string | null
  title: string | null
  company: string | null
  phone: string | null
  email: string | null
  how_we_met: string | null
  birthday: string | null
  birthday_reminder: boolean
  network_types: NetType[]
  partner_level: string | null
  partner_stage: string | null
  notes: { id: string; text: string; ts: string; user: string }[]
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim()

/** A tag as the location's tag list hands it over (GET /api/lookups rows). */
export type TagDef = { id: string; label: string; category?: string | null; location_id?: string | null; is_active?: boolean | null; attrs?: any }

/** The tags a contact at this location may carry from the Network screen. */
export function networkTagsFor(tags: readonly TagDef[], locationId: string): TagDef[] {
  return tags.filter((t) =>
    t && typeof t.id === 'string' && text(t.label) &&
    (t.category ?? TAG_CATEGORY) === TAG_CATEGORY &&
    t.is_active !== false &&
    (!t.location_id || t.location_id === locationId) &&
    tagShowsOn(t, 'network'))
}

// ── THE ADD FLOW ─────────────────────────────────────────────
export type NewContactInput = {
  /** A person: first and last. An organization: name. A bare name for a person is split first word / rest. */
  name?: unknown; firstName?: unknown; lastName?: unknown; types?: unknown; company?: unknown; title?: unknown; phone?: unknown; email?: unknown
  birthday?: unknown; birthdayReminder?: unknown; howWeMet?: unknown; tagIds?: unknown
  interest?: unknown; addAnyway?: unknown
}
export type NewContactPlan =
  | { ok: true; row: NewContactRow; tagIds: string[] }
  | { ok: false; error: string; field: string; matched?: { id: string; name: string } }

/** How two emails are compared, everywhere: lowercased and trimmed. Blank is no email. */
export const emailKey = (v: unknown) => text(v).toLowerCase()
/** How two names are compared: trimmed, inner spaces collapsed, case ignored. */
export const nameKey = (v: unknown) => text(v).replace(/\s+/g, ' ').toLowerCase()

/** Which rule found a duplicate. */
export type DupRule = 'email' | 'name_phone' | 'name_only'

/**
 * The first contact in `existing` this one duplicates, and by which rule, or
 * null. With an email: the email rule only. With no email: same name and
 * phone, or same name and no phone on either side.
 */
export function findDuplicate<T extends { name?: unknown; email?: unknown; phone?: unknown }>(
  who: { name?: unknown; email?: unknown; phone?: unknown },
  existing: readonly T[],
): { match: T; rule: DupRule } | null {
  const ek = emailKey(who.email)
  if (ek) {
    const m = existing.find((e) => emailKey(e.email) === ek)
    return m ? { match: m, rule: 'email' } : null
  }
  const nk = nameKey(who.name)
  if (!nk) return null
  const pk = phoneKey(who.phone)
  const m = existing.find((e) => nameKey(e.name) === nk && phoneKey(e.phone) === pk)
  return m ? { match: m, rule: pk ? 'name_phone' : 'name_only' } : null
}

/** The add flow's refusal code for each rule. */
const DUP_ERROR: Record<DupRule, string> = { email: 'email_already_here', name_phone: 'name_and_phone_already_here', name_only: 'name_already_here' }
export const DUP_ERRORS = Object.values(DUP_ERROR)

const ADD_FIELDS: [keyof NewContactInput, EditableField][] = [
  ['title', 'title'], ['company', 'company'], ['phone', 'phone'], ['email', 'email'], ['howWeMet', 'howWeMet'], ['birthday', 'birthday'],
]

/**
 * One contact typed into the add flow. Each field is read by the SAME rule
 * the contact sheet uses to save it (lib/network/contact-edit.ts
 * normalizeField), so a value the sheet would refuse is refused here too.
 * Tags must be ids of this location's Network tags (`allowed`); anything
 * else is refused rather than quietly dropped.
 */
export function planNewContact(
  input: NewContactInput,
  ctx: { locationId: string; userId: string | null; allowedTagIds: readonly string[]; existing?: readonly ExistingContact[]; author?: string; now?: Date },
): NewContactPlan {
  const b = (input && typeof input === 'object' ? input : {}) as NewContactInput
  const v: Record<string, string | null> = {}
  for (const [key, field] of ADD_FIELDS) {
    if (b[key] !== undefined && b[key] !== null && typeof b[key] !== 'string') return { ok: false, error: `${field}_must_be_text`, field: key }
    const n = normalizeField(field, b[key] ?? '')
    if (!n.ok) return { ok: false, error: n.error, field: key }
    v[key] = (n.value as string | null) ?? null
  }
  if (!Array.isArray(b.types) || b.types.length === 0) return { ok: false, error: 'types_required', field: 'types' }
  if (b.types.some((t) => !NET_TYPES.includes(t as NetType))) return { ok: false, error: 'type_unknown', field: 'types' }
  const types = normalizeTypes(b.types)
  const isOrg = types.includes('organization')

  // The name: one box for an organization, First and Last for a person, and
  // the full name set from them the way Clients does (lib/network/names.ts).
  for (const k of ['name', 'firstName', 'lastName'] as const) {
    if (b[k] !== undefined && b[k] !== null && typeof b[k] !== 'string') return { ok: false, error: 'name_must_be_text', field: k }
  }
  const names = contactNames({ first: b.firstName, last: b.lastName, name: b.name, isOrg })
  const nameField = isOrg || (b.firstName === undefined && b.lastName === undefined) ? 'name' : 'firstName'
  const nn = normalizeField('name', names.name)
  if (!nn.ok) return { ok: false, error: nn.error === 'name_required' && nameField === 'firstName' ? 'person_name_required' : nn.error, field: nameField }
  v.name = names.name

  if (b.birthdayReminder !== undefined && typeof b.birthdayReminder !== 'boolean') return { ok: false, error: 'reminder_must_be_yes_or_no', field: 'birthdayReminder' }
  // An organization has no birthday (the design, and csv.ts, agree).
  if (isOrg && v.birthday) return { ok: false, error: 'organization_has_no_birthday', field: 'birthday' }
  const reminder = b.birthdayReminder === true
  if (reminder && !v.birthday) return { ok: false, error: 'reminder_needs_a_birthday', field: 'birthdayReminder' }

  if (b.tagIds !== undefined && !Array.isArray(b.tagIds)) return { ok: false, error: 'tags_must_be_a_list', field: 'tagIds' }
  const asked = Array.isArray(b.tagIds) ? b.tagIds : []
  const tagIds = cleanTagIds(asked)
  if (asked.length > MAX_TAGS_PER_CREATE) return { ok: false, error: 'too_many_tags', field: 'tagIds' }
  if (tagIds.some((id) => !ctx.allowedTagIds.includes(id))) return { ok: false, error: 'tag_not_on_network_here', field: 'tagIds' }

  // Interest: Bee Hub has no column for it, so it is kept as the contact's
  // first note, the same way an import keeps it.
  if (b.interest !== undefined && b.interest !== null && typeof b.interest !== 'string') return { ok: false, error: 'interest_must_be_text', field: 'interest' }
  const interest = text(b.interest)
  if (interest.length > FIELD_MAX) return { ok: false, error: 'interest_too_long', field: 'interest' }

  // The duplicate rule the import uses. Possible, but only on purpose.
  if (b.addAnyway !== undefined && typeof b.addAnyway !== 'boolean') return { ok: false, error: 'add_anyway_must_be_yes_or_no', field: 'email' }
  const dup = findDuplicate({ name: v.name, email: v.email, phone: v.phone }, ctx.existing || [])
  if (dup && b.addAnyway !== true) return { ok: false, error: DUP_ERROR[dup.rule], field: dup.rule === 'email' ? 'email' : 'name', matched: { id: dup.match.id, name: text(dup.match.name) || 'Unnamed' } }

  const now = ctx.now || new Date()
  const notes: NewContactRow['notes'] = interest ? [{ id: `n${now.getTime()}`, text: `Interest: ${interest}`, ts: now.toISOString(), user: text(ctx.author) || 'Bee Hub' }] : []

  return {
    ok: true,
    tagIds,
    row: {
      location_id: ctx.locationId,
      type: 'partner',
      created_by: ctx.userId,
      name: v.name as string,
      first_name: names.first_name,
      last_name: names.last_name,
      title: v.title, company: v.company, phone: v.phone, email: v.email, how_we_met: v.howWeMet,
      birthday: v.birthday,
      birthday_reminder: reminder,
      network_types: types,
      partner_level: null,
      partner_stage: null,
      notes,
    },
  }
}

/** Plain words for the add flow's refusals that the sheet's list does not already have. */
export const ADD_ERROR_WORDS: Record<string, string> = {
  types_required: 'Pick at least one: what are they to you?',
  type_unknown: 'That type is not one we use.',
  organization_has_no_birthday: 'An organization has no birthday. Take it out, or untick Organization.',
  too_many_tags: `A new contact can carry ${MAX_TAGS_PER_CREATE} tags at most. Add more from their sheet.`,
  tag_not_on_network_here: 'One of those tags is not on this location’s Network list any more. Pick the tags again.',
  location_required: 'Pick one location first. A contact belongs to one location.',
  interest_too_long: 'Keep Interest under 500 characters. Put the rest in a note on their sheet.',
  email_already_here: 'Someone at this location already has that email.',
  name_and_phone_already_here: 'Someone at this location already has that name and phone.',
  name_already_here: 'Someone at this location already has that name, and neither of you has a phone.',
  person_name_required: 'A person needs a first or last name.',
  name_must_be_text: 'A name must be text.',
}

// ── AN IMPORT ────────────────────────────────────────────────
export type ExistingContact = { id: string; name: string; email: string | null; phone?: string | null }
export type ImportProblem = { line: number; name: string; problems: string[] }
export type ImportSkip = { line: number; name: string; email: string | null; phone: string | null; rule: DupRule; matched: { id: string | null; name: string; line: number | null } }
export type ImportWrite = { line: number; row: NewContactRow; tagIds: string[] }
export type ImportPlan =
  | { ok: false; reason: 'not_csv' | 'no_name_column' | 'too_big' | 'too_many_rows' | 'no_rows'; problems: []; rows: [] }
  | {
      ok: true
      reason?: undefined
      problems?: undefined
      rows: ImportWrite[]
      /** Rows that could not be read: left out, each named by line and reason. */
      unreadable: ImportProblem[]
      skipped: ImportSkip[]
      /** Every tag word no Network tag here matched, once each, in file order. */
      unmatchedTags: string[]
      /** Things to tell the owner about rows that DID come in. */
      warnings: { line: number; name: string; words: string }[]
    }

const FIELD_MAX = 500
const NAME_MAX = 200

/** Does this text look like something other than a CSV (a spreadsheet, a picture, a PDF)? */
export function looksBinary(s: string): boolean {
  if (s.startsWith('PK') || s.startsWith('%PDF') || s.startsWith('ÿØ')) return true
  const head = s.slice(0, 4000)
  if (head.includes('\u0000')) return true
  // The replacement character: what a browser makes of bytes that are not text.
  const bad = (head.match(/�/g) || []).length
  return head.length > 0 && bad / head.length > 0.05
}

/**
 * Each non-blank record's ROW NUMBER in the spreadsheet, in order (the header
 * is usually row 1). parseCsv (csv.ts, left as it is) drops blank rows, and
 * rowsToContacts numbers what is left, so after one blank row every "Row N"
 * would point one row too high. This walks the file by the same quote rules
 * and remembers where each kept record really sits, so a skipped row is
 * named by the row the owner sees in Excel. A quoted cell with a line break
 * inside stays one row, as it does in a spreadsheet.
 */
export function keptRowNumbers(src: string): number[] {
  const out: number[] = []
  const t = src.replace(/^\uFEFF/, '')
  let rowNo = 1
  let filled = false
  let quoted = false
  const end = () => { if (filled) out.push(rowNo); rowNo++; filled = false }
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') { filled = true; i++ }
      else if (ch === '"') quoted = false
      else if (ch.trim()) filled = true
    } else if (ch === '"') quoted = true
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; end() }
    else if (ch !== ',' && ch.trim()) filled = true
  }
  if (filled) out.push(rowNo)
  return out
}

/**
 * A whole CSV file, planned against the location it is going into.
 *   tags      that location's tag list (networkTagsFor picks the usable ones)
 *   existing  that location's LIVE contacts, for the duplicate check
 */
export function planImport(
  csvText: string,
  ctx: { locationId: string; userId: string | null; tags: readonly TagDef[]; existing: readonly ExistingContact[]; now: Date },
): ImportPlan {
  const refuse = (reason: 'not_csv' | 'no_name_column' | 'too_big' | 'too_many_rows' | 'no_rows') => ({ ok: false as const, reason, problems: [] as [], rows: [] as [] })
  if (typeof csvText !== 'string') return refuse('not_csv')
  if (csvText.length > IMPORT_MAX_CHARS) return refuse('too_big')
  if (looksBinary(csvText)) return refuse('not_csv')
  const table = parseCsv(csvText)
  if (!table[0]?.some((h) => ['name', 'first name', 'last name'].includes(h.trim().toLowerCase()))) return refuse('no_name_column')
  if (table.length - 1 > IMPORT_MAX_ROWS) return refuse('too_many_rows')
  if (table.length < 2) return refuse('no_rows')

  const read = rowsToContacts(table, 'imp')
  // rowsToContacts' line is the place in the blank-free table (header = 1);
  // rowOf turns it into the real spreadsheet row. cellAt reads the table.
  const kept = keptRowNumbers(csvText)
  const rowOf = (line: number) => kept[line - 1] ?? line
  const head = table[0]!.map((h) => h.trim().toLowerCase())
  /** What the file itself says in a column on a line, before any default. */
  const cellAt = (line: number, column: string) => { const i = head.indexOf(column.toLowerCase()); return i >= 0 ? text(table[line - 1]?.[i]) : '' }
  const problems: ImportProblem[] = []
  const planned: { line: number; c: NonNullable<(typeof read)[number]['contact']>; warnings: string[]; birthday: string | null }[] = []
  for (const r of read) {
    const name = text(r.contact?.name) || cellAt(r.line, 'Name') || [cellAt(r.line, 'First name'), cellAt(r.line, 'Last name')].filter(Boolean).join(' ')
    const p = [...r.problems]
    let birthday: string | null = null
    if (r.contact) {
      const c = r.contact
      if (c.name.length > NAME_MAX) p.push('Name is longer than 200 characters')
      for (const [label, val] of [['Company', c.company], ['Job title', c.role], ['How met', c.howMet], ['Interest', c.interest], ['Phone', c.phone]] as const) {
        if (val && val.length > FIELD_MAX) p.push(`${label} is longer than ${FIELD_MAX} characters`)
      }
      if (c.birthday) {
        const b = normalizeBirthday(c.birthday)
        if (!b.ok) p.push(`Birthday “${c.birthday}” isn’t a month and day like Mar 22`)
        else birthday = b.value as string | null
      }
    }
    if (p.length) problems.push({ line: rowOf(r.line), name, problems: p })
    else planned.push({ line: r.line, c: r.contact!, warnings: r.warnings, birthday })
  }

  // Tags: the words in the file, matched to this location's Network tags by
  // the same key the tag list uses to spot near-matches (case, spacing and a
  // plural do not matter). A location's own tag wins over a corporate one of
  // the same key.
  const usable = networkTagsFor(ctx.tags, ctx.locationId)
  const byKey = new Map<string, TagDef>()
  for (const t of [...usable].sort((a, b) => Number(!!b.location_id) - Number(!!a.location_id))) {
    const k = tagKey(t.label)
    if (k && !byKey.has(k)) byKey.set(k, t)
  }
  const unmatched: string[] = []
  const unmatchedKeys = new Set<string>()

  // Duplicates, at this location only: every live contact here, then each
  // row as it is planned, so a later row can match an earlier one.
  type Known = { id: string | null; name: string; line: number | null; email: string | null; phone: string | null }
  const known: Known[] = ctx.existing.map((e) => ({ id: e.id, name: text(e.name) || 'Unnamed', line: null, email: e.email, phone: e.phone ?? null }))

  const rows: ImportWrite[] = []
  const skipped: ImportSkip[] = []
  const warnings: { line: number; name: string; words: string }[] = []
  const ts = ctx.now.toISOString()
  for (const { line: at, c, warnings: w, birthday } of planned) {
    const line = rowOf(at)
    const email = emailKey(c.email) || null
    const phone = c.phone || null
    const dup = findDuplicate({ name: c.name, email, phone }, known)
    if (dup) {
      skipped.push({ line, name: c.name, email, phone, rule: dup.rule, matched: { id: dup.match.id, name: dup.match.name, line: dup.match.line } })
      continue
    }
    known.push({ id: null, name: c.name, line, email, phone })

    const tagIds: string[] = []
    for (const word of c.tags) {
      const k = tagKey(word)
      const t = k ? byKey.get(k) : undefined
      if (!t) {
        const shown = text(word)
        if (shown && !unmatchedKeys.has(k || shown.toLowerCase())) { unmatchedKeys.add(k || shown.toLowerCase()); unmatched.push(shown) }
        continue
      }
      if (!tagIds.includes(t.id)) tagIds.push(t.id)
    }
    const keptTags = tagIds.slice(0, MAX_TAGS_PER_CREATE)
    if (tagIds.length > keptTags.length) w.push(`Only the first ${MAX_TAGS_PER_CREATE} tags were put on; add the rest from their sheet`)

    const types = normalizeTypes(c.types)
    const isPartner = types.includes('partner')
    const notes: NewContactRow['notes'] = []
    for (const n of c.notes || []) notes.push({ id: `n${ctx.now.getTime()}-${line}-${notes.length}`, text: n.text, ts, user: 'Import' })
    if (c.interest) {
      notes.push({ id: `n${ctx.now.getTime()}-${line}-${notes.length}`, text: `Interest, from the import: ${c.interest}`, ts, user: 'Import' })
      w.push('Interest kept as a note')
    }
    rows.push({
      line,
      tagIds: keptTags,
      row: {
        location_id: ctx.locationId,
        type: 'partner',
        created_by: ctx.userId,
        name: c.name,
        first_name: c.firstName || null,
        last_name: c.lastName || null,
        title: c.role || null,
        company: c.company || null,
        phone: c.phone || null,
        email,
        how_we_met: c.howMet || null,
        birthday,
        birthday_reminder: false,
        network_types: types,
        // Only what the file names. A blank cell stores nothing, as the add
        // flow does, and every screen reads that as Potential / New Contact.
        partner_level: isPartner && cellAt(at, 'Partner level') ? c.level ?? null : null,
        partner_stage: isPartner && cellAt(at, 'Stage') ? c.stage ?? null : null,
        notes,
      },
    })
    for (const words of w) warnings.push({ line, name: c.name, words })
  }
  return { ok: true, rows, unreadable: problems, skipped, unmatchedTags: unmatched, warnings }
}

/** The import's refusals, in plain words. */
export const IMPORT_REFUSAL_WORDS: Record<string, string> = {
  not_csv: 'That file is not a CSV. In Excel or Google Sheets, choose File › Save as (or Download) › CSV, then choose that file here.',
  no_name_column: 'We couldn’t find a name column. Start from the sample file, or name the column that holds people’s names “Name” (or use “First name” and “Last name”).',
  too_big: 'That file is too big to bring in at once. Split it into files of a thousand rows or fewer.',
  too_many_rows: `That file has more than ${IMPORT_MAX_ROWS} rows. Split it into smaller files.`,
  no_rows: 'That file has the headings but no contacts under them.',
  location_required: 'Pick one location first. An import goes into the location you are looking at.',
}
