// app/api/leads/[id]/no-coverage/route.ts
//
// POST /api/leads/:id/no-coverage — corp/admin only.
//
// The web door to the no-coverage close. Everything it does — the token, the
// email, dismissed-on-send, the touchpoint, and the write order that keeps a
// failed send from hiding a lead — lives in lib/lead-no-coverage.ts
// (closeLeadAsNoCoverage), shared with the Slack "Not in our service area"
// button. This route proves who the signed-in user is, refuses anyone not
// corporate (closeLeadAsNoCoverage checks the role again), and sends back its
// status + JSON unchanged.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { isAdmin } from '@/lib/auth'
import { closeLeadAsNoCoverage } from '@/lib/lead-no-coverage'

export const runtime = 'nodejs'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  // ─── Auth: the load-bearing gate ──────────────────────────────
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
  if (!isAdmin(hubUser.role)) {
    return NextResponse.json({ error: 'forbidden_admin_only' }, { status: 403 })
  }

  const outcome = await closeLeadAsNoCoverage({
    leadId: id,
    actor: { hubUserId: hubUser.id, role: hubUser.role },
    requestOrigin: req.nextUrl?.origin || null,
  })
  return NextResponse.json(outcome.body, { status: outcome.status })
}
