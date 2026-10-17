// app/api/leads/[id]/assessment-type/route.ts
//
// GET /api/leads/:id/assessment-type — the Send to Jobber screen's starting
// in-person/virtual choice, read when the screen opens.
//
//   client_type      — the type on this client's most recent assessment that
//                      has one recorded (assessments.assessment_type; NULL on
//                      everything made in Jobber or sent before it existed)
//   location_default — the lead's location's locations.default_assessment_type
//   resolved         — client_type, else location_default, else 'in-person'
//
// Read-only. Same scoping as GET /api/leads/:id: elevated roles see any lead,
// everyone else only their own location's. Either column missing (migration
// not run yet) reads as null, so this answers 'in-person' rather than failing.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { isAssessmentType, resolveAssessmentType } from '@/lib/assessment-type'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()
  if (!hubUser) return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })

  const { data: lead } = await supabaseService
    .from('leads')
    .select('id, location_uuid')
    .eq('id', id)
    .maybeSingle()
  if (!lead) return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })
  if (!isAdmin(hubUser.role) && hubUser.location_id !== lead.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  const [{ data: aRows }, { data: locRow }] = await Promise.all([
    supabaseService
      .from('assessments')
      .select('assessment_type')
      .eq('lead_id', id)
      .not('assessment_type', 'is', null)
      .order('scheduled_at', { ascending: false, nullsFirst: false })
      .limit(1),
    lead.location_uuid
      ? supabaseService
          .from('locations')
          .select('default_assessment_type')
          .eq('id', lead.location_uuid)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const clientRaw = (aRows as any[] | null)?.[0]?.assessment_type
  const locRaw = (locRow as any)?.default_assessment_type
  const client_type = isAssessmentType(clientRaw) ? clientRaw : null
  const location_default = isAssessmentType(locRaw) ? locRaw : null

  return NextResponse.json({
    client_type,
    location_default,
    resolved: resolveAssessmentType(client_type, location_default),
  })
}
