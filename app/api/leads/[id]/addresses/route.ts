// app/api/leads/[id]/addresses/route.ts
//
// THE CLIENT'S OTHER ADDRESSES — add, retire, restore, relabel.
//
// The address PATCH on /api/leads/:id stays exactly what it is: it CORRECTS
// the primary address in place and pushes that correction to Jobber. This
// route is the other two verbs, which used to be smuggled through that same
// pencil behind a "Did they move?" question. Two explicit actions, no question:
//
//   ADD     — the client also has this address. Creates a Jobber property for
//             it immediately when the client is linked, and stores the id.
//             That is not optional: the send-time picker (a883435) resolves a
//             second address to a property that ALREADY EXISTS and refuses to
//             create one, so an added address with no property is an address
//             you cannot send work to.
//   RETIRE  — stop offering it. BEE HUB ONLY. Jobber has no archive; deletion
//             is its only option and it takes the property's quotes and jobs
//             with it, so we never delete and never pretend to. The property
//             stays in Jobber, whole, and still bookable there.
//
// RESTORE and RELABEL are the small reversible siblings — a retire that was a
// mistake, and a label that was wrong.
//
// A MOVE is now add-then-retire. Two things the owner actually did, in the
// order they did them, each undoable on its own.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import {
  buildAddedAddress,
  parseFormerAddresses,
  isMissingFormerAddressesColumn,
  composeLeadAddress,
  normalizeAddressKey,
  formatLeadAddress,
  type FormerAddress,
} from '@/lib/lead-address'
import { validateAddressLabel, addressLabelText } from '@/lib/address-labels'
import { createPropertyForMove } from '@/lib/jobber-address-sync'

export const runtime = 'nodejs'

type Action = 'add' | 'retire' | 'restore' | 'relabel'
const ACTIONS: Action[] = ['add', 'retire', 'restore', 'relabel']

function bad(error: string, status = 400, extra: object = {}) {
  return NextResponse.json({ error, ...extra }, { status })
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // ─── Auth (the /api/leads/:id rails, unchanged) ─────────────────
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return bad('unauthorized', 401)

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (hubUserError || !hubUser) return bad('no_hub_user_profile', 403)

  let body: Record<string, any>
  try { body = await req.json() } catch { return bad('invalid_json_body') }

  const action = body.action as Action
  if (!action || !ACTIONS.includes(action)) {
    return bad('invalid_action', 400, { allowed: ACTIONS })
  }

  const { data: existing, error: loadError } = await supabaseService
    .from('leads')
    .select('id, name, location_uuid, location_id, stage, jobber_client_id, jobber_property_id, address, city, state, zip, address_label, address_label_note, former_addresses')
    .eq('id', id)
    .single()
  if (loadError || !existing) {
    // The two new columns are the pending migration; name it rather than
    // returning a bare 500 the owner cannot act on.
    if (loadError && /address_label|former_addresses/i.test(loadError.message || '')) {
      console.warn('[lead addresses] migration pending —', loadError.message)
      return bad('addresses_not_available_yet', 503)
    }
    return bad('lead_not_found', 404)
  }

  if (!isAdmin(hubUser.role) && hubUser.location_id !== existing.location_uuid) {
    return bad('forbidden_wrong_location', 403)
  }
  const roBlock = await readOnlyWriteBlock(hubUser, existing.location_uuid)
  if (roBlock) return roBlock

  const list: FormerAddress[] = parseFormerAddresses(existing.former_addresses)
  const nowIso = new Date().toISOString()

  // ─── RELABEL the PRIMARY address ────────────────────────────────
  // The primary lives in the four columns; its label lives beside them.
  if (action === 'relabel' && body.target === 'primary') {
    const v = validateAddressLabel(body.label, body.label_note)
    if (!v.ok) return bad(v.error)
    const { error: upErr } = await supabaseService
      .from('leads')
      .update({ address_label: v.label, address_label_note: v.note, updated_at: nowIso })
      .eq('id', id)
    if (upErr) {
      if (isMissingAddressLabelColumn(upErr)) return bad('addresses_not_available_yet', 503)
      return bad(upErr.message, 500)
    }
    return NextResponse.json({
      success: true,
      address_label: v.label,
      address_label_note: v.note,
      former_addresses: list,
    })
  }

  // ─── ADD ────────────────────────────────────────────────────────
  if (action === 'add') {
    const street = String(body.street ?? '').trim()
    const city   = String(body.city ?? '').trim()
    const state  = String(body.state ?? '').trim()
    const zip    = String(body.zip ?? '').trim()
    if (!street) return bad('street_required')

    const v = validateAddressLabel(body.label, body.label_note)
    if (!v.ok) return bad(v.error)

    // Never add the address the client already has. Compared the same
    // normalized way the pencil decides an edit is a no-op, against the
    // primary AND every entry (retired included — restoring beats
    // duplicating).
    const candidateKey = normalizeAddressKey(composeLeadAddress({ street, city, state, zip }))
    const primaryKey = normalizeAddressKey(formatLeadAddress(existing as any))
    if (candidateKey && candidateKey === primaryKey) {
      return bad('address_already_on_client', 409, { where: 'primary' })
    }
    const dupIndex = list.findIndex(e => normalizeAddressKey(e.display) === candidateKey)
    if (dupIndex > -1) {
      return bad('address_already_on_client', 409, { where: 'other', index: dupIndex })
    }

    // ── Jobber FIRST, so the row write carries the property id ─────
    // Order is load-bearing exactly as it is on the move path: if Jobber
    // fails we must not end up with a Bee Hub address that claims a
    // property it does not have.
    let jobberPropertyId: string | null = null
    let jobberOutcome: 'created' | 'not_linked' | 'failed' = 'not_linked'
    if (existing.jobber_client_id && existing.location_id) {
      const res = await createPropertyForMove({
        leadId: id,
        locationSlug: existing.location_id,
        jobberClientId: String(existing.jobber_client_id),
        target: { street, city, state, zip },
      })
      if (res.created && res.propertyId) {
        jobberPropertyId = res.propertyId
        jobberOutcome = 'created'
      } else {
        jobberOutcome = 'failed'
      }
    }

    const entry = buildAddedAddress({ street, city, state, zip }, jobberPropertyId, v.label, v.note, nowIso)
    if (!entry) return bad('street_required')

    const next = [...list, entry]
    const { error: upErr } = await supabaseService
      .from('leads')
      .update({ former_addresses: next, updated_at: nowIso })
      .eq('id', id)
    if (upErr) {
      if (isMissingFormerAddressesColumn(upErr)) return bad('addresses_not_available_yet', 503)
      return bad(upErr.message, 500)
    }

    await writeAddressTouchpoint(id, existing, hubUser.id, nowIso,
      `Address added → ${entry.display}`,
      [
        addressLabelText(v.label, v.note) ? `labelled ${addressLabelText(v.label, v.note)}` : null,
        jobberOutcome === 'created'  ? `new Jobber property ${jobberPropertyId} created` : null,
        jobberOutcome === 'failed'   ? 'Jobber property NOT created — sync failed, address saved here only' : null,
        jobberOutcome === 'not_linked' ? 'not connected to Jobber — saved here only' : null,
      ].filter(Boolean) as string[])

    return NextResponse.json({
      success: true,
      index: next.length - 1,
      entry,
      former_addresses: next,
      jobber: jobberOutcome,
      jobber_property_id: jobberPropertyId,
    })
  }

  // ─── RETIRE / RESTORE / RELABEL an entry ────────────────────────
  const index = Number(body.index)
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    return bad('address_not_found', 404)
  }
  const target = list[index]
  const next = list.slice()

  if (action === 'relabel') {
    const v = validateAddressLabel(body.label, body.label_note)
    if (!v.ok) return bad(v.error)
    next[index] = { ...target, label: v.label, label_note: v.note }
  } else {
    // RETIRE / RESTORE. Bee Hub only — no Jobber call is made here, by
    // design and not by omission. Jobber has no archive; the property and
    // every quote, job and invoice on it are left exactly as they are.
    next[index] = { ...target, status: action === 'retire' ? 'retired' : 'active' }
  }

  const { error: upErr } = await supabaseService
    .from('leads')
    .update({ former_addresses: next, updated_at: nowIso })
    .eq('id', id)
  if (upErr) {
    if (isMissingFormerAddressesColumn(upErr)) return bad('addresses_not_available_yet', 503)
    return bad(upErr.message, 500)
  }

  if (action !== 'relabel') {
    await writeAddressTouchpoint(id, existing, hubUser.id, nowIso,
      `${action === 'retire' ? 'Address retired' : 'Address back in use'} → ${target.display}`,
      action === 'retire'
        ? ['still in Jobber with its history — hidden here only']
        : [])
  }

  return NextResponse.json({ success: true, index, entry: next[index], former_addresses: next })
}

// Postgres "column does not exist" for the label columns — same posture as
// isMissingFormerAddressesColumn, so a pending migration reads as a calm 503
// rather than a 500 nobody can act on.
function isMissingAddressLabelColumn(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  const msg = String(e.message ?? '').toLowerCase()
  if (!msg.includes('address_label')) return false
  const code = String(e.code ?? '')
  return code === '42703' || code === 'PGRST204' || msg.includes('column') || msg.includes('schema cache')
}

// The audit entry, in the shape the address PATCH already writes so the
// timeline reads consistently. Fire-and-forget: a lost timeline row must
// never fail a save that landed.
async function writeAddressTouchpoint(
  leadId: string,
  existing: { location_uuid: string; stage?: string | null },
  userId: string,
  nowIso: string,
  label: string,
  noteParts: string[],
) {
  try {
    await supabaseService.from('touchpoints').insert({
      lead_id: leadId,
      location_uuid: existing.location_uuid,
      kind: 'system',
      label,
      notes: noteParts.length ? noteParts.join(' · ') : null,
      user_id: userId,
      occurred_at: nowIso,
    })
  } catch (e: any) {
    console.warn('[lead addresses] touchpoint insert failed', e?.message || e)
  }
}
