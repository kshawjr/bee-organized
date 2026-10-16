// ═══════════════════════════════════════════════════════════════════════════
// PHONE FORMAT BACKFILL — every stored phone into (123) 456-7890.
// HELD. KEVIN RUNS THIS. DRY RUN BY DEFAULT: it reads every phone, prints what
// it would change, writes a report, and writes nothing to the database.
// --commit to apply.
//
// THE RULES are lib/phone.ts phoneForWrite — THE SAME FUNCTION every write
// path now calls — so a backfilled row is exactly what a fresh save would be:
//   · one US number (10 digits, or 11 starting with 1), with or without an
//     extension → "(401) 247-1926" / "(401) 247-1926 ext. 202"
//   · two numbers in one field → the FIRST, formatted; the whole original goes
//     into a note on the record (Kevin, 16 Oct 2026)
//   · one number that came with words ("(daughter Jan)", "Office:") → the
//     number, formatted; the original into a note, so the words survive
//   · foreign (+ and not +1) → untouched
//   · anything unreadable (stubs, an email, a capital I for a 1) → untouched
//
// NOTES go on the record's activity timeline as a 'note' touchpoint (see
// lib/phone-note.ts). Only leads and Network people (partners) HAVE a
// timeline. A row in any other table that would need a note is left whole and
// listed as skipped_needs_note — nothing is ever reduced without its note.
//
// WHAT IT WILL NOT DO:
//   · never touches a binned lead (is_junk = true) unless --include-junk. The
//     leads updated_at trigger stamps NOW() on every write, and the bin shows
//     updated_at as the "deleted" date — a backfill would re-date the bin.
//   · never trims or "cleans" a value it does not format
//   · never overwrites a phone that changed after it was read: every UPDATE is
//     guarded by .eq('phone', <the value it read>)
//   · never writes at all without --commit
//
// SIDE EFFECT TO KNOW: every row it changes gets updated_at = now (the
// tables' own trigger). Nothing in the app keys off leads.updated_at except
// the bin's date, which is why junk is skipped.
//
// OUTPUT: <reports>/phone-backfill-<dryrun|commit>.csv (every row it would
// change / did change) and …-summary.json. A --commit run also writes
// phone-backfill-undo.json: table, id, the old phone, and the id of any note
// touchpoint it created.
//
// Usage:
//   node scripts/backfill-phone-format.mjs                    # dry run
//   node scripts/backfill-phone-format.mjs --commit           # apply
//   node scripts/backfill-phone-format.mjs --table=leads      # one table (repeatable)
//   node scripts/backfill-phone-format.mjs --include-junk
//   node scripts/backfill-phone-format.mjs --env <path>       # default .env.local
//   node scripts/backfill-phone-format.mjs --reports <dir>
//       default ~/Projects/bee-organized-repair-reports/<today>
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve as resolvePath, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installTsResolver } from './ts-alias-hook.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolvePath(HERE, '..')

const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)
const val = (k, d = null) => {
  const withEq = argv.find((a) => a.startsWith(k + '='))
  if (withEq) return withEq.slice(k.length + 1)
  const i = argv.indexOf(k)
  return i > -1 && argv[i + 1] ? argv[i + 1] : d
}
const COMMIT = has('--commit')
const INCLUDE_JUNK = has('--include-junk')
const ONLY = argv.filter((a) => a.startsWith('--table=')).map((a) => a.slice('--table='.length))
const today = new Date().toISOString().slice(0, 10)
const REPORTS = val('--reports', join(homedir(), 'Projects', 'bee-organized-repair-reports', today))
const envPath = resolvePath(ROOT, val('--env', '.env.local'))

for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

installTsResolver(ROOT)
const { createClient } = await import('@supabase/supabase-js')
const { phoneForWrite } = await import(pathToFileURL(ROOT + '/lib/phone.ts').href)
const { PHONE_NOTE_LABEL, phoneNoteText } = await import(pathToFileURL(ROOT + '/lib/phone-note.ts').href)

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Every table with a phone column (leads_full is a view on leads — skipped).
// note: how a note is attached, or null when the table has no timeline.
const TABLES = [
  { table: 'leads', extra: 'location_uuid, is_junk, archived_at', note: (r) => ({ lead_id: r.id, location_uuid: r.location_uuid }) },
  { table: 'partners', extra: 'location_id', note: (r) => ({ partner_id: r.id, location_uuid: r.location_id }) },
  { table: 'companies', extra: null, note: null },
  { table: 'lead_contacts', extra: null, note: null },
  { table: 'locations', extra: null, note: null },
  { table: 'hub_users', extra: null, note: null },
  { table: 'lead_notification_externals', extra: null, note: null },
  { table: 'service_requests', extra: null, note: null },
  { table: 'assessments', extra: null, note: null },
  { table: 'quotes', extra: null, note: null },
  { table: 'jobs', extra: null, note: null },
  { table: 'invoices', extra: null, note: null },
].filter((t) => !ONLY.length || ONLY.includes(t.table))

if (ONLY.length && TABLES.length !== ONLY.length) {
  console.error(`unknown --table in ${ONLY.join(', ')}`)
  process.exit(2)
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function readAll(table, cols) {
  const out = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select(cols)
      .not('phone', 'is', null)
      .neq('phone', '')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}

mkdirSync(REPORTS, { recursive: true })
const mode = COMMIT ? 'commit' : 'dryrun'
const csv = ['table,id,kind,old_phone,new_phone,note,outcome']
const undo = []
const summary = { mode, ran_at: new Date().toISOString(), include_junk: INCLUDE_JUNK, tables: {} }

for (const t of TABLES) {
  const cols = ['id', 'phone', t.extra].filter(Boolean).join(', ')
  const rows = await readAll(t.table, cols)
  const s = {
    rows_with_phone: rows.length,
    already_formatted: 0,
    format: 0,
    format_with_note: 0,
    left_foreign: 0,
    left_unreadable: 0,
    skipped_junk: 0,
    skipped_needs_note: 0,
    written: 0,
    write_failed: 0,
    write_raced: 0,
    notes_written: 0,
  }
  for (const r of rows) {
    const w = phoneForWrite(r.phone)
    if (w.kind === 'foreign') { s.left_foreign++; continue }
    if (w.kind === 'unreadable' || w.kind === 'empty') { s.left_unreadable++; continue }
    if (w.value === r.phone && !w.note) { s.already_formatted++; continue }
    if (t.table === 'leads' && r.is_junk === true && !INCLUDE_JUNK) { s.skipped_junk++; continue }
    if (w.note && !t.note) {
      s.skipped_needs_note++
      csv.push([t.table, r.id, w.kind, r.phone, '', 'needs a note — this table has no timeline', 'skipped'].map(csvCell).join(','))
      continue
    }
    if (w.note) s.format_with_note++
    else s.format++

    let outcome = 'would_write'
    if (COMMIT) {
      const { data: upd, error } = await sb.from(t.table).update({ phone: w.value }).eq('id', r.id).eq('phone', r.phone).select('id')
      if (error) { s.write_failed++; outcome = `failed: ${error.message}` }
      else if (!upd || upd.length === 0) { s.write_raced++; outcome = 'skipped: phone changed since read' }
      else {
        s.written++
        outcome = 'written'
        const u = { table: t.table, id: r.id, old_phone: r.phone, new_phone: w.value, note_touchpoint_id: null }
        if (w.note) {
          const { data: tp, error: tpErr } = await sb.from('touchpoints').insert({
            ...t.note(r),
            kind: 'note',
            method: 'system',
            status: 'done',
            label: PHONE_NOTE_LABEL,
            notes: phoneNoteText(w.note, w.value),
            user_id: null,
          }).select('id').single()
          if (tpErr) outcome = `written; NOTE FAILED: ${tpErr.message}`
          else { s.notes_written++; u.note_touchpoint_id = tp.id }
        }
        undo.push(u)
      }
    }
    csv.push([t.table, r.id, w.kind, r.phone, w.value, w.note ? 'yes' : '', outcome].map(csvCell).join(','))
  }
  summary.tables[t.table] = s
  console.log(t.table.padEnd(28), JSON.stringify(s))
}

const base = join(REPORTS, `phone-backfill-${mode}`)
writeFileSync(`${base}.csv`, csv.join('\n') + '\n')
writeFileSync(`${base}-summary.json`, JSON.stringify(summary, null, 2) + '\n')
if (COMMIT) writeFileSync(join(REPORTS, 'phone-backfill-undo.json'), JSON.stringify(undo, null, 2) + '\n')
console.log(`\n${COMMIT ? 'COMMITTED' : 'DRY RUN — nothing written'}. Report: ${base}.csv`)
