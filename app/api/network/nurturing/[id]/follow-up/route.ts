// app/api/network/nurturing/[id]/follow-up/route.ts
//
// POST /api/network/nurturing/<lead id>/follow-up   { due_on: 'YYYY-MM-DD', note }
//
// A follow-up on a Nurturing person (slice 8) IS a reminder: the same
// reminders row, built by the same lib/reminders buildReminderInsert the
// shared /api/reminders uses, so it shows on the Reminders page and on Home
// like any other. There is no second reminder system. This route exists only
// to add the two Nurturing checks the shared route does not make:
//   · super admins only (lib/network/access.ts), and
//   · never for someone who said no to marketing (saidNoToMarketing), with no
//     way round it.
// It writes one reminders row and sends nothing.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { maySeeNewNetwork } from '@/lib/network/access'
import { buildReminderInsert, cleanNote, isValidYmd } from '@/lib/reminders'
import { REMINDER_COLS, withRecordNames } from '@/lib/reminders-server'
import { saidNoToMarketing } from '@/lib/network/nurturing-actions'

export const runtime = 'nodejs'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!maySeeNewNetwork(caller.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  const id = (await params)?.id || ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: 'not_a_person_id' }, { status: 400 })

  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }
  if (!isValidYmd(body?.due_on)) return NextResponse.json({ error: 'due_on_required' }, { status: 400 })
  const note = cleanNote(body?.note)
  if (!note) return NextResponse.json({ error: 'note_required' }, { status: 400 })

  const { data: lead, error } = await supabaseService.from('leads').select('id, location_uuid, marketing_opt_out, marketing_unsubscribed_at').eq('id', id).maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!lead) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (saidNoToMarketing(lead)) return NextResponse.json({ error: 'said_no_to_marketing' }, { status: 403 })

  const row = buildReminderInsert({ setterId: caller.userId, record: { key: 'lead_id', id }, locationUuid: lead.location_uuid, dueOn: body.due_on, note })
  const { data, error: insErr } = await supabaseService.from('reminders').insert(row).select(REMINDER_COLS).single()
  if (insErr || !data) return NextResponse.json({ error: 'insert_failed', detail: insErr?.message }, { status: 500 })
  const [named] = await withRecordNames([data])
  return NextResponse.json({ reminder: named || data }, { status: 201 })
}
