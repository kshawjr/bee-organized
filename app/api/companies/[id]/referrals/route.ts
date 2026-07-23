// app/api/companies/[id]/referrals/route.ts
//
// GET /api/companies/:id/referrals — the company-side reverse-referral view:
//   · referred — leads attributed DIRECTLY to the company
//     (referred_by_kind='company', legal after network_phase1.sql §3 widens
//     the kind CHECK; returns [] cleanly before any such rows exist)
//   · people   — the company's live partners/contacts (company_id link),
//     each carrying its own direct referral count so the company view can
//     show "Karen sent 4, Tony sent 2" without N more requests
//
// Company rollup = the DIRECT rows only. People's referrals stay attributed
// to the person (their counts ride along here); summing both into one
// number would double-count the moment a lead is attributed at both levels.
//
// Same rollup, cap, and auth shape as /api/partners/[id]/referrals.

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

  const { data: company, error: companyErr } = await supabaseService
    .from('companies')
    .select('id, location_id, name, industry')
    .eq('id', id)
    .maybeSingle()
  if (companyErr || !company) {
    return NextResponse.json({ error: 'company_not_found' }, { status: 404 })
  }
  if (!canReadLocation(caller, company.location_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const [directRes, peopleRes] = await Promise.all([
    supabaseService
      .from('leads')
      .select('id, name, created_at', { count: 'exact' })
      .eq('referred_by_kind', 'company')
      .eq('referred_by_id', id)
      .not('is_junk', 'is', true)
      .order('created_at', { ascending: false })
      .range(0, REFERRED_CAP - 1),
    supabaseService
      .from('partners')
      .select('id, name, type, title, stage, tier')
      .eq('company_id', id)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
  ])
  if (directRes.error) {
    return NextResponse.json({ error: directRes.error.message }, { status: 500 })
  }
  if (peopleRes.error) {
    return NextResponse.json({ error: peopleRes.error.message }, { status: 500 })
  }

  const leadRows = directRes.data ?? []
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

  // Per-person direct referral counts — one grouped fetch, reduced in JS
  // (PostgREST aggregates are disabled on this instance).
  const people = peopleRes.data ?? []
  const referralCountByPerson: Record<string, number> = {}
  if (people.length > 0) {
    const { data: personLeads } = await supabaseService
      .from('leads')
      .select('referred_by_id')
      .eq('referred_by_kind', 'partner')
      .in('referred_by_id', people.map((p) => p.id))
      .not('is_junk', 'is', true)
    for (const row of personLeads ?? []) {
      if (!row.referred_by_id) continue
      referralCountByPerson[row.referred_by_id] =
        (referralCountByPerson[row.referred_by_id] || 0) + 1
    }
  }

  const referred = rollupReferredLeads(leadRows, engagements)

  return NextResponse.json({
    company: { id: company.id, name: company.name, industry: company.industry },
    referred,
    totals: referralTotals(referred),
    total: directRes.count ?? referred.length,
    people: people.map((p) => ({
      ...p,
      referral_count: referralCountByPerson[p.id] || 0,
    })),
  })
}
