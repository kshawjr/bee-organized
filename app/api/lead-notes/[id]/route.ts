// app/api/lead-notes/[id]/route.ts
//
// DELETE /api/lead-notes/:id — delete a lead note.
//
// Auth: only the note's author OR an admin can delete.
// System notes (kind='system') are NOT deletable — they're the audit trail.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isAdmin } from '@/lib/auth'

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

  const isAuthor = note.user_id === hubUser.id
  const inLocation = hubUser.location_id === note.location_uuid

  if (!isAdmin(hubUser.role)) {
    if (!isAuthor) {
      return NextResponse.json({ error: 'forbidden_not_author' }, { status: 403 })
    }
    if (!inLocation) {
      return NextResponse.json(
        { error: 'forbidden_wrong_location' },
        { status: 403 }
      )
    }
  }

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