// app/api/leads/[id]/close-not-interested/route.ts
//
// POST /api/leads/:id/close-not-interested — issue 204.
//
// The lead-side (System A) half of "Close — not interested". Closing a lead
// who never converted is TWO acts against two disconnected stage systems
// (see the two-stage-systems note): the caller founds + closes a Closed Lost
// engagement through the normal engagement-close path (System B — the Inbox,
// board, badge, home, admin metrics all read engagements, never leads.stage),
// and THIS route stops the lead's live drips + scheduled stage-emails
// (System A — driven off leads.stage). Engagement close deliberately never
// touches leads.stage, so without this a no-engagement lead keeps getting
// drip and stage emails after being closed.
//
// It MIRRORS the markJunk drip-stop exactly — the same three cancels the
// PATCH /api/leads/:id is_junk branch fires (applyDripSideEffects) — but with
// reason 'closed_lost' and WITHOUT setting is_junk: she was a real lead who
// didn't convert, not junk, and must not land in the Recycle Bin bucket.
//
// TWO LANDMINES (scout 203) this route sidesteps by calling the drip
// helpers DIRECTLY rather than moving leads.stage:
//   · leads.stage's DB CHECK allows 'Won'/'Lost', NOT 'Closed Won'/'Closed
//     Lost' — writing the classic 'Closed Lost' would fail the constraint.
//   · DRIP_STOP_STAGES (drip-lifecycle.ts) is keyed on 'Closed Won'/'Closed
//     Lost', so even a CHECK-legal leads.stage='Lost' would NOT match and
//     would NOT stop drips. The only reliable stop is invoking
//     stopActiveDripsForLead / cancelStageEmails / cancelPendingWelcomeEmail
//     directly, which is what markJunk's is_junk branch does too.
//
// Auth: logged-in hub_user. Scope: super_admin/admin any lead; owner/lite_user
// their own location. Read-only (lite_user / paused location) → 403 before any
// write. Fire-and-forget: each helper swallows its own errors and never throws.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { stopActiveDripsForLead } from '@/lib/drip-lifecycle'
import { cancelStageEmails } from '@/lib/stage-emails'
import { cancelPendingWelcomeEmail } from '@/lib/welcome-email'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // ─── Auth ──────────────────────────────────────────────────────
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

  // ─── Load lead for scoping ────────────────────────────────────
  const { data: existing, error: loadError } = await supabaseService
    .from('leads')
    .select('id, location_uuid')
    .eq('id', id)
    .single()
  if (loadError || !existing) {
    return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  }

  // ─── Location scoping ─────────────────────────────────────────
  if (!isAdmin(hubUser.role) && hubUser.location_id !== existing.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  // ─── Read-only guard (868kawwmh) ──────────────────────────────
  const roBlock = await readOnlyWriteBlock(hubUser, existing.location_uuid)
  if (roBlock) return roBlock

  // ─── Stop drips + stage emails (mirror markJunk, reason closed_lost) ──
  // Same three cancels the is_junk branch fires; each is fail-closed and
  // swallows its own errors, so this awaits without a try/catch guard of
  // its own. is_junk is NOT touched — this is a Closed Lost, not a junk.
  await Promise.all([
    stopActiveDripsForLead(id, 'closed_lost'),
    cancelStageEmails({ leadId: id, reason: 'closed_lost' }),
    cancelPendingWelcomeEmail(id, 'closed_lost'),
  ])

  return NextResponse.json({ ok: true }, { status: 200 })
}
