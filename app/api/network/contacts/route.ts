// app/api/network/contacts/route.ts
//
//   POST   add ONE Network contact (the new add flow, slice 5)
//
// WHO MAY CALL IT: the same one rule as the list and the sheet,
// lib/network/access.ts — super admins only, for now. Everyone else gets 403
// before anything is read.
//
// Body: { location_id, name, types, company, title, phone, email, birthday,
//         birthdayReminder, howWeMet, tagIds, interest, addAnyway }
//
// A DUPLICATE EMAIL (the Blaire Brimer ticket): an email already on a LIVE
// contact at this location, compared lowercased and trimmed on both sides,
// is refused with 409 { error: 'email_already_here', matched: { id, name } },
// unless the body says addAnyway: true, which the form only sends after the
// person ticked "add anyway" against that exact email. With NO email, the
// same name and phone (409 name_and_phone_already_here) or the same name and
// no phone on either side (409 name_already_here) is refused the same way.
// The same rules (and the same reads) as an import.
//
// INTEREST has no column: it is kept as the contact's first note, signed by
// whoever added them, as an import keeps it.
//
// THE LOCATION is the one the screen is looking at, named in the body. It
// must exist and must not be paused (read-only), as on every other write.
// There is no "every location" add: a contact belongs to one location.
//
// THE RULES are lib/network/contact-create.ts planNewContact: each field is
// read the way the contact sheet saves it, types must be ours, and tags must
// be this location's Network tags. The write is lib/network/contact-writes.ts:
// the contact, then its tags; if the tags fail the contact is taken out
// again, so a failed add leaves nothing.
//
// It never makes a tag (the tag picker makes those through POST /api/lookups
// before the contact is saved), never writes a touchpoint, reminder, level,
// stage, or any other table.
//
// Answer: { id } on success, 201.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { maySeeNewNetwork } from '@/lib/network/access'
import { networkWriteVerdict, READ_ONLY_ANSWER } from '@/lib/network/route-access'
import { networkTagsFor, planNewContact, DUP_ERRORS } from '@/lib/network/contact-create'
import { UUID_RE, readLiveContacts, readLocation, readLocationTags } from '@/lib/network/contact-reads'
import { writeNewContacts } from '@/lib/network/contact-writes'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!maySeeNewNetwork(caller.role, caller.locationId)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }
  const locationId = body?.location_id
  if (typeof locationId !== 'string' || !UUID_RE.test(locationId)) {
    return NextResponse.json({ error: 'location_required', field: 'location' }, { status: 400 })
  }
  const may = networkWriteVerdict(caller, locationId)
  if (may === 'not_found') return NextResponse.json({ error: 'location_not_found', field: 'location' }, { status: 404 })
  if (may === 'read_only') return NextResponse.json(READ_ONLY_ANSWER, { status: 403 })

  const loc = await readLocation(supabaseService, locationId)
  if (!loc.ok) return NextResponse.json({ error: loc.error }, { status: 500 })
  if (!loc.location) return NextResponse.json({ error: 'location_not_found', field: 'location' }, { status: 404 })
  const blocked = await readOnlyWriteBlock({ role: caller.role }, locationId)
  if (blocked) return blocked

  const [tags, existing] = await Promise.all([readLocationTags(supabaseService, locationId), readLiveContacts(supabaseService, locationId)])
  if (!tags.ok) return NextResponse.json({ error: tags.error }, { status: 500 })
  if (!existing.ok) return NextResponse.json({ error: existing.error }, { status: 500 })

  let author = ''
  if (typeof body?.interest === 'string' && body.interest.trim()) {
    const me = await supabaseService.from('hub_users').select('id, full_name, first_name').eq('id', caller.userId).maybeSingle()
    author = (me?.data as any)?.first_name || (me?.data as any)?.full_name || ''
  }

  const plan = planNewContact(body, {
    locationId,
    userId: caller.userId,
    allowedTagIds: networkTagsFor(tags.tags, locationId).map((t) => t.id),
    existing: existing.contacts,
    author,
    now: new Date(),
  })
  if (!plan.ok) {
    if (DUP_ERRORS.includes(plan.error)) return NextResponse.json({ error: plan.error, field: plan.field, matched: plan.matched }, { status: 409 })
    return NextResponse.json({ error: plan.error, field: plan.field }, { status: 422 })
  }

  const written = await writeNewContacts(supabaseService, [{ row: plan.row, tagIds: plan.tagIds }], caller.userId)
  if (!written.ok) {
    console.error('[network add]', written)
    return NextResponse.json({ error: written.undone ? 'not_saved' : 'partly_saved', leftBehind: written.leftBehind }, { status: 500 })
  }
  return NextResponse.json({ id: written.ids[0] }, { status: 201 })
}
