// app/api/leads/[id]/route.ts
//
// GET    /api/leads/:id — fetch a single lead with all joined tables (used by
//   the Supabase Realtime handler in useLeadsRealtime to refetch after INSERT/UPDATE)
// PATCH  /api/leads/:id — update a lead (Hive client record)
// DELETE /api/leads/:id — permanently delete a soft-deleted (is_junk=true)
//   lead. Only the Recycle Bin should call this; active leads must be
//   soft-deleted via PATCH { is_junk: true } first.
//
// Used by PersonPanel's update() function. Accepts a partial body containing
// any of the updatable fields. Validates inputs, enforces location scoping
// for non-admin users, dual-writes to Supabase + Zoho via lib/dual-write.
//
// Auth: must be a logged-in hub_user.
// Scope: super_admin/admin can update any lead. owner/lite_user can only
//        update leads in their own location.
// Validation: stage values are checked against the 9 allowed; addresses
//             must be an array; is_junk must be boolean.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { updateLead } from '@/lib/dual-write'
import { isAdmin } from '@/lib/auth'
import { applyDripSideEffects } from '@/lib/drip-lifecycle'
import { sendDripStep } from '@/lib/drip-send'
import { mapLeadToPerson } from '@/lib/people-mapper'
import { diffContactPatch, normalizePhoneDigits, normalizeEmail, type ContactWriteback } from '@/lib/jobber-contact-writeback'
import { syncLeadContactToJobber } from '@/lib/jobber-contact-sync'
import { diffAddressPatch } from '@/lib/lead-address'
import { syncLeadAddressToJobber } from '@/lib/jobber-address-sync'
import type { AddressWriteback } from '@/lib/jobber-address-writeback'

const VALID_STAGES = [
  'New',
  'Attempting',
  'Nurturing',
  'Request',
  'Estimate Sent',
  'Job in Progress',
  'Final Processing',
  'Closed Won',
  'Closed Lost',
] as const

// Fields a client request can update. Anything not in this list is dropped
// silently — prevents accidental overwriting of jobber_synced_at, created_at,
// location_id (slug), etc.
const PATCHABLE_FIELDS = new Set([
  'stage',
  'source',
  'project_type',
  'drip_path',
  'move_drip_path',
  'is_junk',
  'final_processed',
  'closed_lost_reason',
  'closed_lost_note',
  'referred_by_kind',
  'referred_by_id',
  'addresses',
  'assigned_to',
  'name',
  'first_name',
  'last_name',
  'email',
  'phone',
  // legacy single-field address (kept writable until we drop it post-launch)
  'address',
  'city',
  'state',
  'zip',
  // Phase 4 additions — see migrations/hive_clients_phase4_columns.sql
  'snoozed_until',
  'snoozed_note',
  'marketing_opt_out',
  'request_details',
  'paused',
  // Inbox soft-dismiss (migrations/leads_inbox_dismissed_at.sql). Inbox-
  // scoped only: the drip lifecycle deliberately does not know this
  // column — dismiss means "handled in my inbox", not "stop nurturing".
  'inbox_dismissed_at',
])

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }

  const { data: lead, error: leadError } = await supabaseService
    .from('leads')
    .select('*')
    .eq('id', id)
    .single()
  if (leadError || !lead) {
    return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  }

  // Location scoping for non-admins
  if (!isAdmin(hubUser.role) && hubUser.location_id !== lead.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  // Fetch all joined tables in parallel (mirrors _hub-page.tsx initial load)
  const [
    { data: lead_notes },
    { data: touchpoints },
    { data: lead_contacts },
    { data: lead_tags },
    { data: assessments },
    { data: service_requests },
    { data: quotes },
    { data: jobs },
    { data: invoices },
  ] = await Promise.all([
    supabaseService.from('lead_notes').select('*').eq('lead_id', id).order('created_at', { ascending: false }),
    supabaseService.from('touchpoints').select('*').eq('lead_id', id).order('occurred_at', { ascending: false }),
    supabaseService.from('lead_contacts').select('*').eq('lead_id', id).order('created_at', { ascending: true }),
    supabaseService.from('lead_tags').select('*').eq('lead_id', id),
    supabaseService.from('assessments').select('*').eq('lead_id', id).order('scheduled_at', { ascending: false }),
    supabaseService.from('service_requests').select('*').eq('lead_id', id).order('created_at', { ascending: false }),
    supabaseService.from('quotes').select('*').eq('lead_id', id).order('sent_at', { ascending: false }),
    supabaseService.from('jobs').select('*').eq('lead_id', id).order('scheduled_start', { ascending: false }),
    supabaseService.from('invoices').select('*').eq('lead_id', id).order('issued_at', { ascending: false }),
  ])

  // Resolve tag lookups
  const tagLookupIds = Array.from(new Set((lead_tags || []).map((lt: any) => lt.tag_lookup_id)))
  let tag_lookups: Record<string, any> = {}
  if (tagLookupIds.length > 0) {
    const { data: tagLookupRows } = await supabaseService
      .from('lookups')
      .select('*')
      .in('id', tagLookupIds)
    ;(tagLookupRows || []).forEach((row: any) => { tag_lookups[row.id] = row })
  }

  const person = mapLeadToPerson(lead, {
    lead_notes:       lead_notes       || [],
    touchpoints:      touchpoints      || [],
    lead_contacts:    lead_contacts    || [],
    lead_tags:        lead_tags        || [],
    assessments:      assessments      || [],
    service_requests: service_requests || [],
    quotes:           quotes           || [],
    jobs:             jobs             || [],
    invoices:         invoices         || [],
    tag_lookups,
  })

  return NextResponse.json({ person }, { status: 200 })
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  // ─── Auth ──────────────────────────────────────────────────────
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()

  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }

  // ─── Parse body ────────────────────────────────────────────────
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  // ─── Load existing lead for scoping check ─────────────────────
  const { data: existing, error: loadError } = await supabaseService
    .from('leads')
    .select('id, location_uuid, location_id, stage, jobber_client_id, phone, email, address, city, state, zip, addresses')
    .eq('id', id)
    .single()

  if (loadError || !existing) {
    return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  }

  // ─── Location scoping ─────────────────────────────────────────
  // Admins/super_admins can edit any lead. Owners + lite_users restricted
  // to leads in their own location.
  if (!isAdmin(hubUser.role)) {
    if (hubUser.location_id !== existing.location_uuid) {
      return NextResponse.json(
        { error: 'forbidden_wrong_location' },
        { status: 403 }
      )
    }
    // lite_users are read-only — block writes outright
    if (hubUser.role === 'lite_user') {
      return NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 })
    }
  }

  // ─── Validate + filter patch ──────────────────────────────────
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (!PATCHABLE_FIELDS.has(key)) continue // silently drop unknown
    patch[key] = value
  }

  // Stage validation
  if ('stage' in patch) {
    if (typeof patch.stage !== 'string' || !VALID_STAGES.includes(patch.stage as typeof VALID_STAGES[number])) {
      return NextResponse.json(
        { error: 'invalid_stage', allowed: VALID_STAGES },
        { status: 400 }
      )
    }
  }

  // is_junk + final_processed must be boolean
  for (const k of ['is_junk', 'final_processed'] as const) {
    if (k in patch && typeof patch[k] !== 'boolean') {
      return NextResponse.json({ error: `${k}_must_be_boolean` }, { status: 400 })
    }
  }

  // ─── Jobber-owns-deletion rule (Kevin 7/10) ───────────────────
  // Junking is Bee Hub's deletion door and it is PRE-JOBBER territory
  // only: a linked record's lifecycle belongs to Jobber (the *_DESTROY
  // webhooks — which write via the service client, never this route —
  // are the sole deletion path for linked records). Browser surfaces
  // hide the affordance; this 409 is the enforcement, mirroring the
  // manual_stage_move_rejected precedent. is_junk=false (restore/undo,
  // Bin resurrection) stays allowed.
  if (patch.is_junk === true && existing.jobber_client_id) {
    return NextResponse.json(
      {
        error: 'jobber_linked_junk_rejected',
        detail: 'This record is linked to Jobber — archive or delete it in Jobber; the change syncs back automatically.',
      },
      { status: 409 }
    )
  }

  // addresses must be an array of {type, value} objects
  if ('addresses' in patch) {
    if (!Array.isArray(patch.addresses)) {
      return NextResponse.json({ error: 'addresses_must_be_array' }, { status: 400 })
    }
    for (const a of patch.addresses as unknown[]) {
      if (typeof a !== 'object' || a === null) {
        return NextResponse.json({ error: 'address_entry_must_be_object' }, { status: 400 })
      }
    }
  }

  // referred_by_kind must be one of allowed values (or null)
  if ('referred_by_kind' in patch) {
    const v = patch.referred_by_kind
    if (v !== null && v !== 'partner' && v !== 'lead') {
      return NextResponse.json(
        { error: 'invalid_referred_by_kind', allowed: ['partner', 'lead', null] },
        { status: 400 }
      )
    }
  }

  // ─── Address column coherence ─────────────────────────────────
  // The hive AddressField PATCHes the LEGACY columns (address/city/
  // state/zip — the import's storage). But lib/people-mapper prefers a
  // non-empty `addresses` jsonb over them, so a classic-managed lead
  // would keep SHOWING its old jsonb entry after a hive edit. When this
  // patch really changes the address and doesn't manage `addresses`
  // itself (the classic popup does), rewrite the first Service-type
  // entry's value in step — other entries (Billing, Moving From…) are
  // untouched. On a full clear the matched entry is dropped.
  const addrDiff = diffAddressPatch(patch, existing as any)
  if (addrDiff.changed && !('addresses' in patch) && Array.isArray((existing as any).addresses) && (existing as any).addresses.length > 0) {
    const arr: any[] = (existing as any).addresses
    const idx = Math.max(0, arr.findIndex(a => a && a.type === 'Service'))
    patch.addresses = addrDiff.cleared
      ? arr.filter((_, i) => i !== idx)
      : arr.map((a, i) => (i === idx ? { ...a, value: addrDiff.display } : a))
  }

  // ─── Write ────────────────────────────────────────────────────
  // updateLead handles Supabase + Zoho dual-write. For fields it doesn't
  // know how to sync to Zoho (drip_path, is_junk, addresses jsonb, etc.),
  // it just updates Supabase — Zoho doesn't need every field. Stage and
  // source are the important sync paths.

  try {
    await updateLead(id, patch as any)
  } catch (e) {
    console.error('PATCH /api/leads/[id] failed:', e)
    const message = e instanceof Error ? e.message : 'update_failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // ─── Touchpoint on stage change ───────────────────────────────
  // Auto-log a stage_change touchpoint so the activity feed shows it.
  if ('stage' in patch && patch.stage !== existing.stage) {
    await supabaseService.from('touchpoints').insert({
      lead_id: id,
      location_uuid: existing.location_uuid,
      kind: 'stage_change',
      label: `Stage: ${existing.stage} → ${patch.stage}`,
      user_id: hubUser.id,
      occurred_at: new Date().toISOString(),
    })
  }

  // ─── Touchpoint on contact change (audit trail) ───────────────
  // Mirror of the stage_change auto-log above, for phone/email edits:
  // one lead-level entry per REAL change (normalized compare — the same
  // normalization diffContactPatch uses, so a formatting-only reformat
  // writes no entry, exactly as it fires no Jobber mutation). kind is
  // 'system' with method null: the touchpoints_kind_check vocabulary
  // has no contact_change value and migrations are SQL-editor-only —
  // 'system' renders through NotesStream/Timeline via the label, which
  // carries the new value; notes retains the old one. Inserted rows
  // ride the response (contact_activity) so open cards can prepend
  // them into Recent activity without a refetch.
  const contactActivity: any[] = []
  for (const field of ['phone', 'email'] as const) {
    const raw = patch[field]
    if (typeof raw !== 'string') continue
    const next = raw.trim()
    const prev = String((existing as any)[field] ?? '').trim()
    const norm = field === 'phone' ? normalizePhoneDigits : normalizeEmail
    if (norm(next) === norm(prev)) continue // formatting-only — not a change
    const label = field === 'phone' ? 'Phone' : 'Email'
    const { data: tpRow } = await supabaseService
      .from('touchpoints')
      .insert({
        lead_id: id,
        location_uuid: existing.location_uuid,
        kind: 'system',
        label: next ? `${label} updated → ${next}` : `${label} removed`,
        notes: prev ? `was ${prev}` : null,
        user_id: hubUser.id,
        occurred_at: new Date().toISOString(),
      })
      .select('id, kind, method, label, notes, occurred_at, engagement_id, user_id')
      .single()
    if (tpRow) contactActivity.push(tpRow)
  }

  // Address audit is written AFTER the Jobber sync (below) so its note
  // can carry the sync annotations (multi-property skip, upcoming
  // visits) — see the block after the write-back.

  // ─── Drip lifecycle side-effects ─────────────────────────────
  // Fire-and-forget by default: start on stage→'New', stop on exit,
  // pause/resume on paused toggle, stop on junk. Each branch swallows
  // its own errors so PATCH responses are never blocked by drip
  // bookkeeping.
  //
  // Exception: a stage→'New' transition starts a new drip whose step 1
  // is scheduled for now(). We await side-effects so the row exists,
  // then call sendDripStep inline so the welcome email fires in seconds
  // rather than waiting for the next hourly cron tick. Mirrors the
  // POST /api/leads inline-send path.
  if (existing.location_uuid) {
    // Inline drip-start cases:
    //   1. stage transitions into 'New' (welcome email next minute, not next hour)
    //   2. an imported/paused lead gets activated via paused → false; the resume
    //      path in applyDripSideEffects will seed step 1, and we want it to fire
    //      inline so the owner sees the activation actually do something
    const triggersDripStart =
      ('stage' in patch &&
        patch.stage === 'New' &&
        existing.stage !== 'New') ||
      ('paused' in patch && patch.paused === false)

    if (triggersDripStart) {
      try {
        await applyDripSideEffects({
          leadId: id,
          locationUuid: existing.location_uuid,
          prevStage: existing.stage ?? null,
          patch,
        })
        await sendDripStep(id)
      } catch (err) {
        console.error('[drip] PATCH inline drip-start threw', err)
      }
    } else {
      void applyDripSideEffects({
        leadId: id,
        locationUuid: existing.location_uuid,
        prevStage: existing.stage ?? null,
        patch,
      }).catch((err) => console.error('[drip] applyDripSideEffects threw', err))
    }
  }

  // ─── Jobber contact write-back on real phone/email change ─────
  // Jobber-linked leads never pass through send-to-jobber again, so the
  // d51b764 write-back can't reach them (feedback #2/#4 — Ankur's case).
  // When THIS patch actually changes phone/email (normalized diff:
  // formatting-only edits and webhook echoes don't count), push the new
  // value(s) to the linked Jobber client. Awaited but non-fatal — the
  // lead save above already succeeded; the outcome rides the response
  // and a sync_log breadcrumb (syncLeadContactToJobber never throws).
  let contactWriteback: ContactWriteback | null = null
  const contactDiff = diffContactPatch(patch, existing)
  if (contactDiff.changed && existing.jobber_client_id && existing.location_id) {
    contactWriteback = await syncLeadContactToJobber({
      leadId: id,
      locationSlug: existing.location_id,
      jobberClientId: String(existing.jobber_client_id),
      phone: contactDiff.phone ?? '',
      email: contactDiff.email ?? '',
    })
  }

  // ─── Jobber address write-back on real address change ─────────
  // Same rails, address flavor (lib/jobber-address-sync): ONE fetch-
  // current → per-target diff → clientEdit { billingAddress } + —
  // managed blast radius — propertyEdit on the client's SINGLE property
  // (multiple → deliberate skip; zero → nothing). A clearing edit never
  // pushes (we don't erase Jobber-side data). Awaited but non-fatal;
  // per-target outcomes ride the response.
  let addressWriteback: AddressWriteback | null = null
  if (addrDiff.changed && !addrDiff.cleared && existing.jobber_client_id && existing.location_id) {
    addressWriteback = await syncLeadAddressToJobber({
      leadId: id,
      locationSlug: existing.location_id,
      jobberClientId: String(existing.jobber_client_id),
      target: { street: addrDiff.street, city: addrDiff.city, state: addrDiff.state, zip: addrDiff.zip },
    })
  }

  // ─── Address audit touchpoint (after sync — the note tells the ──
  // whole truth). One entry per REAL change (normalized display
  // compare: a formatting-only reshuffle writes no entry, exactly as it
  // fires no Jobber mutation). Label carries the new normalized
  // display; notes retains the old value plus the sync annotations the
  // policy requires said explicitly.
  if (addrDiff.changed) {
    const noteParts: string[] = []
    if (addrDiff.prevDisplay) noteParts.push(`was ${addrDiff.prevDisplay}`)
    if (addressWriteback?.property === 'skipped_multiple') {
      noteParts.push('synced to Jobber billing — client has multiple properties, service address not changed')
    }
    if (addressWriteback?.upcoming_visits) {
      noteParts.push('property has upcoming visits — verify schedule')
    }
    const { data: tpRow } = await supabaseService
      .from('touchpoints')
      .insert({
        lead_id: id,
        location_uuid: existing.location_uuid,
        kind: 'system',
        label: addrDiff.display ? `Address updated → ${addrDiff.display}` : 'Address removed',
        notes: noteParts.length ? noteParts.join(' · ') : null,
        user_id: hubUser.id,
        occurred_at: new Date().toISOString(),
      })
      .select('id, kind, method, label, notes, occurred_at, engagement_id, user_id')
      .single()
    if (tpRow) contactActivity.push(tpRow)
  }

  // ─── Return fresh row ─────────────────────────────────────────
  const { data: fresh, error: refetchError } = await supabaseService
    .from('leads')
    .select('*')
    .eq('id', id)
    .single()

  if (refetchError) {
    console.error('PATCH /api/leads/[id] refetch failed:', refetchError)
    return NextResponse.json({ error: 'refetch_failed' }, { status: 500 })
  }

  return NextResponse.json(
    {
      lead: fresh,
      ...(contactWriteback ? { contact_writeback: contactWriteback } : {}),
      ...(addressWriteback ? { address_writeback: addressWriteback } : {}),
      ...(contactActivity.length ? { contact_activity: contactActivity } : {}),
    },
    { status: 200 },
  )
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  // ─── Auth ──────────────────────────────────────────────────────
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: hubUser, error: hubUserError } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()

  if (hubUserError || !hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }

  // ─── Load existing lead ───────────────────────────────────────
  const { data: existing, error: loadError } = await supabaseService
    .from('leads')
    .select('id, location_uuid, is_junk')
    .eq('id', id)
    .single()

  if (loadError || !existing) {
    return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  }

  // ─── Scoping ──────────────────────────────────────────────────
  if (!isAdmin(hubUser.role)) {
    if (hubUser.location_id !== existing.location_uuid) {
      return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
    }
    if (hubUser.role === 'lite_user') {
      return NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 })
    }
  }

  // ─── Safety: only soft-deleted rows are eligible for hard delete ──
  if (!existing.is_junk) {
    return NextResponse.json(
      { error: 'lead_not_in_bin', detail: 'Soft-delete via PATCH is_junk=true before permanent delete' },
      { status: 409 }
    )
  }

  // All FKs to leads(id) declare ON DELETE CASCADE (lead_notes, touchpoints,
  // lead_contacts, lead_tags, lead_drip_progress, etc.) — single DELETE here
  // wipes children atomically.
  const { error: delError } = await supabaseService.from('leads').delete().eq('id', id)

  if (delError) {
    console.error('DELETE /api/leads/[id] failed:', delError)
    return NextResponse.json({ error: 'delete_failed', detail: delError.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, id }, { status: 200 })
}
