// app/api/help/entries/route.ts
//
//   GET  /api/help/entries — the whole Help tree for the caller.
//   POST /api/help/entries — add a section, topic or item (editors only).
//
// WHO SEES WHAT is decided HERE, not in the browser. An owner's GET never
// contains a draft item, and never an empty topic or section; an editor's
// GET (super_admin / admin — the corp tier) contains everything, drafts
// marked, plus the soft-deleted rows for the restore list. The plus buttons
// in the UI are a convenience on top of this, not the gate.
//
// Reads go through the service client after the role is read from the
// session, so the tree is one query regardless of RLS (which also exists,
// as a second lock — see migrations/help_entries.sql).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import {
  buildHelpTree, deletedRoots, isHelpEditorRole, isMissingHelpTable,
  normalizeEntryInput, HELP_NOT_SET_UP, type HelpRow,
} from '@/lib/help-content'

export const runtime = 'nodejs'

async function callerRole(): Promise<{ userId: string; role: string } | null> {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { data: me } = await supabase.from('hub_users').select('role').eq('id', user.id).single()
  return { userId: user.id, role: String(me?.role ?? '') }
}

export async function GET() {
  const caller = await callerRole()
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const canEdit = isHelpEditorRole(caller.role)

  const { data, error } = await supabaseService
    .from('help_entries')
    .select('*')
    .order('position', { ascending: true })

  if (error) {
    // Pre-migration: an empty Help tab, not a broken one.
    if (isMissingHelpTable(error)) return NextResponse.json({ sections: [], deleted: [], canEdit, notSetUp: true })
    console.error('[help entries GET]', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (data || []) as HelpRow[]
  const sections = buildHelpTree(rows, { includeDrafts: canEdit })
  const deleted = canEdit ? deletedRoots(rows).map(r => ({ id: r.id, kind: r.kind, title: r.title, deleted_at: r.deleted_at })) : []
  return NextResponse.json({ sections, deleted, canEdit })
}

export async function POST(req: NextRequest) {
  const caller = await callerRole()
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!isHelpEditorRole(caller.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }
  const { input, problem } = normalizeEntryInput(body)
  if (!input) return NextResponse.json({ error: problem }, { status: 400 })

  // The parent must exist and be the right kind: topics under sections,
  // items under topics. Nothing may be added under a deleted parent.
  if (input.parent_id) {
    const { data: parent, error: pErr } = await supabaseService
      .from('help_entries').select('id, kind, deleted_at').eq('id', input.parent_id).maybeSingle()
    if (pErr && isMissingHelpTable(pErr)) return NextResponse.json({ error: HELP_NOT_SET_UP }, { status: 503 })
    const want = input.kind === 'topic' ? 'section' : 'topic'
    if (!parent || parent.kind !== want || parent.deleted_at) {
      return NextResponse.json({ error: `A ${input.kind} must sit under a ${want}.` }, { status: 400 })
    }
  }

  // New rows go at the bottom of their level.
  let posQuery = supabaseService.from('help_entries').select('position').order('position', { ascending: false }).limit(1)
  posQuery = input.parent_id ? posQuery.eq('parent_id', input.parent_id) : posQuery.is('parent_id', null)
  const { data: last, error: lastErr } = await posQuery.maybeSingle()
  if (lastErr && isMissingHelpTable(lastErr)) return NextResponse.json({ error: HELP_NOT_SET_UP }, { status: 503 })
  const position = last ? Number(last.position) + 1 : 0

  const { data: row, error } = await supabaseService
    .from('help_entries')
    .insert({ ...input, position, created_by: caller.userId, updated_by: caller.userId })
    .select('*')
    .single()

  if (error || !row) {
    if (isMissingHelpTable(error)) return NextResponse.json({ error: HELP_NOT_SET_UP }, { status: 503 })
    console.error('[help entries POST]', error)
    return NextResponse.json({ error: error?.message || 'insert_failed' }, { status: 500 })
  }
  return NextResponse.json(row, { status: 201 })
}
