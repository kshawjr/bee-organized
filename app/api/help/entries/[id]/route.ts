// app/api/help/entries/[id]/route.ts
//
//   PATCH  /api/help/entries/<id> — edit fields, publish/unpublish, restore.
//   DELETE /api/help/entries/<id> — soft delete (sets deleted_at).
//
// Editors only (super_admin / admin). A delete is never a DELETE: the row
// stays, stamped, and everything under it disappears with it in the tree
// build. PATCH { restore: true } clears the stamp — the recovery path.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import {
  isHelpEditorRole, isMissingHelpTable, normalizeEntryInput, HELP_NOT_SET_UP,
} from '@/lib/help-content'

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
    .from('help_entries').select('*').eq('id', id).maybeSingle()
  if (exErr && isMissingHelpTable(exErr)) return NextResponse.json({ error: HELP_NOT_SET_UP }, { status: 503 })
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // Restore is its own verb: nothing else changes.
  if (body.restore === true) {
    const { data: row, error } = await supabaseService
      .from('help_entries')
      .update({ deleted_at: null, updated_by: userId, updated_at: new Date().toISOString() })
      .eq('id', id).select('*').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(row)
  }

  // Everything else is the full row re-validated: the form sends the whole
  // thing, the same way it does on create. kind and parent are fixed.
  const merged = { ...existing, ...body, kind: existing.kind, parent_id: existing.parent_id }
  const { input, problem } = normalizeEntryInput(merged)
  if (!input) return NextResponse.json({ error: problem }, { status: 400 })

  const { data: row, error } = await supabaseService
    .from('help_entries')
    .update({
      title: input.title, icon: input.icon, tab_key: input.tab_key,
      lead: input.lead, media_kind: input.media_kind, media_path: input.media_path,
      steps: input.steps, callout: input.callout, status: input.status,
      updated_by: userId, updated_at: new Date().toISOString(),
    })
    .eq('id', id).select('*').single()

  if (error || !row) {
    console.error('[help entries PATCH]', error)
    return NextResponse.json({ error: error?.message || 'update_failed' }, { status: 500 })
  }
  return NextResponse.json(row)
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const { res, userId } = await requireEditor()
  if (res) return res
  const id = String(params?.id || '')
  if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })

  const { data: row, error } = await supabaseService
    .from('help_entries')
    .update({ deleted_at: new Date().toISOString(), updated_by: userId, updated_at: new Date().toISOString() })
    .eq('id', id).is('deleted_at', null).select('id, kind, title, deleted_at').maybeSingle()

  if (error) {
    if (isMissingHelpTable(error)) return NextResponse.json({ error: HELP_NOT_SET_UP }, { status: 503 })
    console.error('[help entries DELETE]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true, deleted: row })
}
