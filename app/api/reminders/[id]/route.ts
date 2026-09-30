// app/api/reminders/[id]/route.ts
//
// PATCH  /api/reminders/:id — { due_on?, note?, done?: true }
//                             pencil = new date (or note); tick = done.
// DELETE /api/reminders/:id — X. Gone for good.
//
// Only the person who set a reminder can change, finish or delete it. Anyone
// else gets a 404, not a 403 — someone else's reminder simply doesn't exist
// from where you stand. The owner (user_id) and the record a reminder is about
// are never changeable here.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { REMINDER_COLS, withRecordNames } from '@/lib/reminders-server'
import { cleanNote, isValidYmd } from '@/lib/reminders'

export const runtime = 'nodejs'

async function loadOwn(id: string, userId: string) {
  const { data } = await supabaseService.from('reminders').select('id, user_id').eq('id', id).maybeSingle()
  if (!data || (data as any).user_id !== userId) return null
  return data
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }

  const patch: Record<string, unknown> = {}
  if (body.due_on !== undefined) {
    if (!isValidYmd(body.due_on)) return NextResponse.json({ error: 'invalid_due_on' }, { status: 400 })
    patch.due_on = body.due_on
  }
  if (body.note !== undefined) {
    const note = cleanNote(body.note)
    if (!note) return NextResponse.json({ error: 'note_required' }, { status: 400 })
    patch.note = note
  }
  if (body.done === true) patch.done_at = new Date().toISOString()
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'nothing_to_change' }, { status: 400 })
  patch.updated_at = new Date().toISOString()

  if (!(await loadOwn(id, caller.userId))) return NextResponse.json({ error: 'reminder_not_found' }, { status: 404 })

  const { data, error } = await supabaseService
    .from('reminders')
    .update(patch)
    .eq('id', id)
    .eq('user_id', caller.userId)
    .select(REMINDER_COLS)
    .single()
  if (error || !data) return NextResponse.json({ error: 'update_failed', detail: error?.message }, { status: 500 })

  const [named] = await withRecordNames([data])
  return NextResponse.json({ reminder: named || data })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  if (!(await loadOwn(id, caller.userId))) return NextResponse.json({ error: 'reminder_not_found' }, { status: 404 })

  const { error } = await supabaseService.from('reminders').delete().eq('id', id).eq('user_id', caller.userId)
  if (error) return NextResponse.json({ error: 'delete_failed', detail: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
