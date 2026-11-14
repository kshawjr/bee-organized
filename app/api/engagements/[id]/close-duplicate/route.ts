// app/api/engagements/[id]/close-duplicate/route.ts
//
// POST /api/engagements/:id/close-duplicate — the one tap behind the
// two-open-cards flag (components/hive/shared/twinCards.js). Closes an EMPTY
// card whose client has another open card that holds the work.
//
// The browser sends NOTHING but the id. Everything is decided here, from the
// database, at the moment of the request:
//   · the caller may write (lite_user and paused locations are refused, 403,
//     by the same guard every other card write uses);
//   · the card is open;
//   · the card has NO quote, NO job and NO invoice (any status) and nothing
//     invoiced — otherwise 409 card_has_work, whatever the button showed and
//     whoever forged the request;
//   · the client has another open card, at this location, that DOES have a
//     quote, job or invoice, and the two are a pair under the shared rule —
//     otherwise 409 no_other_card_with_work.
// Only then: Closed Lost, closed_reason 'duplicate_card', and a note that
// says where the work is. The update itself repeats "still open" in its
// filter, so two taps cannot write twice.
//
// What it does NOT do: touch the other card, move or merge any record, or
// call Jobber. The request in Jobber stays exactly as it is. Reopen (the ···
// menu) undoes it like any other Closed Lost.
//
// Auth mirrors the sibling engagement routes: logged-in hub_user;
// super_admin/admin any location, everyone else scoped to their own.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { writeSyncLog } from '@/lib/sync-log'
import { loadClientCardsForTwin } from '@/lib/engagement-twins'
import { findTwinCard, duplicateClosedLine, DUPLICATE_CARD_REASON } from '@/components/hive/shared/twinCards'

const WORK_TABLES = ['quotes', 'jobs', 'invoices'] as const

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

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

  const { data: engagement, error: engError } = await supabaseService
    .from('engagements')
    .select('id, client_id, location_uuid, stage, total_invoiced')
    .eq('id', id)
    .maybeSingle()
  if (engError || !engagement) {
    return NextResponse.json({ error: 'engagement_not_found' }, { status: 404 })
  }
  if (!isAdmin(hubUser.role) && hubUser.location_id !== engagement.location_uuid) {
    return NextResponse.json({ error: 'forbidden_wrong_location' }, { status: 403 })
  }

  // Read-only users close nothing.
  const roBlock = await readOnlyWriteBlock(hubUser, engagement.location_uuid)
  if (roBlock) return roBlock

  if (engagement.stage === 'Closed Won' || engagement.stage === 'Closed Lost') {
    return NextResponse.json({ error: 'already_closed', stage: engagement.stage }, { status: 409 })
  }

  // THE FLOOR. Asked directly of each table, for THIS card, separately from
  // the pair rule below — so no mistake in that rule can ever close a card
  // with a quote, a job or an invoice on it. A failed read refuses.
  if (Number(engagement.total_invoiced || 0) !== 0) {
    return NextResponse.json({ error: 'card_has_work', message: 'This card has money invoiced on it, so it is not a duplicate.' }, { status: 409 })
  }
  for (const table of WORK_TABLES) {
    const { data: rows, error } = await supabaseService.from(table).select('id').eq('engagement_id', id).limit(1)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if ((rows?.length ?? 0) > 0) {
      return NextResponse.json(
        { error: 'card_has_work', message: 'This card has a quote, job or invoice on it, so it is not a duplicate.' },
        { status: 409 },
      )
    }
  }

  // The pair, from the server's own read — never from the browser.
  let twin: ReturnType<typeof findTwinCard> = null
  try {
    twin = findTwinCard(await loadClientCardsForTwin(engagement.client_id), id)
  } catch (err: any) {
    return NextResponse.json({ error: String(err?.message || err) }, { status: 500 })
  }
  if (!twin || !twin.canCloseAsDuplicate) {
    return NextResponse.json(
      { error: 'no_other_card_with_work', message: 'There is no other open card for this client with a quote, job or invoice on it.' },
      { status: 409 },
    )
  }

  const nowIso = new Date().toISOString()
  const note = duplicateClosedLine(twin.otherWork, twin.other.created_at)
  const { data: updated, error: updateError } = await supabaseService
    .from('engagements')
    .update({
      stage: 'Closed Lost',
      closed_reason: DUPLICATE_CARD_REASON,
      closed_note: note,
      closed_at: nowIso,
      stage_entered_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', id)
    .not('stage', 'in', '("Closed Won","Closed Lost")')
    .select('id')
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })
  if ((updated?.length ?? 0) === 0) {
    return NextResponse.json({ error: 'already_closed' }, { status: 409 })
  }

  // Trail — the same two rows an ordinary close leaves (the PATCH route).
  // Both are bookkeeping: the close has committed, a failure here is logged
  // by the helpers and never undoes it.
  await supabaseService.from('touchpoints').insert({
    lead_id: engagement.client_id,
    location_uuid: engagement.location_uuid,
    engagement_id: id,
    kind: 'stage_change',
    label: `Stage: ${engagement.stage} → Closed Lost`,
    user_id: hubUser.id,
    occurred_at: nowIso,
  })
  const { data: clientLead } = await supabaseService
    .from('leads')
    .select('location_id')
    .eq('id', engagement.client_id)
    .maybeSingle()
  await writeSyncLog({
    location_id: clientLead?.location_id || 'unknown',
    entity_id: id,
    entity_type: 'engagement',
    status: 'success',
    message:
      `[engagement:close] Closed Lost reason=${DUPLICATE_CARD_REASON} — duplicate of open card ${twin.other.id} ` +
      `(which holds the ${twin.otherWork}) for client ${engagement.client_id}; nothing moved, nothing sent to Jobber`,
  })

  return NextResponse.json({
    id,
    stage: 'Closed Lost',
    prev_stage: engagement.stage,
    closed_reason: DUPLICATE_CARD_REASON,
    closed_note: note,
    closed_at: nowIso,
    other: twin.other,
  })
}
