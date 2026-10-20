// app/api/leads/[id]/transfer/route.ts
//
// POST /api/leads/:id/transfer — corp/admin only.
//
// The web door to a transfer. Everything about the move itself — which leads
// may move, what moves with them, who is told, the drip — lives in
// lib/lead-transfer.ts (transferLead), shared with the Slack accept button.
// This route does only what is specific to a browser request: prove who the
// signed-in user is, refuse anyone who is not corporate (the load-bearing
// gate; transferLead checks the role again), read the body, and send back the
// status + JSON transferLead returns, unchanged.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { isAdmin } from '@/lib/auth'
import { transferLead } from '@/lib/lead-transfer'

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

  // ─── Body ─────────────────────────────────────────────────────
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const destinationId = body?.destination_location_id
  if (!destinationId || typeof destinationId !== 'string') {
    return NextResponse.json({ error: 'destination_location_id required' }, { status: 400 })
  }

  const outcome = await transferLead({
    leadId: id,
    destinationLocationId: destinationId,
    reason: body?.reason,
    actor: { hubUserId: hubUser.id, role: hubUser.role },
    requestOrigin: req.nextUrl?.origin || null,
  })
  return NextResponse.json(outcome.body, { status: outcome.status })
}
