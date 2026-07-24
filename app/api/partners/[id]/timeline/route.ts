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
// CARRIED HISTORY (lead→Network conversion): a converted contact's calls were
// logged against the LEAD, and the touchpoints XOR CHECK
// (num_nonnulls(lead_id, partner_id) = 1) means no row can ever point at both
// subjects. The three ways to deal with that, and why this one:
//   · MOVE the rows (flip lead_id → partner_id) — destructive.
//     deriveClientStatus reads the lead's touchpoints to decide New vs
//     Attempting, so stripping them re-derives the lead as 'New' and puts it
//     back on Home's needs-attention hero. It also destroys the lead's audit
//     trail, including the conversion's own log line.
//   · COPY them — the same history under two ids, divergent from the first
//     edit onwards, and double-counted by anything that reads both.
//   · UNION AT READ TIME — chosen. The rows stay where they were written, the
//     XOR is untouched, no migration, nothing duplicated, and the partner
//     record shows the whole relationship. partners.customer_lead_id is the
//     link, so this costs one extra query and only when a link exists.
// Union rows carry from_lead:true — an extra key the shared Timeline ignores,
// so the payload stays self-describing without a component fork.
//
// Auth mirrors the other partner routes (lib/crm).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller, canReadLocation } from '@/lib/crm'

export const runtime = 'nodejs'

// Per-subject page ceiling. Applied to each side of the union AND to the
// merged result, so a linked record can't quietly double the payload.
const LIMIT = 100

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
    .select('id, location_id, customer_lead_id')
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
    .limit(LIMIT)
  if (tpErr) {
    return NextResponse.json({ error: tpErr.message }, { status: 500 })
  }

  // Linked client record → union its touchpoints in (see header). Backed by
  // idx_touchpoints_lead, the same index every lead-scoped reader uses.
  let carried: any[] = []
  if (partner.customer_lead_id) {
    const { data: leadTps, error: leadTpErr } = await supabaseService
      .from('touchpoints')
      .select('id, kind, method, label, status, notes, occurred_at, user_id')
      .eq('lead_id', partner.customer_lead_id)
      .order('occurred_at', { ascending: false })
      .limit(LIMIT)
    if (leadTpErr) {
      // Non-fatal: the partner's own history is still the answer to the
      // question. Log rather than 500 the whole record.
      console.error('[partners/timeline] carried lead touchpoints failed:', leadTpErr.message)
    } else {
      carried = (leadTps || []).map((t: any) => ({ ...t, from_lead: true }))
    }
  }

  // Merge newest-first and re-cap. Both sides are already sorted, but the
  // union is not, so sort the whole thing rather than concatenating two
  // separately-ordered runs.
  const merged = [...(touchpoints ?? []), ...carried].sort((a: any, b: any) =>
    String(b.occurred_at || '').localeCompare(String(a.occurred_at || ''))
  )

  return NextResponse.json({ touchpoints: merged.slice(0, LIMIT) })
}
