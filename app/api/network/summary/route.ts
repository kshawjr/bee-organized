// app/api/network/summary/route.ts
//
// GET /api/network/summary?location_id=<uuid>  (elevated may omit → tenant-wide)
//
// The Network screen's ONE bulk rollup: per-referrer referral counts,
// conversions, and revenue for every partner/contact/company in scope —
// the list-shaped twin of /api/partners/[id]/referrals. Without this the
// screen would need one /referrals round trip PER ROW (N+1); with it the
// whole list costs two-ish queries. Same lib/referral-rollup math, so the
// list numbers and the record numbers can never disagree.
//
// Response:
//   { referrers: [{ kind:'partner'|'company', id, count, converted, revenue }],
//     totals: { count, converted, revenue } }
//
// Numbers are REAL (leads.referred_by_* → engagements.total_paid/stage) —
// never the jsonb referrals[] fictions. Leads with no engagements still
// count as referred (count) with revenue 0 — that's the honest number.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller, canReadLocation, isElevated } from '@/lib/crm'
import { rollupReferredLeads } from '@/lib/referral-rollup'

export const runtime = 'nodejs'

// Referred-lead universe ceiling. CRM-scale (3 referred leads in prod
// today); the cap guards the query shape, and the response flags overflow
// honestly rather than silently truncating.
const LEAD_CAP = 5000
const CHUNK = 200

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const locationId = request.nextUrl.searchParams.get('location_id')
  if (locationId) {
    if (!canReadLocation(caller, locationId)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
  } else if (!isElevated(caller.role)) {
    // Tenant-wide ('all locations') is an elevated view only.
    return NextResponse.json({ error: 'location_id required' }, { status: 400 })
  }

  // Every referred lead in scope — partner AND company referrers ride one
  // fetch. Junk exclusion via .not(is,true) (NULL stays, as everywhere).
  let leadsQ = supabaseService
    .from('leads')
    .select('id, name, created_at, referred_by_kind, referred_by_id')
    .in('referred_by_kind', ['partner', 'company'])
    .not('referred_by_id', 'is', null)
    .not('is_junk', 'is', true)
    .range(0, LEAD_CAP - 1)
  if (locationId) leadsQ = leadsQ.eq('location_uuid', locationId)

  const { data: leads, error: leadsErr } = await leadsQ
  if (leadsErr) {
    return NextResponse.json({ error: leadsErr.message }, { status: 500 })
  }
  const leadRows = leads ?? []

  // Engagements for the referred leads — chunked .in() (the bounded-URL
  // rule from the hub child-rows pass).
  const engagements: any[] = []
  for (let i = 0; i < leadRows.length; i += CHUNK) {
    const ids = leadRows.slice(i, i + CHUNK).map((l) => l.id)
    const { data: engs, error: engErr } = await supabaseService
      .from('engagements')
      .select('client_id, stage, total_paid')
      .in('client_id', ids)
    if (engErr) {
      return NextResponse.json({ error: engErr.message }, { status: 500 })
    }
    engagements.push(...(engs ?? []))
  }

  const rolled = rollupReferredLeads(leadRows, engagements)
  const rollupByLead = new Map(rolled.map((r) => [r.id, r]))

  // Group per referrer.
  const byReferrer = new Map<string, { kind: string; id: string; count: number; converted: number; revenue: number }>()
  for (const lead of leadRows) {
    const key = `${lead.referred_by_kind}:${lead.referred_by_id}`
    let agg = byReferrer.get(key)
    if (!agg) {
      agg = { kind: lead.referred_by_kind, id: lead.referred_by_id, count: 0, converted: 0, revenue: 0 }
      byReferrer.set(key, agg)
    }
    const r = rollupByLead.get(lead.id)
    agg.count += 1
    if (r?.converted) agg.converted += 1
    agg.revenue += r?.revenue ?? 0
  }

  const referrers = Array.from(byReferrer.values())
  return NextResponse.json({
    referrers,
    totals: {
      count: leadRows.length,
      converted: referrers.reduce((s, r) => s + r.converted, 0),
      revenue: referrers.reduce((s, r) => s + r.revenue, 0),
    },
    truncated: leadRows.length >= LEAD_CAP,
  })
}
