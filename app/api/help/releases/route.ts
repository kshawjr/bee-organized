// app/api/help/releases/route.ts
//
//   GET /api/help/releases — every published release, newest first, plus
//   (editors only) the open draft with its reference material.
//
// WHO SEES WHAT is decided HERE, not in the browser. An owner's payload
// never contains the draft, never a deleted line, and never a line still in
// the owner's words (edited_at NULL). An editor's payload carries the draft
// with every undeleted line flagged, and for each seeded line the original
// report (title, type, description, our reply) as reference. RLS exists as
// a second lock — see migrations/help_releases.sql.

import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import {
  isHelpEditorRole, isMissingReleasesTable, shapeRelease,
  type ReleaseRow, type ReleaseItemRow, type ReleaseItemSource,
} from '@/lib/help-releases'

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

  const { data: relRows, error: relErr } = await supabaseService
    .from('help_releases').select('*').order('published_at', { ascending: false })
  if (relErr) {
    if (isMissingReleasesTable(relErr)) return NextResponse.json({ releases: [], draft: null, canEdit, notSetUp: true })
    console.error('[help releases GET]', relErr)
    return NextResponse.json({ error: relErr.message }, { status: 500 })
  }
  const releases = (relRows || []) as ReleaseRow[]

  const { data: itemRows, error: itemErr } = await supabaseService
    .from('help_release_items').select('*').order('created_at', { ascending: true })
  if (itemErr) {
    if (isMissingReleasesTable(itemErr)) return NextResponse.json({ releases: [], draft: null, canEdit, notSetUp: true })
    console.error('[help releases GET items]', itemErr)
    return NextResponse.json({ error: itemErr.message }, { status: 500 })
  }
  const items = (itemRows || []) as ReleaseItemRow[]

  const published = releases
    .filter(r => r.status === 'published')
    .sort((a, b) => String(b.published_at ?? '').localeCompare(String(a.published_at ?? '')) || String(b.publish_on).localeCompare(String(a.publish_on)))
    .map(r => shapeRelease(r, items, { forOwner: !canEdit }))

  if (!canEdit) return NextResponse.json({ releases: published, draft: null, canEdit })

  // The draft, with the original report beside every seeded line. Read
  // through the service client and shaped here: this block only ever lands
  // in an EDITOR's payload.
  const draftRow = releases.find(r => r.status === 'draft') || null
  let draft = null
  if (draftRow) {
    const ids = items.filter(i => i.release_id === draftRow.id && !i.deleted_at && i.feedback_item_id).map(i => i.feedback_item_id as string)
    const sources = new Map<string, ReleaseItemSource>()
    if (ids.length) {
      const { data: fb } = await supabaseService
        .from('feedback_items').select('id, title, type, description, admin_response').in('id', ids)
      for (const f of (fb || []) as any[]) {
        sources.set(f.id, {
          title: String(f.title ?? ''), type: f.type ?? null,
          description: f.description ? String(f.description).slice(0, 400) : null,
          admin_response: f.admin_response ? String(f.admin_response) : null,
        })
      }
    }
    draft = shapeRelease(draftRow, items, { forOwner: false, sources })
  }
  return NextResponse.json({ releases: published, draft, canEdit })
}
