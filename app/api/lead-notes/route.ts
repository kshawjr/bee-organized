// app/api/lead-notes/route.ts
//
// POST /api/lead-notes — create an internal note on a lead
//
// Lead notes are internal-only (NOT synced to Jobber — that's the separate
// `notes` table). Four kinds:
//   - buzz   — quick observations
//   - job    — job-specific notes
//   - close  — close-out reasons / context when stage moves to Won/Lost
//   - system — auto-generated entries (stage changes, drip starts, etc.)
//
// Auth: must be a logged-in hub_user.
// Scope: super_admin/admin can write to any lead. owner can only write
//        to leads in their location. lite_user blocked.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { readOnlyWriteBlock } from '@/lib/read-only-access'

const VALID_KINDS = ['buzz', 'job', 'close', 'system'] as const
type NoteKind = (typeof VALID_KINDS)[number]

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
    .select('id, role, location_id, first_name, last_name, full_name')
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
  const kind = body.kind as string | undefined
  const text = body.text as string | undefined
  const bodyUserLabel = body.user_label as string | undefined
  const engagement_id = body.engagement_id as string | undefined

  // Validate
  if (!lead_id || typeof lead_id !== 'string') {
    return NextResponse.json({ error: 'lead_id_required' }, { status: 400 })
  }
  if (!kind || !VALID_KINDS.includes(kind as NoteKind)) {
    return NextResponse.json(
      { error: 'invalid_kind', allowed: VALID_KINDS },
      { status: 400 }
    )
  }
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return NextResponse.json({ error: 'text_required' }, { status: 400 })
  }

  // Load lead for scoping
  const { data: lead, error: leadError } = await supabaseService
    .from('leads')
    .select('id, location_uuid')
    .eq('id', lead_id)
    .single()

  if (leadError || !lead) {
    return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  }

  // Location scoping
  if (!isAdmin(hubUser.role)) {
    if (hubUser.location_id !== lead.location_uuid) {
      return NextResponse.json(
        { error: 'forbidden_wrong_location' },
        { status: 403 }
      )
    }
  }

  // ─── Read-only guard (868kawwmh) ──────────────────────────────
  const roBlock = await readOnlyWriteBlock(hubUser, lead.location_uuid)
  if (roBlock) return roBlock

  // Optional engagement anchor (kind='job' engagement notes) — must be a
  // real engagement belonging to THIS lead, or the note is rejected.
  if (engagement_id !== undefined) {
    if (typeof engagement_id !== 'string' || !engagement_id) {
      return NextResponse.json({ error: 'invalid_engagement_id' }, { status: 400 })
    }
    const { data: eng } = await supabaseService
      .from('engagements')
      .select('id, client_id')
      .eq('id', engagement_id)
      .maybeSingle()
    if (!eng || eng.client_id !== lead_id) {
      return NextResponse.json({ error: 'engagement_not_on_lead' }, { status: 400 })
    }
  }

  // Resolve user_label
  let userLabel: string
  if (kind === 'system') {
    userLabel = typeof bodyUserLabel === 'string' ? bodyUserLabel : 'System'
  } else {
    if (typeof bodyUserLabel === 'string' && bodyUserLabel.trim().length > 0) {
      userLabel = bodyUserLabel
    } else {
      const fullName =
        hubUser.full_name ||
        [hubUser.first_name, hubUser.last_name].filter(Boolean).join(' ').trim()
      userLabel = fullName || 'You'
    }
  }

  // Insert
  const { data: inserted, error: insertError } = await supabaseService
    .from('lead_notes')
    .insert({
      lead_id,
      location_uuid: lead.location_uuid,
      kind,
      text: text.trim(),
      user_id: kind === 'system' ? null : hubUser.id,
      user_label: userLabel,
      ...(engagement_id ? { engagement_id } : {}),
    })
    .select('*')
    .single()

  if (insertError) {
    return NextResponse.json(
      { error: 'insert_failed', detail: insertError.message },
      { status: 500 }
    )
  }

  return NextResponse.json({ note: inserted }, { status: 201 })
}
