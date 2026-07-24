// app/api/leads/[id]/network/route.ts
//
// The lead → Network door. People used the old system as a CRM, so a lot of
// "leads" are really CONTACTS that got captured in the wrong place: the
// realtor who sends work, the vendor, the neighbour. This converts one into a
// Network person in a single press.
//
// TWO MODES, chosen at press time:
//   add  — they STAY in the pipeline AND become a Network person (Karen Pell:
//          buys from us AND refers us). is_customer + customer_lead_id, so the
//          gold Client badge deep-links back to the client record.
//   move — this was never really a client. Same partner row, plus the lead
//          leaves the Inbox via inbox_dismissed_at (+ paused, see below).
//
// GET  — the PREVIEW the sheet opens on: would this create, or link?
// POST — the conversion. Body: { mode, specialties?, partner_id? }
//
// WHY THE LEAD IS SOFT-HIDDEN AND NOT JUNKED (move):
//   inbox_dismissed_at is the purpose-built Inbox soft-removal — the record
//   stays searchable, keeps its true derived status in the directory, and the
//   undo is a single null write. is_junk is the deletion antechamber: it hides
//   the record from search and is refused outright on Jobber-linked rows. These
//   are GOOD contacts in the wrong place; they must stay findable.
//
// WHY paused RIDES ALONG (move):
//   dismiss is deliberately unknown to lib/drip-lifecycle — the column means
//   "handled in my inbox", NOT "stop nurturing" — so a moved realtor would
//   keep receiving homeowner drip emails. `paused` is the reversible lifecycle
//   switch that actually stops them (pauseActiveDripsForLead), and Activate
//   Drips turns them back on. Both columns are on the lead, both restorable.
//
// The lead write mirrors PATCH /api/leads/[id] exactly — updateLead (the
// dual-write path; neither column is Zoho-mapped, so the Zoho half is a no-op)
// followed by applyDripSideEffects. One vocabulary, not two.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { updateLead } from '@/lib/dual-write'
import { applyDripSideEffects } from '@/lib/drip-lifecycle'
import { insertTouchpoint } from '@/lib/touchpoints'
import { PARTNER_COLS, mapPartnerRow, loadCaller, canWriteLocation, canReadLocation } from '@/lib/crm'
import {
  findPartnerForLead,
  leadToPartnerRow,
  fillEmptyPartnerPatch,
  NEW_PARTNER_STAGE,
} from '@/lib/lead-to-network'

export const runtime = 'nodejs'

const LEAD_COLS =
  'id, name, first_name, last_name, email, phone, address, city, state, zip, addresses, ' +
  'source, request_details, location_uuid, stage, created_at, inbox_dismissed_at, paused, is_junk'

// `any` deliberately: the generated client types a multi-column select as a
// union with GenericStringError, and every other route in this tree reads
// lead rows untyped for the same reason.
async function loadLead(id: string): Promise<any> {
  const { data, error } = await supabaseService
    .from('leads')
    .select(LEAD_COLS)
    .eq('id', id)
    .maybeSingle()
  if (error || !data) return null
  return data
}

// The partner's public projection for the preview — enough for the sheet to
// say "we'll link to Karen Martinez instead of creating a second one", not the
// whole row.
const previewPartner = (p: any) =>
  p
    ? {
        id: p.id,
        name: p.name,
        stage: p.stage || '',
        specialties: p.specialties || [],
        isCustomer: !!p.is_customer,
        customerLeadId: p.customer_lead_id ?? null,
      }
    : null

// ── GET — preview ───────────────────────────────────────────────────────────
// Read-only, so it is scoped with canReadLocation. The answer here is ADVISORY:
// POST re-runs the same query before it writes (a partner can be created
// between opening the sheet and pressing the button), the same
// people-prop-gate-then-DB-gate discipline the intake door uses.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const lead = await loadLead(id)
  if (!lead) return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  if (!lead.location_uuid) {
    return NextResponse.json({ error: 'lead_has_no_location' }, { status: 409 })
  }
  if (!canReadLocation(caller, lead.location_uuid)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Already converted? The link is one-directional (partners.customer_lead_id
  // → leads.id; there is no leads.partner_id), so "does this client already
  // have a Network twin" is a query, not a column read.
  const { data: linkedRows } = await supabaseService
    .from('partners')
    .select(PARTNER_COLS)
    .eq('customer_lead_id', id)
    .is('deleted_at', null)
    .limit(1)
  const linked = (linkedRows || [])[0] || null
  if (linked) {
    return NextResponse.json({
      existing: previewPartner(linked),
      matchedOn: 'link',
      alreadyLinked: true,
    })
  }

  let match = null
  try {
    match = await findPartnerForLead(supabaseService, {
      locationId: lead.location_uuid,
      email: lead.email,
      phone: lead.phone,
    })
  } catch (e: any) {
    // A failed preview must not block the door — POST runs the authoritative
    // gate anyway. Report it so the sheet can say "couldn't check for
    // duplicates" instead of implying a clean miss.
    console.error('[leads/network GET] match failed:', e?.message || e)
    return NextResponse.json({ existing: null, matchedOn: null, alreadyLinked: false, matchError: true })
  }

  return NextResponse.json({
    existing: previewPartner(match?.partner),
    matchedOn: match?.matchedOn ?? null,
    alreadyLinked: false,
  })
}

// ── POST — convert ──────────────────────────────────────────────────────────
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const mode = body?.mode
  if (mode !== 'add' && mode !== 'move') {
    return NextResponse.json({ error: 'invalid_mode', allowed: ['add', 'move'] }, { status: 400 })
  }
  const specialties: string[] = Array.isArray(body?.specialties)
    ? body.specialties.filter((s: any) => typeof s === 'string' && s.trim()).slice(0, 8)
    : []

  const lead = await loadLead(id)
  if (!lead) return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  if (!lead.location_uuid) {
    return NextResponse.json({ error: 'lead_has_no_location' }, { status: 409 })
  }
  // canWriteLocation, not the leads route's isAdmin-or-same-location check:
  // this CREATES CRM data, and lite_user is read-only across the CRM.
  if (!canWriteLocation(caller, lead.location_uuid)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const roBlock = await readOnlyWriteBlock({ role: caller.role }, lead.location_uuid)
  if (roBlock) return roBlock

  const leadName =
    (lead.name || '').trim() || [lead.first_name, lead.last_name].filter(Boolean).join(' ').trim()
  if (!leadName) {
    return NextResponse.json({ error: 'lead_has_no_name' }, { status: 409 })
  }

  // ── resolve the target partner: an explicit confirmed link, else the
  // authoritative match, else a fresh row. Match-then-link, never blind-create.
  let target: any = null
  let matchedOn: string | null = null

  if (typeof body?.partner_id === 'string' && body.partner_id) {
    const { data: chosenRow } = await supabaseService
      .from('partners')
      .select(PARTNER_COLS)
      .eq('id', body.partner_id)
      .is('deleted_at', null)
      .maybeSingle()
    const chosen: any = chosenRow
    if (!chosen) return NextResponse.json({ error: 'partner_not_found' }, { status: 404 })
    // A cross-location link would put this person in someone else's Network.
    if (chosen.location_id !== lead.location_uuid) {
      return NextResponse.json({ error: 'partner_wrong_location' }, { status: 409 })
    }
    target = chosen
    matchedOn = 'chosen'
  } else {
    // Re-run the gate at write time (see GET's note) — and again on 'All
    // Locations', where the client has no partner pool to have checked with.
    try {
      const match = await findPartnerForLead(supabaseService, {
        locationId: lead.location_uuid,
        email: lead.email,
        phone: lead.phone,
      })
      if (match) {
        target = match.partner
        matchedOn = match.matchedOn
      }
    } catch (e: any) {
      // The dedup gate failing is NOT a reason to create a duplicate.
      console.error('[leads/network POST] match failed:', e?.message || e)
      return NextResponse.json({ error: 'dedup_check_failed' }, { status: 503 })
    }
  }

  // is_customer is the CLIENT claim, and only 'add' makes it. A moved contact
  // was never really a client, so flagging one would be a lie the gold badge
  // then repeats. customer_lead_id is set either way — it is the LINK (the
  // timeline union and the reverse lookup both key off it), not a claim.
  // An existing true is never downgraded: a partner who really is a client
  // does not stop being one because this lead was filed wrong.
  const claimCustomer = mode === 'add'

  let partnerRow: any
  if (target) {
    const patch: Record<string, any> = {
      ...fillEmptyPartnerPatch(target, lead, specialties),
      customer_lead_id: id,
      is_customer: claimCustomer || !!target.is_customer,
      updated_at: new Date().toISOString(),
    }
    const { data, error } = await supabaseService
      .from('partners')
      .update(patch)
      .eq('id', target.id)
      .select(PARTNER_COLS)
      .single()
    if (error) {
      console.error('[leads/network POST] link failed:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    partnerRow = data
  } else {
    const insert = {
      ...leadToPartnerRow(lead, { specialties, stage: NEW_PARTNER_STAGE }),
      customer_lead_id: id,
      is_customer: claimCustomer,
      created_by: caller.userId,
    }
    const { data, error } = await supabaseService
      .from('partners')
      .insert(insert)
      .select(PARTNER_COLS)
      .single()
    if (error) {
      console.error('[leads/network POST] create failed:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    partnerRow = data
  }

  // ── seed last_contacted_at from the carried history ───────────────────────
  // The partner timeline UNIONS the linked lead's touchpoints (they stay on the
  // lead — the touchpoints XOR means one row can only ever have one subject),
  // but partners.last_contacted_at is a STORED cache that lib/touchpoints is
  // the only maintainer of, and it is deliberately absent from
  // PARTNER_FIELD_MAP so no PATCH can hand-write it. Without this seed a
  // converted person with eight logged calls reads lastContactedAt: null →
  // contactRecency 'unknown' → "never contacted", and the stat tile shows '—'.
  // Service-role write, here, once, from the real row. Never moves it
  // BACKWARDS — a partner already talked to more recently keeps their value.
  const { data: lastReach } = await supabaseService
    .from('touchpoints')
    .select('occurred_at')
    .eq('lead_id', id)
    .eq('kind', 'reach_out')
    .order('occurred_at', { ascending: false })
    .limit(1)
  const carriedAt = (lastReach || [])[0]?.occurred_at || null
  if (carriedAt && (!partnerRow.last_contacted_at || partnerRow.last_contacted_at < carriedAt)) {
    const { data: bumped } = await supabaseService
      .from('partners')
      .update({ last_contacted_at: carriedAt })
      .eq('id', partnerRow.id)
      .select(PARTNER_COLS)
      .single()
    if (bumped) partnerRow = bumped
  }

  // ── the lead side ─────────────────────────────────────────────────────────
  const leadPatch: Record<string, any> = {}
  if (mode === 'move') {
    leadPatch.inbox_dismissed_at = new Date().toISOString()
    // Already paused → leave it; re-writing true would be a no-op that still
    // fires pauseActiveDripsForLead.
    if (!lead.paused) leadPatch.paused = true
  }

  if (Object.keys(leadPatch).length > 0) {
    try {
      await updateLead(id, leadPatch as any)
      await applyDripSideEffects({
        leadId: id,
        locationUuid: lead.location_uuid,
        prevStage: lead.stage ?? null,
        patch: leadPatch,
      })
    } catch (e: any) {
      // The partner row is already real. Say so rather than reporting a total
      // failure that would invite a second press (and a second partner).
      console.error('[leads/network POST] lead patch failed after partner write:', e?.message || e)
      return NextResponse.json(
        {
          partner: mapPartnerRow(partnerRow),
          mode,
          linked: !!target,
          matchedOn,
          lead_patch: {},
          warning: 'partner_created_lead_not_updated',
          error: String(e?.message || e),
        },
        { status: 207 }
      )
    }
  }

  // Audit trail on the LEAD, mirroring the Inbox dismiss + resurrection logs.
  // Fire-and-forget: the conversion itself already landed, and this row also
  // surfaces on the partner's unioned timeline, which is where it reads best.
  void insertTouchpoint({
    lead_id: id,
    location_uuid: lead.location_uuid,
    kind: 'system',
    method: 'system',
    label:
      mode === 'move'
        ? `Moved to Network as ${partnerRow.name} — drips paused`
        : `Added to Network as ${partnerRow.name}`,
    user_id: caller.userId,
  }).then((r) => {
    if (!r.ok) console.warn('[leads/network POST] audit touchpoint failed:', r.error)
  })

  return NextResponse.json({
    partner: mapPartnerRow(partnerRow),
    mode,
    linked: !!target,
    matchedOn,
    // The Person-shaped columns the client folds into people state so the
    // Inbox row drops and the record reflects it without a reload.
    lead_patch: leadPatch,
  })
}
