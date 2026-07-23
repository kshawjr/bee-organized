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

  // Leads referred BY ITS PEOPLE ride the same response (Phase 3): the
  // company view is "everything this org sends us", attributed. No
  // double-count is possible — a lead has exactly ONE referred_by
  // (kind + id), so direct-company rows and via-person rows are disjoint.
  const people = peopleRes.data ?? []
  const nameByPerson = new Map(people.map((p) => [p.id, p.name]))
  let viaRows: any[] = []
  if (people.length > 0) {
    const viaRes = await supabaseService
      .from('leads')
      .select('id, name, created_at, referred_by_id')
      .eq('referred_by_kind', 'partner')
      .in('referred_by_id', people.map((p) => p.id))
      .not('is_junk', 'is', true)
      .order('created_at', { ascending: false })
      .range(0, REFERRED_CAP - 1)
    if (viaRes.error) {
      return NextResponse.json({ error: viaRes.error.message }, { status: 500 })
    }
    viaRows = viaRes.data ?? []
  }

  const directRows = directRes.data ?? []
  const allLeadRows = [...directRows, ...viaRows]
  let engagements: any[] = []
  if (allLeadRows.length > 0) {
    const { data: engs, error: engErr } = await supabaseService
      .from('engagements')
      .select('client_id, stage, total_paid')
      .in('client_id', allLeadRows.map((l) => l.id))
    if (engErr) {
      return NextResponse.json({ error: engErr.message }, { status: 500 })
    }
    engagements = engs ?? []
  }

  // Per-person referral counts reduce from the SAME via fetch (PostgREST
  // aggregates are disabled on this instance).
  const referralCountByPerson: Record<string, number> = {}
  for (const row of viaRows) {
    if (!row.referred_by_id) continue
    referralCountByPerson[row.referred_by_id] =
      (referralCountByPerson[row.referred_by_id] || 0) + 1
  }

  // One rollup over the combined set; each row carries its attribution.
  const viaById = new Map(viaRows.map((l) => [l.id, l.referred_by_id]))
  const directIds = new Set(directRows.map((l) => l.id))
  const referred = rollupReferredLeads(allLeadRows, engagements)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .map((r) => ({
      ...r,
      via: directIds.has(r.id)
        ? { kind: 'company', id: company.id, name: company.name }
        : { kind: 'partner', id: viaById.get(r.id) ?? null, name: nameByPerson.get(viaById.get(r.id)) ?? null },
    }))

  return NextResponse.json({
    company: { id: company.id, name: company.name, industry: company.industry },
    referred,
    totals: referralTotals(referred),
    total: (directRes.count ?? directRows.length) + viaRows.length,
    people: people.map((p) => ({
      ...p,
      referral_count: referralCountByPerson[p.id] || 0,
    })),
  })
}
