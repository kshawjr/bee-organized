// app/api/help/releases/items/route.ts
//
//   POST /api/help/releases/items — add a line BY HAND to the open draft
//   (opening one if the week has none yet). For anything that shipped with
//   no report behind it.
//
// Editors only. A hand-written line is Kevin's words from the start, so
// edited_at is stamped on creation: it publishes and posts like any other
// edited line.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import {
  isHelpEditorRole, isMissingReleasesTable, normalizeReleaseItemInput, getOrCreateDraft, RELEASES_NOT_SET_UP,
} from '@/lib/help-releases'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: me } = await supabase.from('hub_users').select('role').eq('id', user.id).single()
  if (!isHelpEditorRole(me?.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }
  const { input, problem } = normalizeReleaseItemInput(body)
  if (!input) return NextResponse.json({ error: problem }, { status: 400 })

  const { draft, error: draftErr } = await getOrCreateDraft(supabaseService, user.id)
  if (!draft) {
    if (isMissingReleasesTable(draftErr)) return NextResponse.json({ error: RELEASES_NOT_SET_UP }, { status: 503 })
    console.error('[help release items POST] no draft:', draftErr)
    return NextResponse.json({ error: (draftErr as any)?.message || 'no_draft' }, { status: 500 })
  }

  const stamp = new Date().toISOString()
  const { data: row, error } = await supabaseService
    .from('help_release_items')
    .insert({ ...input, release_id: draft.id, edited_at: stamp, created_by: user.id, updated_by: user.id })
    .select('*').single()
  if (error || !row) {
    if (isMissingReleasesTable(error)) return NextResponse.json({ error: RELEASES_NOT_SET_UP }, { status: 503 })
    console.error('[help release items POST]', error)
    return NextResponse.json({ error: error?.message || 'insert_failed' }, { status: 500 })
  }
  return NextResponse.json({ ...row, unedited: false, release: draft }, { status: 201 })
}
