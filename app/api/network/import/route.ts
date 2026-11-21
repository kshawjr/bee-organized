// app/api/network/import/route.ts
//
//   POST   bring a CSV file of contacts into ONE location (slice 5)
//   GET    ?location_id=  that location's remembered column mappings
//          (third follow-up), so a second file from the same program
//          arrives already mapped
//
// WHO MAY CALL IT: super admins only, for now (lib/network/access.ts), the
// same rule as the rest of the new Network. Everyone else: 403, nothing read.
//
// Body: { location_id, csv, mode: 'check' | 'import', mapping? }
//   csv is ALWAYS in Bee Hub's own headings: the screen rewrites the owner's
//   file into them first (lib/network/import-mapping.ts), so the rules below
//   never see another program's headings.
//   mapping { headers, fields }: the owner's column choices. Stored on the
//   location AFTER an import is saved, never on a check, and a failure to
//   store it never fails the import (the answer says mappingSaved).
//   check   reads and plans, writes NOTHING. The import box shows this
//           before anyone presses Add: who comes in, who is skipped as
//           already here (and who they matched), which tag words matched
//           nothing, and any row that stops the file.
//   import  plans again from the same file, against the data as it is NOW,
//           and writes. What it answers is what it actually did.
//
// THE FILE GOES INTO THE LOCATION NAMED, and only that one: every row is
// given that location_id here, whatever the file says. There is no
// "every location" import.
//
// THE RULES: lib/network/contact-create.ts planImport, which holds Kevin's
// two rulings (a tag word that matches nothing is named and left off, a file
// never makes a tag; an email already on a live contact here skips the row
// and names who). A row that cannot be read is skipped too, named by line and
// reason, and the rest comes in. Only a file that is not a usable CSV at all
// is refused whole.
//
// THE WRITE: lib/network/contact-writes.ts. One insert of every contact, one
// insert of every tag link, and the contacts taken out again if the tag links
// fail. Half a file never stays in.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { maySeeNewNetwork } from '@/lib/network/access'
import { mayReadNetworkLocation, networkWriteVerdict, READ_ONLY_ANSWER } from '@/lib/network/route-access'
import { IMPORT_MAX_CHARS, planImport } from '@/lib/network/contact-create'
import { UUID_RE, readLiveContacts, readLocation, readLocationTags } from '@/lib/network/contact-reads'
import { writeNewContacts } from '@/lib/network/contact-writes'
import { cleanMappingToSave } from '@/lib/network/import-mapping'
import { readImportMappings, saveImportMapping } from '@/lib/network/import-mapping-store'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!maySeeNewNetwork(caller.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const locationId = request.nextUrl.searchParams.get('location_id') || ''
  if (!UUID_RE.test(locationId)) return NextResponse.json({ ok: false, reason: 'location_required' }, { status: 400 })
  // Another location answers like one that does not exist, as every Network
  // write route does (2026-11-21).
  if (!mayReadNetworkLocation(caller, locationId)) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
  const read = await readImportMappings(supabaseService, locationId)
  return NextResponse.json({ ok: true, remembered: read.ok, mappings: read.mappings })
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!maySeeNewNetwork(caller.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const raw = await request.text()
  if (raw.length > IMPORT_MAX_CHARS + 2000) return NextResponse.json({ ok: false, reason: 'too_big' }, { status: 413 })
  let body: any
  try { body = JSON.parse(raw) } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }
  const locationId = body?.location_id
  if (typeof locationId !== 'string' || !UUID_RE.test(locationId)) {
    return NextResponse.json({ ok: false, reason: 'location_required' }, { status: 400 })
  }
  // Checking a file is a step towards writing, and reads the location's
  // contacts: both modes need write rights here.
  const may = networkWriteVerdict(caller, locationId)
  if (may === 'not_found') return NextResponse.json({ ok: false, reason: 'location_not_found' }, { status: 404 })
  if (may === 'read_only') return NextResponse.json(READ_ONLY_ANSWER, { status: 403 })
  const mode = body?.mode
  if (mode !== 'check' && mode !== 'import') return NextResponse.json({ error: 'mode_must_be_check_or_import' }, { status: 400 })
  if (typeof body?.csv !== 'string') return NextResponse.json({ ok: false, reason: 'not_csv' }, { status: 422 })

  const loc = await readLocation(supabaseService, locationId)
  if (!loc.ok) return NextResponse.json({ error: loc.error }, { status: 500 })
  if (!loc.location) return NextResponse.json({ ok: false, reason: 'location_not_found' }, { status: 404 })
  if (mode === 'import') {
    const blocked = await readOnlyWriteBlock({ role: caller.role }, locationId)
    if (blocked) return blocked
  }

  const [tags, existing] = await Promise.all([readLocationTags(supabaseService, locationId), readLiveContacts(supabaseService, locationId)])
  if (!tags.ok) return NextResponse.json({ error: tags.error }, { status: 500 })
  if (!existing.ok) return NextResponse.json({ error: existing.error }, { status: 500 })

  const plan = planImport(body.csv, { locationId, userId: caller.userId, tags: tags.tags, existing: existing.contacts, now: new Date() })
  const location = { id: loc.location.id, name: loc.location.name }
  if (!plan.ok) return NextResponse.json({ ok: false, reason: plan.reason, problems: plan.problems, location }, { status: 422 })

  const summary = {
    location,
    adding: plan.rows.map((r) => ({ line: r.line, name: r.row.name, first_name: r.row.first_name, last_name: r.row.last_name, title: r.row.title, company: r.row.company, email: r.row.email, phone: r.row.phone, tags: r.tagIds.length })),
    unreadable: plan.unreadable,
    skipped: plan.skipped,
    unmatchedTags: plan.unmatchedTags,
    warnings: plan.warnings,
  }
  if (mode === 'check') return NextResponse.json({ ok: true, mode, ...summary, added: 0 })

  const written = await writeNewContacts(supabaseService, plan.rows, caller.userId)
  if (!written.ok) {
    console.error('[network import]', { location: locationId, rows: plan.rows.length, ...written })
    return NextResponse.json({ ok: false, reason: written.undone ? 'not_saved' : 'partly_saved', leftBehind: written.leftBehind, location }, { status: 500 })
  }
  // Remember how the owner mapped this file's columns, for the next one.
  const toSave = cleanMappingToSave(body?.mapping)
  const mappingSaved = toSave ? (await saveImportMapping(supabaseService, locationId, toSave.signature, toSave.mapping, new Date())).saved : false
  return NextResponse.json({ ok: true, mode, ...summary, added: written.ids.length, ids: written.ids, mappingSaved })
}
