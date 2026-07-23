// app/api/touchpoints/route.ts
//
// POST /api/touchpoints — log a touchpoint event on a lead OR a partner
// (Network Phase 1: exactly one of lead_id / partner_id — the same XOR the
// DB CHECK enforces after migrations/network_phase1.sql; the partner path
// fails loudly at the DB until that migration is applied, and the lead path
// is byte-identical to the pre-partner contract either way).
//
// Kinds:
//   - reach_out    — manual outreach (call, sms, email, in-person, coffee…)
//   - drip         — automated drip campaign send (system-fired)
//   - system       — auto-generated event ("Jobber search ran", etc.)
//   - stage_change — written automatically by PATCH /api/leads/[id]
//   - note         — reserved for cross-references; rarely written directly
//
// Methods (if relevant for the kind):
//   call | sms | email | system | call_prompt | in_person
//   | coffee | event | thank_you   ← partner-relationship vocabulary
//   (Classic's 'text' maps to sms, 'thankyou' to thank_you; 'referral' is
//   NOT a method — a referral is the referred lead row itself.)
//
// Auth: must be a logged-in hub_user.
// Scope: super_admin/admin can write anywhere. owner can only write to
//        leads/partners in their location. lite_user blocked.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { insertTouchpoint } from '@/lib/touchpoints'

const VALID_KINDS = ['reach_out', 'drip', 'system', 'stage_change', 'note'] as const
const VALID_METHODS = [
  'call', 'sms', 'email', 'system', 'call_prompt', 'in_person',
  // Partner-relationship vocabulary (network_phase1.sql widens the DB CHECK
  // to match; until it runs, nothing sends these values).
  'coffee', 'event', 'thank_you',
] as const

type TouchpointKind = (typeof VALID_KINDS)[number]
type TouchpointMethod = (typeof VALID_METHODS)[number]

export async function POST(req: Request) {
  // Auth
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

  if (hubUser.role === 'lite_user') {
    return NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 })
  }

  // Parse body
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 })
  }

  const lead_id = body.lead_id as string | undefined
  const partner_id = body.partner_id as string | undefined
  const kind = body.kind as string | undefined
  const method = body.method as string | null | undefined
  const label = body.label as string | undefined
  const status = body.status as string | null | undefined
  const drip_id = body.drip_id as string | null | undefined
  const notes = body.notes as string | null | undefined
  const occurred_at = body.occurred_at as string | undefined

  // Validate the subject: exactly one of lead_id / partner_id (the DB XOR).
  const hasLead = typeof lead_id === 'string' && lead_id.length > 0
  const hasPartner = typeof partner_id === 'string' && partner_id.length > 0
  if (!hasLead && !hasPartner) {
    return NextResponse.json({ error: 'lead_id_or_partner_id_required' }, { status: 400 })
  }
  if (hasLead && hasPartner) {
    return NextResponse.json({ error: 'one_subject_only' }, { status: 400 })
  }
  if (!kind || !VALID_KINDS.includes(kind as TouchpointKind)) {
    return NextResponse.json(
      { error: 'invalid_kind', allowed: VALID_KINDS },
      { status: 400 }
    )
  }
  if (!label || typeof label !== 'string' || label.trim().length === 0) {
    return NextResponse.json({ error: 'label_required' }, { status: 400 })
  }

  // Validate optional method
  if (method != null) {
    if (typeof method !== 'string' || !VALID_METHODS.includes(method as TouchpointMethod)) {
      return NextResponse.json(
        { error: 'invalid_method', allowed: VALID_METHODS },
        { status: 400 }
      )
    }
  }

  // Load the subject for scoping — lead path unchanged; partner rows carry
  // location_id (uuid, same value form as leads.location_uuid).
  let subjectLocation: string
  if (hasLead) {
    const { data: lead, error: leadError } = await supabaseService
      .from('leads')
      .select('id, location_uuid')
      .eq('id', lead_id)
      .single()
    if (leadError || !lead) {
      return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
    }
    subjectLocation = lead.location_uuid
  } else {
    const { data: partner, error: partnerError } = await supabaseService
      .from('partners')
      .select('id, location_id')
      .eq('id', partner_id)
      .single()
    if (partnerError || !partner) {
      return NextResponse.json({ error: 'partner_not_found' }, { status: 404 })
    }
    subjectLocation = partner.location_id
  }

  // Location scoping
  if (!isAdmin(hubUser.role)) {
    if (hubUser.location_id !== subjectLocation) {
      return NextResponse.json(
        { error: 'forbidden_wrong_location' },
        { status: 403 }
      )
    }
  }

  // ─── Read-only guard (868kawwmh) ──────────────────────────────
  const roBlock = await readOnlyWriteBlock(hubUser, subjectLocation)
  if (roBlock) return roBlock

  // Insert via the shared writer (lib/touchpoints.ts) so the Slack "Log call"
  // interactivity handler and this in-record path produce identical rows. The
  // reach_out updated_at bump lives inside insertTouchpoint. system/drip events
  // have no human author; everything else is attributed to the session user.
  const result = await insertTouchpoint({
    ...(hasLead ? { lead_id } : { partner_id }),
    location_uuid: subjectLocation,
    kind,
    // Phase 1: touchpoints can carry engagement context (column exists
    // since the step-1 migration). Optional — client-level touchpoints
    // pass nothing and behave exactly as before.
    engagement_id:
      typeof body.engagement_id === 'string' && body.engagement_id
        ? body.engagement_id
        : null,
    label,
    method: method ?? null,
    status: status ?? null,
    drip_id: drip_id ?? null,
    notes: notes ?? null,
    user_id: kind === 'system' || kind === 'drip' ? null : hubUser.id,
    occurred_at: occurred_at ?? null,
  })

  if (!result.ok) {
    return NextResponse.json(
      { error: 'insert_failed', detail: result.error },
      { status: 500 }
    )
  }

  return NextResponse.json({ touchpoint: result.touchpoint }, { status: 201 })
}