// app/api/partners/[id]/timeline/route.ts
//
// GET /api/partners/:id/timeline — the partner's touchpoint history, shaped
// for the SHARED Timeline component (its buildTimelineItems reads
// { touchpoints, notes, … } with every key optional, so this payload rides
// the exact same merge as a lead's — no fork).
//
// Partner touchpoints are REAL rows since network_phase1.sql (touchpoints
// lead-XOR-partner). This is the read path that finally answers "when did
// I last talk to this person, and what came of it".
//
// Auth mirrors the other partner routes (lib/crm).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller, canReadLocation } from '@/lib/crm'

export const runtime = 'nodejs'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: partner, error: partnerErr } = await supabaseService
    .from('partners')
    .select('id, location_id')
    .eq('id', id)
    .maybeSingle()
  if (partnerErr || !partner) {
    return NextResponse.json({ error: 'partner_not_found' }, { status: 404 })
  }
  if (!canReadLocation(caller, partner.location_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Backed by idx_touchpoints_partner (partner_id, occurred_at DESC).
  const { data: touchpoints, error: tpErr } = await supabaseService
    .from('touchpoints')
    .select('id, kind, method, label, status, notes, occurred_at, user_id')
    .eq('partner_id', id)
    .order('occurred_at', { ascending: false })
    .limit(100)
  if (tpErr) {
    return NextResponse.json({ error: tpErr.message }, { status: 500 })
  }

  return NextResponse.json({ touchpoints: touchpoints ?? [] })
}
