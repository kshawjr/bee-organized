// app/api/help/releases/[id]/slack/route.ts
//
//   GET /api/help/releases/<id>/slack?variant=n — the Slack post, as it
//   would be sent right now, plus which lines it leaves out and why.
//
// Editors only. The text comes from the SAME builder the publish route
// falls back to (lib/help-releases buildWaggleMessage) over the SAME rows,
// so the preview is what would be posted. "Different version" is
// ?variant=1, 2, … — it cycles the opener and closer; every fact stays.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import {
  isHelpEditorRole, isMissingReleasesTable, buildWaggleMessage, RELEASES_NOT_SET_UP,
  WAGGLE_CHANNEL, WAGGLE_VARIANTS, type ReleaseRow, type ReleaseItemRow,
} from '@/lib/help-releases'

export const runtime = 'nodejs'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { data: me } = await supabase.from('hub_users').select('role').eq('id', user.id).single()
  if (!isHelpEditorRole(me?.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const id = String(params?.id || '')
  if (!id) return NextResponse.json({ error: 'id_required' }, { status: 400 })
  let variant = 0
  try { variant = Number(new URL(req.url).searchParams.get('variant') || 0) || 0 } catch { variant = 0 }

  const { data: release, error: relErr } = await supabaseService
    .from('help_releases').select('*').eq('id', id).maybeSingle()
  if (relErr && isMissingReleasesTable(relErr)) return NextResponse.json({ error: RELEASES_NOT_SET_UP }, { status: 503 })
  if (!release) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const { data: itemRows, error: itemErr } = await supabaseService
    .from('help_release_items').select('*').eq('release_id', id).is('deleted_at', null)
  if (itemErr) return NextResponse.json({ error: itemErr.message }, { status: 500 })

  const built = buildWaggleMessage(release as ReleaseRow, (itemRows || []) as ReleaseItemRow[], { variant })
  return NextResponse.json({
    text: built.text,
    included: built.included,
    left_out: built.leftOut,
    variant: built.variant,
    variants: WAGGLE_VARIANTS,
    channel: WAGGLE_CHANNEL,
  })
}
