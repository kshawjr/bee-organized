// app/api/help/entries/[id]/move/route.ts
//
//   POST /api/help/entries/<id>/move  { direction: 'up' | 'down' }
//
// Reorder, the simple way: one tap moves a row one place among its siblings.
// No drag-and-drop (unreliable under a thumb, and needs a library), no typed
// position numbers (a form field for a thing you can see). Editors only.
// The swap rewrites BOTH rows' positions, and renumbers the level 0..n-1 so
// any two rows that once shared a position come apart.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { isHelpEditorRole, isMissingHelpTable, moveSibling, HELP_NOT_SET_UP, type HelpRow } from '@/lib/help-content'

export const runtime = 'nodejs'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: me } = await supabase.from('hub_users').select('role').eq('id', user.id).single()
  if (!isHelpEditorRole(me?.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const id = String(params?.id || '')
  let body: { direction?: string } = {}
  try { body = await req.json() } catch { /* fall through to the check */ }
  const direction = body.direction === 'up' ? 'up' : body.direction === 'down' ? 'down' : null
  if (!id || !direction) return NextResponse.json({ error: 'direction must be up or down' }, { status: 400 })

  const { data: row, error: rowErr } = await supabaseService
    .from('help_entries').select('id, parent_id').eq('id', id).maybeSingle()
  if (rowErr && isMissingHelpTable(rowErr)) return NextResponse.json({ error: HELP_NOT_SET_UP }, { status: 503 })
  if (!row) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // Siblings = same parent, not deleted (a deleted neighbour is not a place
  // you can move to).
  let q = supabaseService.from('help_entries').select('id, position, kind, parent_id, title, status').is('deleted_at', null)
  q = row.parent_id ? q.eq('parent_id', row.parent_id) : q.is('parent_id', null)
  const { data: siblings, error: sibErr } = await q
  if (sibErr) return NextResponse.json({ error: sibErr.message }, { status: 500 })

  const writes = moveSibling((siblings || []) as HelpRow[], id, direction)
  if (!writes) return NextResponse.json({ ok: true, moved: false })

  for (const w of writes) {
    const { error } = await supabaseService.from('help_entries').update({ position: w.position }).eq('id', w.id)
    if (error) {
      console.error('[help entries move]', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
  }
  return NextResponse.json({ ok: true, moved: true, positions: writes })
}
