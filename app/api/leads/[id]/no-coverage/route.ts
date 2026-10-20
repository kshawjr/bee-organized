// app/api/leads/[id]/no-coverage/route.ts
//
// POST /api/leads/:id/no-coverage — corp/admin only. Body (optional):
//   { confirmed_out_of_range: true } — the person saw the nearest hive and its
//   miles (or that Bee Hub couldn't place the customer) and says they're out
//   of range. Never overrides a zip on a location's list.
// GET  /api/leads/:id/no-coverage — corp/admin only. The served-area verdict
//   (lib/no-coverage-guard) BEFORE anything is sent, so the Inbox modal can
//   show the block or the confirmation. Reads only. A blocked verdict carries
//   each claimant's location id so the modal can offer "Route there instead".
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
import { supabaseService } from '@/lib/supabase-service'
import { closeLeadAsNoCoverage } from '@/lib/lead-no-coverage'
import { checkNoCoverage, verdictWords } from '@/lib/no-coverage-guard'

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

  // An empty or unreadable body is "not confirmed", never an error — the
  // modal always sends JSON, and a missing confirmation can only refuse.
  let body: any = {}
  try {
    body = (await req.json()) ?? {}
  } catch {
    body = {}
  }

  const outcome = await closeLeadAsNoCoverage({
    leadId: id,
    actor: { hubUserId: hubUser.id, role: hubUser.role },
    requestOrigin: req.nextUrl?.origin || null,
    confirmedOutOfRange: body?.confirmed_out_of_range === true,
  })
  return NextResponse.json(outcome.body, { status: outcome.status })
}

export async function GET(
  _req: NextRequest,
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

  const { data: lead, error } = await supabaseService
    .from('leads')
    .select('id, zip, state')
    .eq('id', id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'lead_read_failed', detail: error.message }, { status: 500 })
  if (!lead) return NextResponse.json({ error: 'lead_not_found' }, { status: 404 })

  let verdict
  try {
    verdict = await checkNoCoverage({ id: lead.id, zip: lead.zip ?? null, state: lead.state ?? null })
  } catch (err: any) {
    return NextResponse.json({ error: 'coverage_check_failed', detail: String(err?.message || err) }, { status: 503 })
  }

  // "Route there instead" needs each claimant's location id.
  let claimants: { id: string | null; slug: string; name: string }[] = []
  if (verdict.kind === 'blocked' && verdict.claimants.length) {
    const { data: locs } = await supabaseService
      .from('locations')
      .select('id, location_id')
      .in('location_id', verdict.claimants.map((c) => c.slug))
    const idBySlug = new Map(((locs as any[]) || []).map((l) => [l.location_id, l.id]))
    claimants = verdict.claimants.map((c) => ({ ...c, id: idBySlug.get(c.slug) ?? null }))
  }

  return NextResponse.json({ verdict, words: verdictWords(verdict), ...(verdict.kind === 'blocked' ? { claimants } : {}) })
}
