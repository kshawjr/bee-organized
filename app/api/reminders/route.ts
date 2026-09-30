// app/api/reminders/route.ts
//
// GET  /api/reminders            — MY open reminders, soonest first, each with
//                                  the name of the record it is about.
// GET  /api/reminders?lead_id=…  — my open reminders on that one record
//      (or engagement_id= / partner_id=). What the record card shows.
// POST /api/reminders            — set one: { lead_id | engagement_id |
//                                  partner_id, due_on: 'YYYY-MM-DD', note }
//
// OWNERSHIP: every row belongs to the signed-in person who set it
// (buildReminderInsert in lib/reminders). GET only ever returns the caller's
// own rows — "Reminders" means MY reminders, on Home, on the page, and on the
// card. Nobody sees anyone else's.
//
// ACCESS: you may set a reminder on any record you can SEE (elevated, or the
// record is in your location). A reminder changes nothing about the record,
// so read-only seats (lite_user) and paused locations may set them too.
//
// NOTHING IS SENT. No email, no Slack, no push. A reminder appears on Home on
// its day and turns amber when missed; that is the whole of it.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller, canReadLocation } from '@/lib/crm'
import { REMINDER_COLS, loadRecordLocation, withRecordNames } from '@/lib/reminders-server'
import {
  RECORD_KEYS,
  pickRecord,
  cleanNote,
  isValidYmd,
  sortReminders,
  buildReminderInsert,
} from '@/lib/reminders'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  let query = supabaseService
    .from('reminders')
    .select(REMINDER_COLS)
    .eq('user_id', caller.userId)
    .is('done_at', null)

  for (const k of RECORD_KEYS) {
    const v = url.searchParams.get(k)
    if (v) query = query.eq(k, v)
  }

  const { data, error } = await query.order('due_on', { ascending: true })
  if (error) return NextResponse.json({ error: 'load_failed', detail: error.message }, { status: 500 })

  const rows = sortReminders(((data as any[]) || []).filter(r => r.user_id === caller.userId))
  return NextResponse.json({ reminders: await withRecordNames(rows) })
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }

  const record = pickRecord(body)
  if (!record) return NextResponse.json({ error: 'one_record_required', allowed: RECORD_KEYS }, { status: 400 })
  if (!isValidYmd(body.due_on)) return NextResponse.json({ error: 'due_on_required' }, { status: 400 })
  const note = cleanNote(body.note)
  if (!note) return NextResponse.json({ error: 'note_required' }, { status: 400 })

  const locationUuid = await loadRecordLocation(record)
  if (!locationUuid) return NextResponse.json({ error: 'record_not_found' }, { status: 404 })
  if (!canReadLocation(caller, locationUuid)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const row = buildReminderInsert({
    setterId: caller.userId,
    record,
    locationUuid,
    dueOn: body.due_on as string,
    note,
  })

  const { data, error } = await supabaseService.from('reminders').insert(row).select(REMINDER_COLS).single()
  if (error || !data) return NextResponse.json({ error: 'insert_failed', detail: error?.message }, { status: 500 })

  const [named] = await withRecordNames([data])
  return NextResponse.json({ reminder: named || data }, { status: 201 })
}
