// app/api/companies/[id]/touchpoints/route.ts
//
// GET /api/companies/:id/touchpoints — the company's relationship history
// ROLLED UP across everyone there: touchpoints for every live partner at
// the company, each row carrying partner_id + partner_name so the record
// can say WHO each conversation was with. This is why the history
// survives someone leaving — the rows belong to the people, the roll-up
// belongs to the org.
//
// Companies deliberately have no touchpoint subject of their own
// (Phase 1 scope): "talking to a company" is always talking to someone
// at it.

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

  const { data: company, error: companyErr } = await supabaseService
    .from('companies')
    .select('id, location_id')
    .eq('id', id)
    .maybeSingle()
  if (companyErr || !company) {
    return NextResponse.json({ error: 'company_not_found' }, { status: 404 })
  }
  if (!canReadLocation(caller, company.location_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Live people at the company (company_id is the FK source of truth).
  const { data: people, error: peopleErr } = await supabaseService
    .from('partners')
    .select('id, name')
    .eq('company_id', id)
    .is('deleted_at', null)
  if (peopleErr) {
    return NextResponse.json({ error: peopleErr.message }, { status: 500 })
  }
  const nameById = new Map((people ?? []).map((p) => [p.id, p.name]))
  if (nameById.size === 0) {
    return NextResponse.json({ touchpoints: [] })
  }

  const { data: touchpoints, error: tpErr } = await supabaseService
    .from('touchpoints')
    .select('id, partner_id, kind, method, label, status, notes, occurred_at')
    .in('partner_id', Array.from(nameById.keys()))
    .order('occurred_at', { ascending: false })
    .limit(100)
  if (tpErr) {
    return NextResponse.json({ error: tpErr.message }, { status: 500 })
  }

  return NextResponse.json({
    touchpoints: (touchpoints ?? []).map((t) => ({
      ...t,
      partner_name: nameById.get(t.partner_id) ?? null,
    })),
  })
}
