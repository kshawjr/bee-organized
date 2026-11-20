// lib/network/csv.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 1 — reading and writing contacts as a
// CSV file. Pure: text in, rows out; no file access, no DOM, no package.
// Ported from the design's contact-csv.ts and changed:
//
//   · NO EXCEL. The design read .xlsx through the `xlsx` package, whose last
//     npm release (0.18.5) has two high-severity advisories. Bee Hub reads
//     CSV only; Excel and Google Sheets both save as CSV.
//   · Kevin's five types, three levels and five stages (lib/network/types).
//     The design's "client" type is not one of ours: a row that says client
//     is still imported, as Not sure yet, with a warning saying so.
//   · PHONES follow Bee Hub's one phone rule (lib/phone.ts), not the design's
//     own formatter: a clean number is formatted (123) 456-7890, a second
//     number or words in the field are kept as a note, a foreign number is
//     left as typed, and something that is not a number skips the row.
//   · SPREADSHEET FORMULAS. A cell that starts with = + - or @ is run as a
//     formula when a CSV is opened in Excel. Contact fields are typed by
//     hand and imported from other people's files, so every such cell is
//     written with a leading apostrophe (which Excel shows as plain text),
//     and that apostrophe is taken off again on the way back in.
//   · The browser download helper stayed behind: it touches the page, so it
//     belongs with the screen (slice 5).
//
// NAMES (third follow-up, 2026-11-19). A file may carry "First name" and
// "Last name" columns, a "Name" column, or both. First and last win when a
// row has them; otherwise Name is split first word / rest; an organization's
// name is never split (lib/network/names.ts, the Clients convention).
//
// Tags are carried as the words in the file. Matching them to Bee Hub's tag
// list (lib/tags.ts) needs the database and is the import screen's job.
// ─────────────────────────────────────────────────────────────

import { phoneForWrite } from '@/lib/phone'
import { contactNames } from './names'
import {
  DEFAULT_PARTNER_LEVEL, DEFAULT_PARTNER_STAGE, PARTNER_STAGES,
  contactTypes, normalizeTypes, partnerLevel, partnerStage,
  type NetContact, type NetType, type PartnerLevel, type PartnerStage,
} from './types'

export const IMPORT_COLUMNS = [
  { key: 'Name', required: true, help: 'Full name, or the business name for an organization.' },
  { key: 'Type', required: false, help: 'unsure, partner, vendor, nurture, or organization. Separate several with ;' },
  { key: 'Company', required: false, help: 'Where they work.' },
  { key: 'Job title', required: false, help: 'Their role.' },
  { key: 'Phone', required: false, help: '10 digits; we format it as (303) 555-0142.' },
  { key: 'Email', required: false, help: 'We clean it up and lowercase it.' },
  { key: 'Birthday', required: false, help: 'Month and day, like Mar 22.' },
  { key: 'Tags', required: false, help: 'Separate several with ;' },
  { key: 'Partner level', required: false, help: 'Referral partners only: potential, referral, or power.' },
  { key: 'Stage', required: false, help: `Referral partners only: ${PARTNER_STAGES.join(', ')}` },
  { key: 'Interest', required: false, help: 'Nurture: what they asked about.' },
  { key: 'How met', required: false, help: 'Where you met them.' },
] as const

export const SAMPLE_CSV = [
  IMPORT_COLUMNS.map((c) => c.key).join(','),
  'Dana Whitfield,partner,Keystone Realty,Realtor,3035550142,Dana@KeystoneRealty.com,Mar 22,Realtor;Downsizing,power,Active Partner,,BNI breakfast',
  'Marcus Lee,vendor;partner,Lee Moving Co,Owner,(720) 555-0199,marcus@leemoving.com,,Movers,potential,New Contact,,Chamber mixer',
  'Priya Shah,nurture,,,303.555.0110,priya.shah@gmail.com,Jul 4,Garage;Kitchen,,,Garage overhaul quote,Website form',
  'Summit Senior Living,organization;partner,,,7205550123,hello@summitsenior.com,,Senior living,referral,Reaching Out,,',
].join('\n')

/** Split CSV text into rows, honouring quoted fields. Blank rows are dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim()))
}

// ── Words a spreadsheet may use → ours ───────────────────────
const TYPE_WORDS: Record<string, NetType> = {
  partner: 'partner', 'referral partner': 'partner',
  vendor: 'vendor', trade: 'vendor', 'service provider': 'vendor', 'vendor / service provider': 'vendor',
  nurture: 'nurture', prospect: 'nurture', 'potential client': 'nurture',
  organization: 'organization', organisation: 'organization', company: 'organization', business: 'organization',
  unsure: 'unsure', 'not sure': 'unsure', 'not sure yet': 'unsure',
}
const LEVEL_WORDS: Record<string, PartnerLevel> = {
  potential: 'potential', 'potential partner': 'potential',
  referral: 'referral', 'referral partner': 'referral',
  power: 'power', 'power partner': 'power',
}
// The live names for two of the stages, so an export from the old screen
// reads back in (see lib/network/live-mapping.ts).
const STAGE_WORDS: Record<string, PartnerStage> = {
  ...Object.fromEntries(PARTNER_STAGES.map((s) => [s.toLowerCase(), s])),
  building: 'Building the Relationship',
  dormant: 'Gone quiet',
}

const list = (v = '') => v.split(/[;|]/).map((s) => s.trim()).filter(Boolean)
const word = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ')

export const normalizeEmail = (v: string) => v.trim().toLowerCase()
/** Blank is fine (email is optional); otherwise it must look like one. */
export const isValidEmail = (v: string) =>
  v.trim() === '' || (v.trim().length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()))

// ── Spreadsheet formula guard ────────────────────────────────
const FORMULA_START = /^[=+\-@\t\r]/
/** Stop a spreadsheet running a cell as a formula: lead it with an apostrophe. */
export const guardCell = (s: string) => (FORMULA_START.test(s) ? `'${s}` : s)
/** Take that apostrophe off again. Only ever removes one we could have added. */
export const unguardCell = (s: string) => (s.startsWith("'") && FORMULA_START.test(s.slice(1)) ? s.slice(1) : s)

export type ImportRow = {
  /** The row's line in the file, counting the header as line 1. */
  line: number
  /** Absent when the row cannot be used; `problems` says why. */
  contact?: NetContact
  /** Reasons the row was skipped. */
  problems: string[]
  /** Things the owner should know about a row that WAS imported. */
  warnings: string[]
}

/** Turn spreadsheet rows (first row = headers) into contacts, flagging rows we can't use. */
export function rowsToContacts(rows: string[][], idPrefix = `imp-${Date.now()}`): ImportRow[] {
  const [head = [], ...body] = rows
  const idx = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase())
  const col = (name: string) => idx(name)
  return body.map((r, i) => {
    const get = (k: string) => { const c = col(k); return c >= 0 ? unguardCell((r[c] ?? '').trim()).trim() : '' }
    const line = i + 2
    const problems: string[] = []
    const warnings: string[] = []

    // Types first: whether a name is split depends on Organization.
    const typeWords = list(get('Type'))
    const known = typeWords.map((t) => TYPE_WORDS[word(t)]).filter(Boolean) as NetType[]
    if (word(get('Record')) === 'company' || word(get('Record')) === 'organization') known.push('organization')
    const types = normalizeTypes(known)
    const isOrg = types.includes('organization')

    const names = contactNames({ first: get('First name'), last: get('Last name'), name: get('Name'), isOrg })
    const name = names.name
    if (!name) problems.push('Missing name')

    const phoneRaw = get('Phone')
    const phoneW = phoneForWrite(phoneRaw)
    if (phoneW.kind === 'unreadable') problems.push("Phone isn't a number we can read")
    if (phoneW.note) warnings.push(`Phone kept as ${phoneW.value}; the rest of that cell was saved as a note`)

    const email = normalizeEmail(get('Email'))
    if (!isValidEmail(email)) problems.push('Email looks wrong')

    if (problems.length) return { line, problems, warnings: [] }

    // Types (read above). The design's old "Record: company" column still
    // reads, as the Organization type, so a file made from the design's
    // sample works.
    for (const t of typeWords) {
      if (!TYPE_WORDS[word(t)]) warnings.push(`Type “${t}” isn't one we use, so it was left out`)
    }
    const isPartner = types.includes('partner')

    const levelRaw = get('Partner level')
    const stageRaw = get('Stage')
    const level = LEVEL_WORDS[word(levelRaw)]
    const stage = STAGE_WORDS[word(stageRaw)]
    if (isPartner) {
      if (levelRaw && !level) warnings.push(`Partner level “${levelRaw}” isn't one we use, so they start as Potential`)
      if (stageRaw && !stage) warnings.push(`Stage “${stageRaw}” isn't one we use, so they start at ${DEFAULT_PARTNER_STAGE}`)
    } else {
      if (levelRaw) warnings.push('Partner level left out: only a Referral partner has one')
      if (stageRaw) warnings.push('Stage left out: only a Referral partner has one')
    }

    const birthday = get('Birthday')
    if (birthday && isOrg) warnings.push('Birthday left out: an organization has none')

    const contact: NetContact = {
      id: `${idPrefix}-${i}`,
      name,
      firstName: names.first_name ?? undefined,
      lastName: names.last_name ?? undefined,
      types,
      tags: list(get('Tags')),
      company: get('Company') || undefined,
      role: get('Job title') || undefined,
      phone: phoneW.value || undefined,
      email: email || undefined,
      birthday: isOrg ? undefined : birthday || undefined,
      howMet: get('How met') || undefined,
      interest: get('Interest') || undefined,
      level: isPartner ? level ?? DEFAULT_PARTNER_LEVEL : undefined,
      stage: isPartner ? stage ?? DEFAULT_PARTNER_STAGE : undefined,
      referred: 0,
      converted: 0,
      revenue: 0,
      lastTalkedDays: null,
      mailchimp: { on: false },
      notes: phoneW.note ? [{ text: `Phone as imported: ${phoneW.note}`, title: 'Phone', author: 'Import', at: 'Today' }] : undefined,
      history: [{ kind: 'created', when: 'Today', text: 'Imported from a spreadsheet' }],
    }
    return { line, contact, problems, warnings }
  })
}

const TYPE_OUT: Record<NetType, string> = {
  partner: 'partner', vendor: 'vendor', nurture: 'nurture', organization: 'organization', unsure: 'unsure',
}

const cell = (v: unknown) => {
  const s = guardCell(String(v ?? ''))
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The export's header row: every column the importer reads, then the read-only extras. */
export const EXPORT_COLUMNS = [
  ...IMPORT_COLUMNS.map((c) => c.key),
  'Drip', 'In Mailchimp', 'Referrals', 'Became jobs', 'Next follow-up',
] as string[]

/** Contacts as CSV text, in the same columns the importer reads (plus a few extras). */
export function contactsToCsv(contacts: readonly NetContact[]): string {
  const rows = contacts.map((c) => [
    c.name, contactTypes(c).map((t) => TYPE_OUT[t]).join(';'), c.company, c.role, c.phone, c.email, c.birthday,
    c.tags.join(';'), partnerLevel(c) ?? '', partnerStage(c) ?? '', c.interest, c.howMet,
    c.drip, c.mailchimp.on ? 'yes' : 'no', c.referred, c.converted, c.nextFollowUp,
  ])
  return [EXPORT_COLUMNS, ...rows].map((r) => r.map(cell).join(',')).join('\n')
}
