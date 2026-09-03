// app/api/help/releases/items/[id]/route.ts
//
//   PATCH  /api/help/releases/items/<id> — group, headline, sentence.
//   DELETE /api/help/releases/items/<id> — remove the line (soft).
//
// Editors only. A PATCH stamps edited_at: the line is now in Kevin's words
// and may publish. Neither verb touches feedback_items — the entry the line
// came from stays exactly as it is (Fixed, replied, emailed), and removing
// the line never un-fixes anything. Lines on a published release are
// editable too (a typo fix after posting), but a removed line stays removed:
// the unique index on feedback_item_id covers deleted rows, so the entry
// cannot be re-seeded by a re-fix.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import {
  isHelpEditorRole, isMissingReleasesTable, normalizeReleaseItemInput, RELEASES_NOT_SET_UP,
} from '@/lib/help-releases'

export const runtime = 'nodejs'

async function requireEditor() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { res: NextResponse.json({ error: 'unauthorized' }, { status: 401 }), userId: null }
  const { data: me } = await supabase.from('hub_users').select('role').eq('id', user.id).single()
  if (!isHelpEditorRole(me?.role)) return { res: NextResponse.json({ error: 'forbidden' }, { status: 403 }), userId: null }
  return { res: null, userId: user.id }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { res, userId } = await requireEditor()
  if (res) return res
  const id = String(params?.id || '')
  if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }

  const { data: existing, error: exErr } = await supabaseService
    .from('help_release_items').select('*').eq('id', id).maybeSingle()
  if (exErr && isMissingReleasesTable(exErr)) return NextResponse.json({ error: RELEASES_NOT_SET_UP }, { status: 503 })
  if (!existing || existing.deleted_at) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const { input, problem } = normalizeReleaseItemInput({ ...existing, ...body })
  if (!input) return NextResponse.json({ error: problem }, { status: 400 })

  const stamp = new Date().toISOString()
  const { data: row, error } = await supabaseService
    .from('help_release_items')
    .update({ group: input.group, title: input.title, body: input.body, edited_at: stamp, updated_by: userId, updated_at: stamp })
    .eq('id', id).select('*').single()
  if (error || !row) {
    console.error('[help release items PATCH]', error)
    return NextResponse.json({ error: error?.message || 'update_failed' }, { status: 500 })
  }
  return NextResponse.json({ ...row, unedited: false })
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const { res, userId } = await requireEditor()
  if (res) return res
  const id = String(params?.id || '')
  if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

  const stamp = new Date().toISOString()
  const { data: row, error } = await supabaseService
    .from('help_release_items')
    .update({ deleted_at: stamp, updated_by: userId, updated_at: stamp })
    .eq('id', id).is('deleted_at', null).select('id, title, feedback_item_id, deleted_at').maybeSingle()
  if (error) {
    if (isMissingReleasesTable(error)) return NextResponse.json({ error: RELEASES_NOT_SET_UP }, { status: 503 })
    console.error('[help release items DELETE]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true, removed: row })
}
