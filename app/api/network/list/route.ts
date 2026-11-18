// app/api/network/list/route.ts
//
// GET /api/network/list?location_id=<uuid>   (omit location_id → every location)
//
// The one read behind the NEW Network list (Network & Nurture redesign,
// slice 3). READ-ONLY: this file has no POST, PATCH or DELETE and writes
// nothing.
//
// WHO MAY CALL IT: super admins only, for now. The new list is being built
// behind the grey: every other role still sees Network closed, and this route
// answers them 403, so the new columns cannot be read by an owner through the
// address bar either. Later slices open it role by role; that is a change to
// lib/network/access.ts and nowhere else.
//
// WHAT IT READS, all through the service client after the role check:
//   · partners (live rows only) — the contact, plus the three columns the
//     backfill filled: network_types, partner_level, partner_stage. A row
//     where they are still empty (added by an old door since) is sent as it
//     is and the list shows it as "Not sure yet".
//   · partner_tags → lookups — tag ids on each contact, and their names.
//   · locations — the location's name, for the every-location view.
//   · reminders — THE CALLER'S OWN open reminders on Network contacts, the
//     same rule /api/reminders uses (reminders are personal). The soonest one
//     per contact is that contact's follow-up date.
//
// It does not send types, levels or stages through any rule: it sends what is
// stored. lib/network/list.ts (contactFromRow) applies the rules, in one place.
//
// Referral numbers are NOT here: the screen asks /api/network/summary for
// them, the same real rollup the old screen used.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { maySeeNewNetwork } from '@/lib/network/access'

export const runtime = 'nodejs'

const PAGE = 1000
const MAX_ROWS = 5000
const CHUNK = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const LIST_COLS =
  'id, location_id, name, company, title, phone, email, how_we_met, birthday, ' +
  'network_types, partner_level, partner_stage, is_customer, last_contacted_at, ' +
  'partner_tags(tag_lookup_id)'

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!maySeeNewNetwork(caller.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const locationId = request.nextUrl.searchParams.get('location_id')
  if (locationId && !UUID.test(locationId)) {
    return NextResponse.json({ error: 'location_id must be a location id' }, { status: 400 })
  }

  // Short-page loop, like /api/partners: PostgREST's silent 1,000-row default
  // is not "everything", so page explicitly and say so if the ceiling is hit.
  const rows: any[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    let q = supabaseService
      .from('partners')
      .select(LIST_COLS)
      .is('deleted_at', null)
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (locationId) q = q.eq('location_id', locationId)
    const { data, error } = await q
    if (error) {
      console.error('[network list] partners', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    rows.push(...(data || []))
    if ((data || []).length < PAGE) break
  }
  const truncated = rows.length >= MAX_ROWS

  // Tag names, for the ids these contacts actually carry.
  const tagIds = Array.from(new Set(rows.flatMap((r) => (r.partner_tags || []).map((t: any) => t.tag_lookup_id)).filter(Boolean)))
  const tags: { id: string; label: string }[] = []
  for (let i = 0; i < tagIds.length; i += CHUNK) {
    const { data, error } = await supabaseService.from('lookups').select('id, label').in('id', tagIds.slice(i, i + CHUNK))
    if (error) {
      console.error('[network list] lookups', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    for (const t of data || []) tags.push({ id: (t as any).id, label: (t as any).label })
  }

  // Location names (27 locations hold contacts today; one read).
  const locIds = Array.from(new Set(rows.map((r) => r.location_id).filter(Boolean)))
  const locName = new Map<string, string>()
  for (let i = 0; i < locIds.length; i += CHUNK) {
    const { data, error } = await supabaseService.from('locations').select('id, name').in('id', locIds.slice(i, i + CHUNK))
    if (error) {
      console.error('[network list] locations', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    for (const l of data || []) locName.set((l as any).id, (l as any).name)
  }

  // The caller's own open reminders on Network contacts; soonest per contact.
  const { data: rem, error: remErr } = await supabaseService
    .from('reminders')
    .select('partner_id, due_on')
    .eq('user_id', caller.userId)
    .is('done_at', null)
    .not('partner_id', 'is', null)
    .order('due_on', { ascending: true })
  if (remErr) {
    console.error('[network list] reminders', remErr)
    return NextResponse.json({ error: remErr.message }, { status: 500 })
  }
  const inScope = new Set(rows.map((r) => r.id))
  const followUps: Record<string, string> = {}
  for (const r of rem || []) {
    const id = (r as any).partner_id as string
    const due = (r as any).due_on as string
    // The soonest, compared here rather than trusted to the read's order.
    if (inScope.has(id) && due && (!followUps[id] || due < followUps[id])) followUps[id] = due
  }

  return NextResponse.json({
    contacts: rows.map((r) => ({
      id: r.id,
      locationId: r.location_id,
      locationName: locName.get(r.location_id) || null,
      name: r.name,
      company: r.company || null,
      title: r.title || null,
      phone: r.phone || null,
      email: r.email || null,
      howWeMet: r.how_we_met || null,
      // Slice 5: the export writes it out, so a file read back keeps it.
      birthday: r.birthday || null,
      networkTypes: r.network_types ?? null,
      partnerLevel: r.partner_level ?? null,
      partnerStage: r.partner_stage ?? null,
      isCustomer: !!r.is_customer,
      lastContactedAt: r.last_contacted_at || null,
      tagIds: (r.partner_tags || []).map((t: any) => t.tag_lookup_id),
    })),
    tags,
    followUps,
    total: rows.length,
    truncated,
  })
}
