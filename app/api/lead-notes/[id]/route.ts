// app/api/lead-notes/[id]/route.ts
//
// PATCH  /api/lead-notes/:id — edit a lead note's text.
// DELETE /api/lead-notes/:id — delete a lead note.
//
// Auth: only the note's author OR an admin can edit or delete.
// System notes (kind='system') are NOT editable or deletable — audit trail.
//
// ONE RULE, TWO VERBS. PATCH's authorisation is a transcription of DELETE's,
// not a second opinion: same 401, same no_hub_user_profile, same 404, same
// system-note refusal, same read-only guard, same author-or-admin test with
// the same error strings. They are checked in the same order so a caller
// cannot learn from one verb something the other would not tell them. If one
// changes, change both — beta-lead-note-edit-delete pins that they agree.
//
// TEXT ONLY. `kind` is deliberately not editable: buzz and job notes render
// in different places on the card, so a note changing kind is not an edit,
// it is a move to another surface — and it would vanish out from under the
// person reading it.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { noteEditAuthError, isMissingEditedAtColumn } from '@/lib/lead-note-edit'

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()

  if (!hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }

  const { data: note, error: loadError } = await supabaseService
    .from('lead_notes')
    .select('id, lead_id, location_uuid, kind, user_id')
    .eq('id', id)
    .single()

  if (loadError || !note) {
    return NextResponse.json({ error: 'note_not_found' }, { status: 404 })
  }

  if (note.kind === 'system') {
    return NextResponse.json(
      { error: 'system_notes_cannot_be_edited' },
      { status: 403 }
    )
  }

  // Read-only guard, as DELETE has it: a lite_user or a paused/inactive
  // location cannot edit even their own note. past_due keeps full access.
  const roBlock = await readOnlyWriteBlock(hubUser, note.location_uuid)
  if (roBlock) return roBlock

  // The shared author-or-admin test — the SAME one DELETE applies below.
  const authError = noteEditAuthError(note, hubUser)
  if (authError) return NextResponse.json({ error: authError }, { status: 403 })

  // Body: text only. Anything else in the body is ignored rather than
  // rejected, so a future field cannot silently become editable by being
  // passed — it has to be added here on purpose.
  const body = await req.json().catch(() => null)
  const text = typeof body?.text === 'string' ? body.text.trim() : null
  if (!text) {
    return NextResponse.json({ error: 'text_required' }, { status: 400 })
  }

  const nowIso = new Date().toISOString()

  // edited_at may not exist yet (migrations/lead_notes_edited_at.sql is
  // applied by hand). Try the full write, and if the column is what the
  // database objects to, write the text alone and carry on: editing works
  // either way, and edited notes start saying so the moment the column
  // lands. Same shape as lib/lead-address.ts's former_addresses fallback.
  let updated: any = null
  let writeErr: any = null
  {
    const { data, error } = await supabaseService
      .from('lead_notes')
      .update({ text, edited_at: nowIso })
      .eq('id', id)
      .select('*')
      .single()
    updated = data
    writeErr = error
  }
  if (writeErr && isMissingEditedAtColumn(writeErr)) {
    console.warn('[lead-notes] edited_at column absent — saving text only; run migrations/lead_notes_edited_at.sql')
    const { data, error } = await supabaseService
      .from('lead_notes')
      .update({ text })
      .eq('id', id)
      .select('*')
      .single()
    updated = data
    writeErr = error
  }

  if (writeErr) {
    return NextResponse.json(
      { error: 'update_failed', detail: writeErr.message },
      { status: 500 }
    )
  }

  return NextResponse.json({ note: updated }, { status: 200 })
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { data: hubUser } = await supabase
    .from('hub_users')
    .select('id, role, location_id')
    .eq('id', user.id)
    .single()

  if (!hubUser) {
    return NextResponse.json({ error: 'no_hub_user_profile' }, { status: 403 })
  }

  const { data: note, error: loadError } = await supabaseService
    .from('lead_notes')
    .select('id, lead_id, location_uuid, kind, user_id')
    .eq('id', id)
    .single()

  if (loadError || !note) {
    return NextResponse.json({ error: 'note_not_found' }, { status: 404 })
  }

  if (note.kind === 'system') {
    return NextResponse.json(
      { error: 'system_notes_cannot_be_deleted' },
      { status: 403 }
    )
  }

  // ─── Read-only guard (868kawwmh) ──────────────────────────────
  // A read-only user (lite_user, or paused/inactive location) can't
  // delete even a note they authored. past_due keeps full access.
  const roBlock = await readOnlyWriteBlock(hubUser, note.location_uuid)
  if (roBlock) return roBlock

  // The shared author-or-admin test — the SAME one PATCH applies above.
  // Lifted into lib/lead-note-edit so the two verbs cannot drift apart; the
  // behaviour and the error strings are unchanged from before the lift.
  const authError = noteEditAuthError(note, hubUser)
  if (authError) return NextResponse.json({ error: authError }, { status: 403 })

  const { error: deleteError } = await supabaseService
    .from('lead_notes')
    .delete()
    .eq('id', id)

  if (deleteError) {
    return NextResponse.json(
      { error: 'delete_failed', detail: deleteError.message },
      { status: 500 }
    )
  }

  return NextResponse.json({ deleted: true, id }, { status: 200 })
}