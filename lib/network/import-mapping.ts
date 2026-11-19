// lib/network/import-mapping.ts
// ─────────────────────────────────────────────────────────────
// Network slice 5, third follow-up — A FILE THAT ISN'T OURS. Pure: text in,
// text out; no database, no React.
//
// A real export does not have Bee Hub's headings (Outlook says "E-mail
// Address", Google "E-mail 1 - Value", Mailchimp "FNAME"). The import screen
// reads the owner's heading row, GUESSES which Bee Hub field each column is
// from a list of known names (case and punctuation ignored), and lets the
// owner correct any guess or mark a column Ignore. Then this file REWRITES
// the owner's file into Bee Hub's own headings, row for row, and that is what
// goes to the server. Everything after that runs unchanged (planImport):
// unreadable rows named, duplicates skipped and named, unmatched tags named,
// all-or-nothing saving. The server never sees the owner's headings.
//
// ROW NUMBERS SURVIVE: the rewrite keeps every record in its place, blank
// ones included, so "Row 7" still means row 7 of the owner's file.
//
// ONE COLUMN PER FIELD. Bee Hub holds one phone and one email (and one of
// everything else), so a field can sit on one column only; giving it to a
// second column takes it off the first. When a file has several phone or
// email columns, the guess takes the one with the most filled cells, and the
// screen names the others. If the owner sets NO column as Phone (or Email),
// nobody in the file gets one, and the screen says so before anything is
// checked. Nothing is merged and no second number is kept.
//
// BIRTHDAYS from other programs come as 03/22, 3/22/1985, 1985-03-22 or
// --03-22. Bee Hub keeps a month and day ("Mar 22"), so those are turned
// into that, month first (US order). Outlook's 0/0/00 means none. Anything
// else is left as typed, and the row is then named as unreadable, as now.
//
// REMEMBERED PER LOCATION (Kevin, 2026-11-19: locations.network_import_mappings).
// A mapping is stored under the file's HEADING SIGNATURE (its headings,
// tidied and sorted), so the next file from the same program arrives mapped.
// Only headings and field names are stored, never a contact.
// ─────────────────────────────────────────────────────────────

export type FieldKey =
  | 'firstName' | 'lastName' | 'name' | 'email' | 'phone' | 'company' | 'title'
  | 'type' | 'tags' | 'birthday' | 'level' | 'stage' | 'interest' | 'howMet'

/** Bee Hub's fields, in the order the dropdown shows them, with the heading planImport reads. */
export const FIELDS: { key: FieldKey; label: string; heading: string }[] = [
  { key: 'firstName', label: 'First name', heading: 'First name' },
  { key: 'lastName', label: 'Last name', heading: 'Last name' },
  { key: 'name', label: 'Full name or organization', heading: 'Name' },
  { key: 'email', label: 'Email', heading: 'Email' },
  { key: 'phone', label: 'Phone', heading: 'Phone' },
  { key: 'company', label: 'Company', heading: 'Company' },
  { key: 'title', label: 'Job title', heading: 'Job title' },
  { key: 'type', label: 'Type (partner, vendor…)', heading: 'Type' },
  { key: 'tags', label: 'Tags', heading: 'Tags' },
  { key: 'birthday', label: 'Birthday', heading: 'Birthday' },
  { key: 'level', label: 'Partner level', heading: 'Partner level' },
  { key: 'stage', label: 'Partner stage', heading: 'Stage' },
  { key: 'interest', label: 'Interest', heading: 'Interest' },
  { key: 'howMet', label: 'How met', heading: 'How met' },
]
const FIELD_KEYS = FIELDS.map((f) => f.key)
export const isFieldKey = (v: unknown): v is FieldKey => typeof v === 'string' && (FIELD_KEYS as string[]).includes(v)

/** A heading with case, spaces and punctuation taken out: "E-mail 1 - Value" → "email1value". */
export const normHeader = (h: unknown) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Known headings, tidied by normHeader. Earlier in a list = a better guess.
// The brief's list, Bee Hub's own headings, and what Outlook, Google
// Contacts, Mailchimp and LinkedIn actually export.
const KNOWN: Record<FieldKey, string[]> = {
  firstName: ['firstname', 'givenname', 'fname', 'first'],
  lastName: ['lastname', 'surname', 'familyname', 'lname', 'last'],
  name: ['name', 'fullname', 'contactname', 'displayname', 'contact'],
  email: ['email', 'emailaddress', 'email1value', 'primaryemail', 'workemail', 'personalemail', 'homeemail', 'email2address', 'email3address', 'email2value', 'email3value', 'emailaddresses'],
  phone: ['phone', 'mobilephone', 'businessphone', 'homephone', 'phone1value', 'telephone', 'phonenumber', 'mobile', 'cellphone', 'cell', 'workphone', 'primaryphone', 'businessphone2', 'homephone2', 'otherphone', 'phone2value', 'phone3value'],
  company: ['company', 'organizationname', 'companyname', 'accountname', 'employer', 'organization1name', 'organization', 'business'],
  // "Title" last on purpose: Outlook's Title column is Mr / Mrs, and its job
  // is in "Job Title", which wins when both are there.
  title: ['jobtitle', 'position', 'role', 'organizationtitle', 'organization1title', 'title'],
  type: ['type', 'contacttype'],
  tags: ['tags', 'tag'],
  birthday: ['birthday', 'birthdate', 'dateofbirth', 'dob'],
  level: ['partnerlevel'],
  stage: ['stage', 'partnerstage'],
  interest: ['interest'],
  howMet: ['howmet', 'howwemet', 'wheremet', 'wherewemet'],
}
/** Fields a file often has several columns of. The guess takes the fullest one. */
export const MANY_OF = new Set<FieldKey>(['phone', 'email'])

export type Mapping = (FieldKey | null)[]
export type FileShape = {
  /** Every record, blank ones kept, so row numbers survive. Row 0 is the headings. */
  records: string[][]
  /** Which record is the heading row (LinkedIn puts a "Notes:" paragraph above it). */
  headerAt: number
  headers: string[]
  /** How many rows have something in each column. */
  filled: number[]
  /** The first filled value in each column, to show beside it. */
  sample: string[]
}

/** Like csv.ts parseCsv, but blank records are KEPT (as []), so the rewrite can keep row numbers. */
export function parseCsvKeepRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let touched = false
  const src = text.replace(/^﻿/, '')
  const endRow = () => { row.push(cell); rows.push(row.some((c) => c.trim()) ? row : []); row = []; cell = ''; touched = false }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') { quoted = true; touched = true }
    else if (ch === ',') { row.push(cell); cell = ''; touched = true }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; endRow() }
    else { cell += ch; touched = true }
  }
  if (touched || cell || row.length) endRow()
  return rows
}

/** The file's headings, how full each column is, and a sample from each. */
export function readShape(text: string): FileShape | null {
  const records = parseCsvKeepRows(text)
  const first = records.findIndex((r) => r.length > 0)
  if (first < 0) return null
  // The heading row is the first record (of the first 20) with two or more
  // headings we know; failing that, the first record with anything in it.
  // LinkedIn's export puts a "Notes:" paragraph above its headings. What is
  // above the heading row is left out of the rewrite as blank lines, so row
  // numbers still count from the top of the owner's file.
  const known = (r: string[]) => r.filter((h) => FIELD_KEYS.some((k) => KNOWN[k].includes(normHeader(h)))).length
  const at = records.slice(0, 20).findIndex((r) => r.length > 0 && known(r) >= 2)
  const headerAt = at >= 0 ? at : first
  const headers = records[headerAt]!.map((h) => h.trim())
  const body = records.slice(headerAt + 1)
  const filled = headers.map((_, i) => body.filter((r) => (r[i] ?? '').trim()).length)
  const sample = headers.map((_, i) => (body.find((r) => (r[i] ?? '').trim())?.[i] ?? '').trim())
  return { records, headerAt, headers, filled, sample }
}

/** The guess: each column's field from its heading, one column per field. */
export function guessMapping(shape: Pick<FileShape, 'headers' | 'filled'>): Mapping {
  const out: Mapping = shape.headers.map(() => null)
  for (const key of FIELD_KEYS) {
    const names = KNOWN[key]
    const candidates = shape.headers
      .map((h, i) => ({ i, rank: names.indexOf(normHeader(h)), filled: shape.filled[i] ?? 0 }))
      .filter((c) => c.rank >= 0 && out[c.i] === null)
    if (!candidates.length) continue
    // A column with nothing in it is only guessed when nothing better is there.
    candidates.sort((a, b) => Number(b.filled > 0) - Number(a.filled > 0)
      || (MANY_OF.has(key) ? b.filled - a.filled || a.rank - b.rank : a.rank - b.rank || b.filled - a.filled)
      || a.i - b.i)
    out[candidates[0]!.i] = key
  }
  return out
}

/** Columns whose heading looks like `key` but that are not the one in use (the other phone columns). */
export function alsoLooksLike(shape: Pick<FileShape, 'headers'>, mapping: Mapping, key: FieldKey): number[] {
  return shape.headers.map((h, i) => (KNOWN[key].includes(normHeader(h)) && mapping[i] !== key ? i : -1)).filter((i) => i >= 0)
}

/** Give `key` to column `col` (or Ignore it with null). A field already on another column moves. */
export function setColumn(mapping: Mapping, col: number, key: FieldKey | null): Mapping {
  return mapping.map((k, i) => (i === col ? key : key && k === key ? null : k))
}

/** What the screen must say before the file can be checked. */
export function mappingProblems(mapping: Mapping): { noName: boolean; noPhone: boolean; noEmail: boolean; nothingKnown: boolean } {
  const has = (k: FieldKey) => mapping.includes(k)
  return {
    noName: !has('name') && !has('firstName') && !has('lastName'),
    noPhone: !has('phone'),
    noEmail: !has('email'),
    nothingKnown: mapping.every((k) => k === null),
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Another program's birthday as Bee Hub's "Mar 22". Unknown shapes are handed back as typed. */
export function birthdayFromOther(v: string): string {
  const s = v.trim()
  if (!s || /^0{1,2}\/0{1,2}(\/0{1,4})?$/.test(s)) return ''
  let m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/) // 3/22, 03/22/1985
  let month = m ? Number(m[1]) : 0
  let day = m ? Number(m[2]) : 0
  if (!m) {
    m = s.match(/^(?:\d{4}|-)-(\d{1,2})-(\d{1,2})$/) // 1985-03-22, --03-22
    if (m) { month = Number(m[1]); day = Number(m[2]) }
  }
  if (!m || month < 1 || month > 12 || day < 1 || day > 31) return s
  return `${MONTHS[month - 1]} ${day}`
}

const cellOut = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/**
 * The owner's file rewritten into Bee Hub's headings: one column per mapped
 * field, every record in its place (a blank record stays a blank line), so
 * the server reads it exactly as it reads Bee Hub's own file.
 */
export function applyMapping(shape: FileShape, mapping: Mapping): string {
  const cols = mapping.map((k, i) => ({ k, i })).filter((c): c is { k: FieldKey; i: number } => c.k !== null)
  const head = cols.map((c) => FIELDS.find((f) => f.key === c.k)!.heading)
  const at = shape.headerAt
  const lines: string[] = []
  for (let r = 0; r < at; r++) lines.push('')
  lines.push(head.map(cellOut).join(','))
  for (const rec of shape.records.slice(at + 1)) {
    if (rec.length === 0) { lines.push(''); continue }
    const cells = cols.map((c) => { const v = rec[c.i] ?? ''; return c.k === 'birthday' ? birthdayFromOther(v) : v })
    // A record with nothing in any column in use holds nothing Bee Hub
    // keeps: it becomes a blank line, still in its place.
    lines.push(cells.every((v) => !v.trim()) ? '' : cells.map(cellOut).join(','))
  }
  return lines.join('\n')
}

// ── REMEMBERING ─────────────────────────────────────────────
/** The headings, tidied and sorted: the same program makes the same signature. */
export function headerSignature(headers: readonly string[]): string {
  const s = [...headers].map(normHeader).filter(Boolean).sort().join('|')
  let h = 0x811c9dc5 // FNV-1a, 32 bit: a short key, no package
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return `h${h.toString(16).padStart(8, '0')}`
}

export type SavedMapping = { headers: string[]; fields: Mapping; savedAt: string }
export type SavedMappings = Record<string, SavedMapping>
export const MAX_SAVED_MAPPINGS = 20
const MAX_COLUMNS = 300
const MAX_HEADING = 200

/** A saved mapping laid onto this file: by heading, so a reordered export still maps. Null if it does not fit. */
export function recallMapping(saved: SavedMappings | null | undefined, headers: readonly string[]): Mapping | null {
  const s = saved?.[headerSignature(headers)]
  if (!s || !Array.isArray(s.headers) || !Array.isArray(s.fields)) return null
  const byHeading = new Map<string, FieldKey | null>()
  s.headers.forEach((h, i) => byHeading.set(normHeader(h), isFieldKey(s.fields[i]) ? s.fields[i] as FieldKey : null))
  if (headers.some((h) => !byHeading.has(normHeader(h)))) return null
  let out: Mapping = headers.map(() => null)
  headers.forEach((h, i) => { const k = byHeading.get(normHeader(h)) ?? null; if (k) out = setColumn(out, i, k) })
  return out
}

/** Check what a screen sends before it is stored. */
export function cleanMappingToSave(v: unknown): { signature: string; mapping: SavedMapping } | null {
  if (!v || typeof v !== 'object') return null
  const { headers, fields } = v as any
  if (!Array.isArray(headers) || !Array.isArray(fields) || headers.length !== fields.length) return null
  if (headers.length === 0 || headers.length > MAX_COLUMNS) return null
  if (headers.some((h) => typeof h !== 'string' || h.length > MAX_HEADING)) return null
  if (fields.some((f) => f !== null && !isFieldKey(f))) return null
  const used = fields.filter(Boolean)
  if (new Set(used).size !== used.length) return null
  return { signature: headerSignature(headers), mapping: { headers: headers.map((h: string) => h.trim()), fields: fields as Mapping, savedAt: '' } }
}

/** The location's saved mappings with one added (newest kept, at most MAX_SAVED_MAPPINGS). */
export function withMapping(saved: unknown, signature: string, mapping: SavedMapping, now: Date): SavedMappings {
  const base: SavedMappings = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...(saved as SavedMappings) } : {}
  delete base[signature]
  base[signature] = { ...mapping, savedAt: now.toISOString() }
  const keys = Object.keys(base).sort((a, b) => String(base[b]!.savedAt).localeCompare(String(base[a]!.savedAt)))
  return Object.fromEntries(keys.slice(0, MAX_SAVED_MAPPINGS).map((k) => [k, base[k]!]))
}

/** Is this already a Bee Hub file (every heading is exactly one of ours)? Then the guess is the answer. */
export const isBeeHubShape = (headers: readonly string[]) =>
  headers.every((h) => FIELDS.some((f) => normHeader(f.heading) === normHeader(h)))

