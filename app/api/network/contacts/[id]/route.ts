// app/api/network/contacts/[id]/route.ts
//
//   GET    one Network contact, with everything the new contact sheet shows
//   PATCH  save the fields a person changed, and ONLY those
//
// Network & Nurture redesign, slice 4a. This is the first route in the new
// Network that writes.
//
// WHO MAY CALL IT: the same one rule as the list, lib/network/access.ts —
// super admins only, for now. Everyone else gets 403 before anything is read.
//
// ── PATCH: THE SAVING RULE ──────────────────────────────────────────────────
// Body: { changes: { <field>: { from, to } } }
//
// The screen says which fields the person changed, what each said when they
// opened it, and what they made it. This route does not take the screen's
// word for what that means. It reads the row as it is stored NOW and hands
// both to lib/network/contact-edit.ts (planContactSave), which decides:
//   · only the nine fields on its list can be written; anything else is 400
//   · a field that already holds the new value is not written
//   · a field somebody else changed since it was opened refuses the whole
//     save (409), so neither person's edit is silently lost
// What comes back is the exact set of columns to write. This route writes
// those columns and updated_at, and nothing else. If the set is empty it
// writes NOTHING: no update is sent, and updated_at does not move.
//
// SLICE 4b adds three more things the same save can carry, each under the
// same rule (lib/network/contact-adds.ts planContactAdds):
//   addNote:   { text }        the server appends it to the stored notes
//   addresses: { from, to }    the address list; 409 if it moved meanwhile
//   companyId: { from, to }    the company LINK, an id from the companies
//                              table at the contact's own location, or null
// One request, one update: a save that changes a name and the link writes
// those two columns and updated_at together.
//
// It never writes: type, stage, tier, network_types, partner_level,
// partner_stage, next_steps, relationship, specialties, met_date, or any
// other table. Tags, touchpoints and follow-ups are not written here at
// all: the sheet sends those to the routes Bee Hub already has for them
// (/api/partner-tags, /api/touchpoints, /api/reminders). (The older
// /api/partners/[id] PATCH writes whatever keys it is sent, and adds a
// timeline note when a phone field holds two numbers; this one refuses such
// a field instead, so that it stays a one-table, named-columns write.)
//
// The answer says what was written: { written: [columns], notes: [...],
// contact }. `written` is empty when nothing needed saving.
//
// ── GET ─────────────────────────────────────────────────────────────────────
// Reads only. The contact's row (the fields the design has no place for
// included: addresses, website, the company link, how you met, specialties,
// notes, next steps, relationship), the linked company's name, its tags by
// name and section, its logged touchpoints, and the CALLER'S OWN open
// reminders on it (reminders are personal, as on the Reminders page).
// met_date is deliberately not read: `created_at` is the date shown.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { maySeeNewNetwork } from '@/lib/network/access'
import { planContactAdds, ADD_KEYS } from '@/lib/network/contact-adds'
import { planContactSave } from '@/lib/network/contact-edit'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SHEET_COLS =
  'id, location_id, name, title, company, company_id, phone, email, website, addresses, ' +
  'how_we_met, specialties, relationship, notes, next_steps, activity, is_customer, customer_lead_id, ' +
  'network_types, partner_level, partner_stage, birthday, birthday_reminder, ' +
  'last_contacted_at, created_at, updated_at, deleted_at, partner_tags(tag_lookup_id)'

// What a save compares against: the nine editable columns, and the three
// slice 4b can add to. Nothing more.
const EDIT_COLS = 'id, location_id, deleted_at, name, title, company, phone, email, website, how_we_met, birthday, birthday_reminder, notes, addresses, company_id'

async function gate() {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return { caller: null, refuse: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  if (!maySeeNewNetwork(caller.role)) return { caller: null, refuse: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  return { caller, refuse: null }
}

function toContact(row: any) {
  return {
    id: row.id,
    locationId: row.location_id,
    name: row.name,
    title: row.title || null,
    company: row.company || null,
    companyId: row.company_id || null,
    phone: row.phone || null,
    email: row.email || null,
    website: row.website || null,
    addresses: Array.isArray(row.addresses) ? row.addresses : [],
    howWeMet: row.how_we_met || null,
    specialties: Array.isArray(row.specialties) ? row.specialties : [],
    relationship: row.relationship || null,
    notes: Array.isArray(row.notes) ? row.notes : [],
    nextSteps: Array.isArray(row.next_steps) ? row.next_steps : [],
    activity: Array.isArray(row.activity) ? row.activity : [],
    isCustomer: !!row.is_customer,
    customerLeadId: row.customer_lead_id || null,
    networkTypes: row.network_types ?? null,
    partnerLevel: row.partner_level ?? null,
    partnerStage: row.partner_stage ?? null,
    birthday: row.birthday || null,
    birthdayReminder: row.birthday_reminder === true,
    lastContactedAt: row.last_contacted_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    tagIds: (row.partner_tags || []).map((t: any) => t.tag_lookup_id),
  }
}

async function loadSheet(id: string, userId: string) {
  const { data: row, error } = await supabaseService.from('partners').select(SHEET_COLS).eq('id', id).maybeSingle()
  if (error) return { error: error.message, status: 500 as const }
  if (!row || (row as any).deleted_at) return { error: 'contact_not_found', status: 404 as const }
  const r = row as any

  const tagIds: string[] = (r.partner_tags || []).map((t: any) => t.tag_lookup_id).filter(Boolean)
  const [company, location, tags, touchpoints, reminders] = await Promise.all([
    r.company_id
      ? supabaseService.from('companies').select('id, name, deleted_at').eq('id', r.company_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabaseService.from('locations').select('id, name').eq('id', r.location_id).maybeSingle(),
    tagIds.length
      // A switched-off tag is hidden here as it is on the old record: the
      // link is kept, so switching the tag back on brings it back.
      ? supabaseService.from('lookups').select('id, label, icon, attrs, location_id').in('id', tagIds).eq('is_active', true)
      : Promise.resolve({ data: [], error: null }),
    supabaseService.from('touchpoints').select('id, kind, method, label, status, notes, occurred_at').eq('partner_id', id).order('occurred_at', { ascending: false }),
    supabaseService.from('reminders').select('id, due_on, note').eq('user_id', userId).eq('partner_id', id).is('done_at', null).order('due_on', { ascending: true }),
  ])
  for (const res of [company, location, tags, touchpoints, reminders]) {
    if ((res as any).error) return { error: (res as any).error.message, status: 500 as const }
  }
  const c = (company as any).data
  return {
    body: {
      contact: {
        ...toContact(r),
        locationName: (location as any).data?.name || null,
        // The company LINK, kept as a link: the linked company's own name,
        // never matched from the free-text company field.
        linkedCompany: c && !c.deleted_at ? { id: c.id, name: c.name } : null,
      },
      tags: ((tags as any).data || [])
        .map((t: any) => ({ id: t.id, label: t.label, icon: t.icon || null, section: t.location_id ? 'location' : (t.attrs?.section === 'relationship' ? 'relationship' : 'trade') }))
        .sort((a: any, b: any) => String(a.label).localeCompare(String(b.label))),
      touchpoints: (touchpoints as any).data || [],
      followUps: (reminders as any).data || [],
    },
  }
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { caller, refuse } = await gate()
  if (!caller) return refuse
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'contact_not_found' }, { status: 404 })
  const sheet = await loadSheet(id, caller.userId)
  if (!sheet.body) return NextResponse.json({ error: sheet.error }, { status: sheet.status })
  return NextResponse.json(sheet.body)
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { caller, refuse } = await gate()
  if (!caller) return refuse
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'contact_not_found' }, { status: 404 })

  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }

  // The row as it is stored now: what the plan compares against.
  const { data: stored, error: readErr } = await supabaseService.from('partners').select(EDIT_COLS).eq('id', id).maybeSingle()
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })
  if (!stored || (stored as any).deleted_at) return NextResponse.json({ error: 'contact_not_found' }, { status: 404 })

  // A paused or inactive location is read-only, as on every other write.
  const blocked = await readOnlyWriteBlock({ role: caller.role }, (stored as any).location_id)
  if (blocked) return blocked

  const row = stored as Record<string, unknown>
  const hasAdds = !!body && typeof body === 'object' && ADD_KEYS.some((k) => k in body)
  const refused = (p: { status: number; error: string; field?: string; current?: unknown }) =>
    NextResponse.json({ error: p.error, field: p.field ?? null, current: p.current ?? null, written: [] }, { status: p.status })

  // The nine fields (slice 4a). Asked for whenever `changes` is sent, and
  // also when nothing else is, so an empty save is still refused as before.
  const fields = body?.changes !== undefined || !hasAdds ? planContactSave(row, body?.changes) : null
  if (fields && !fields.ok) return refused(fields)

  // The note, the addresses and the company link (slice 4b).
  let company: any = null
  let author = ''
  if (hasAdds) {
    const to = body?.companyId?.to
    if (typeof to === 'string' && UUID.test(to)) {
      const found = await supabaseService.from('companies').select('id, location_id, deleted_at').eq('id', to).maybeSingle()
      if (found.error) return NextResponse.json({ error: found.error.message, written: [] }, { status: 500 })
      company = found.data
    }
    if ('addNote' in body) {
      const me = await supabaseService.from('hub_users').select('id, full_name, first_name').eq('id', caller.userId).maybeSingle()
      author = (me.data as any)?.first_name || (me.data as any)?.full_name || ''
    }
  }
  const adds = planContactAdds(row, hasAdds ? body : {}, { author, now: new Date(), company })
  if (!adds.ok) return refused(adds)

  const plan = {
    update: { ...(fields && fields.ok ? fields.update : {}), ...adds.update },
    written: [...(fields && fields.ok ? fields.written : []), ...adds.written],
    notes: [...(fields && fields.ok ? fields.notes : []), ...adds.notes],
  }

  // Nothing really changed: write nothing at all. updated_at does not move.
  if (plan.written.length > 0) {
    const { error: writeErr } = await supabaseService
      .from('partners')
      .update({ ...plan.update, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (writeErr) {
      console.error('[network contact PATCH]', writeErr)
      return NextResponse.json({ error: writeErr.message, written: [] }, { status: 500 })
    }
  }

  const sheet = await loadSheet(id, caller.userId)
  if (!sheet.body) return NextResponse.json({ error: sheet.error, written: plan.written }, { status: sheet.status })
  return NextResponse.json({ ...sheet.body, written: plan.written, notes: plan.notes })
}
