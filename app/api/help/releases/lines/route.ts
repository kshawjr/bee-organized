// app/api/help/releases/lines/route.ts
//
//   POST /api/help/releases/lines — add one line to this week's What's new
//   draft from OUTSIDE the app: a Claude Code session, after a push lands.
//
// AUTH IS A SHARED KEY, NOT A SESSION. `Authorization: Bearer <WAGGLE_WRITE_KEY>`,
// the same shape as the cron routes' CRON_SECRET. There is no browser here
// to carry a cookie, and the key is the elevated caller: it lives in Vercel
// and on Kevin's machine and nowhere else. Fail-closed — with the variable
// unset the route answers 500 and writes nothing, like the crons. The
// session route (POST /api/help/releases/items) is untouched and is still
// how the editor adds a line by hand.
//
// A LINE ADDED HERE IS AN ORDINARY LINE. It goes through the same
// getOrCreateDraft and the same input rules as a hand-written one, it is
// stamped edited_at (it arrives in owner language, so it is "written", not
// "their words"), and Kevin can edit or remove it exactly like any other.
// created_by is NULL — no hub_user wrote it — which is what the editor
// reads to show the "From a deploy" chip. Nothing here touches
// feedback_items, the seed path, publish, or Slack.
//
// THE WORDS ARE CHECKED. lib/waggle-line-rules refuses a hash, an issue
// number, a file name, a route, a function, a setting name, engineering
// vocabulary, or "various fixes" — the tells that a line was written for
// Kevin, not for an owner. The judgment of whether to write a line at all
// lives in CLAUDE.md, not in code.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseService } from '@/lib/supabase-service'
import {
  getOrCreateDraft, normalizeReleaseItemInput, isMissingReleasesTable, formatWeekLabel, RELEASES_NOT_SET_UP,
} from '@/lib/help-releases'
import { lintOwnerLine } from '@/lib/waggle-line-rules.mjs'

export const runtime = 'nodejs'

const WAGGLE_WRITE_KEY_ENV = 'WAGGLE_WRITE_KEY'

export async function POST(req: NextRequest) {
  const secret = process.env[WAGGLE_WRITE_KEY_ENV]
  if (!secret) {
    console.error(`[waggle lines] ${WAGGLE_WRITE_KEY_ENV} not set; refusing`)
    return NextResponse.json({ error: 'waggle_key_not_configured' }, { status: 500 })
  }
  const header = req.headers.get('authorization') || ''
  if (header !== `Bearer ${secret}`) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let raw: any
  try { raw = await req.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }
  // The script says headline/sentence; the table says title/body. Both spellings land.
  const candidate = {
    group: raw?.group,
    title: raw?.title ?? raw?.headline,
    body: raw?.body ?? raw?.sentence,
  }
  const problem = lintOwnerLine(candidate)
  if (problem) return NextResponse.json({ error: problem }, { status: 400 })
  const { input, problem: shapeProblem } = normalizeReleaseItemInput(candidate)
  if (!input) return NextResponse.json({ error: shapeProblem }, { status: 400 })

  const { draft, error: draftErr } = await getOrCreateDraft(supabaseService, null)
  if (!draft) {
    if (isMissingReleasesTable(draftErr)) return NextResponse.json({ error: RELEASES_NOT_SET_UP }, { status: 503 })
    console.error('[waggle lines] no draft:', draftErr)
    return NextResponse.json({ error: (draftErr as any)?.message || 'no_draft' }, { status: 500 })
  }

  const stamp = new Date().toISOString()
  const { data: row, error } = await supabaseService
    .from('help_release_items')
    .insert({ ...input, release_id: draft.id, edited_at: stamp, created_by: null, updated_by: null })
    .select('*').single()
  if (error || !row) {
    if (isMissingReleasesTable(error)) return NextResponse.json({ error: RELEASES_NOT_SET_UP }, { status: 503 })
    console.error('[waggle lines] insert failed:', error)
    return NextResponse.json({ error: error?.message || 'insert_failed' }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    line: { id: row.id, group: row.group, title: row.title, body: row.body },
    release: { id: draft.id, week_start: draft.week_start, publish_on: draft.publish_on, week_label: formatWeekLabel(draft.publish_on) },
  }, { status: 201 })
}
