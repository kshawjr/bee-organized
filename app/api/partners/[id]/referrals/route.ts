// app/api/partners/[id]/referrals/route.ts
//
// GET /api/partners/:id/referrals — every lead this partner/contact sent,
// with what each one produced. THE reverse-referral lookup: until now the
// only "reverse" view was Classic's client-side array scan over whatever
// leads happened to be loaded (people.filter(p => p.referredBy === id)),
// which silently under-counts on any scoped load. This queries the real
// link (leads.referred_by_kind='partner' + referred_by_id) server-side —
// backed by idx_leads_referred_by (migrations/network_phase1.sql §4).
//
// Both partners AND contacts store as kind='partner' (the enum has no
// 'contact'), so this route serves both — no type filter.
//
// Revenue/converted are REAL joins (lib/referral-rollup), not the
// jsonb referrals[] fictions (revenue seeded 0, converted unmaintained).
//
// Cap mirrors clients/[id]/profile: page ceiling + count:'exact' so the
// caller can say "showing N of M" honestly past the ceiling.
//
// Auth mirrors the other partner routes (lib/crm): logged-in hub_user;
// elevated any location; everyone else scoped to the partner's location.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller, canReadLocation } from '@/lib/crm'
import { rollupReferredLeads, referralTotals } from '@/lib/referral-rollup'

export const runtime = 'nodejs'

const REFERRED_CAP = 200

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
    .select('id, location_id, name, type')
    .eq('id', id)
    .maybeSingle()
  if (partnerErr || !partner) {
    return NextResponse.json({ error: 'partner_not_found' }, { status: 404 })
  }
  if (!canReadLocation(caller, partner.location_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Junk exclusion via .not(is,true) — NULL stays (same as the profile
  // route's reverse fetch). Newest first; capped page + full count.
  const { data: leads, error: leadsErr, count } = await supabaseService
    .from('leads')
    .select('id, name, created_at', { count: 'exact' })
    .eq('referred_by_kind', 'partner')
    .eq('referred_by_id', id)
    .not('is_junk', 'is', true)
    .order('created_at', { ascending: false })
    .range(0, REFERRED_CAP - 1)
  if (leadsErr) {
    return NextResponse.json({ error: leadsErr.message }, { status: 500 })
  }

  const leadRows = leads ?? []
  let engagements: any[] = []
  if (leadRows.length > 0) {
    const { data: engs, error: engErr } = await supabaseService
      .from('engagements')
      .select('client_id, stage, total_paid')
      .in('client_id', leadRows.map((l) => l.id))
    if (engErr) {
      return NextResponse.json({ error: engErr.message }, { status: 500 })
    }
    engagements = engs ?? []
  }

  const referred = rollupReferredLeads(leadRows, engagements)

  return NextResponse.json({
    partner: { id: partner.id, name: partner.name, type: partner.type },
    referred,
    // totals cover the returned page; total is the TRUE full count so the
    // UI can flag "showing first N of M" when a referrer out-refers the cap.
    totals: referralTotals(referred),
    total: count ?? referred.length,
  })
}
