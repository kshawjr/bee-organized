// app/api/help/releases/[id]/route.ts
//
//   PATCH /api/help/releases/<id>
//     { summary }                                  — edit the week's one line
//     { publish: true, post_slack, slack_text? }   — publish (and post)
//
// Editors only (super_admin / admin).
//
// PUBLISH NEVER REFUSES. Lines still in the owner's words (edited_at NULL)
// are not published and not posted — they are CARRIED FORWARD to the next
// week's draft, which this route opens if it has to, so nothing Kevin
// hasn't looked at is lost or shown. The response says how many moved.
//
// PUBLISH FIRST, POST SECOND. The release is marked published and the
// carry-forward is done BEFORE the Slack call, and the Slack outcome is
// recorded on the row (slack_posted_at or slack_error) and returned. A
// Slack failure therefore never loses the published release; the editor
// sees "published to Help, the post didn't go" and has the text to hand.
//
// THE WORDS THAT GO TO SLACK are the editor's textarea (slack_text) —
// what they previewed and possibly edited — or, when none is sent, the
// same builder the preview route uses (lib/help-releases buildWaggleMessage),
// so what is posted is byte-for-byte what was shown.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import {
  isHelpEditorRole, isMissingReleasesTable, normalizeSummary, buildWaggleMessage,
  nextWeekAfter, isUnedited, RELEASES_NOT_SET_UP,
  type ReleaseRow, type ReleaseItemRow,
} from '@/lib/help-releases'
import { postWaggleMessage, wagglePostProblem } from '@/lib/slack-waggle'

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

  const { data: release, error: relErr } = await supabaseService
    .from('help_releases').select('*').eq('id', id).maybeSingle()
  if (relErr && isMissingReleasesTable(relErr)) return NextResponse.json({ error: RELEASES_NOT_SET_UP }, { status: 503 })
  if (!release) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const rel = release as ReleaseRow
  const stamp = new Date().toISOString()

  // ── the summary line ──
  if (body.publish !== true) {
    if (!('summary' in body)) return NextResponse.json({ error: 'no_fields_to_update' }, { status: 400 })
    const { data: row, error } = await supabaseService
      .from('help_releases')
      .update({ summary: normalizeSummary(body.summary), updated_by: userId, updated_at: stamp })
      .eq('id', id).select('*').single()
    if (error || !row) return NextResponse.json({ error: error?.message || 'update_failed' }, { status: 500 })
    return NextResponse.json(row)
  }

  // ── publish ──
  if (rel.status === 'published') return NextResponse.json({ error: 'already_published' }, { status: 409 })

  const { data: itemRows, error: itemErr } = await supabaseService
    .from('help_release_items').select('*').eq('release_id', id).is('deleted_at', null)
  if (itemErr) return NextResponse.json({ error: itemErr.message }, { status: 500 })
  const items = (itemRows || []) as ReleaseItemRow[]

  const postSlack = body.post_slack !== false
  const text = typeof body.slack_text === 'string' && body.slack_text.trim()
    ? body.slack_text.trim()
    : buildWaggleMessage(rel, items, { variant: Number(body.variant) || 0 }).text

  // 1. Mark it published.
  const { data: published, error: pubErr } = await supabaseService
    .from('help_releases')
    .update({ status: 'published', published_at: stamp, slack_text: postSlack ? text : null, updated_by: userId, updated_at: stamp })
    .eq('id', id).select('*').single()
  if (pubErr || !published) return NextResponse.json({ error: pubErr?.message || 'publish_failed' }, { status: 500 })

  // 2. Carry the unedited lines forward to the next draft.
  const carry = items.filter(isUnedited)
  let carriedTo: { week_start: string; publish_on: string } | null = null
  let carryProblem: string | null = null
  if (carry.length) {
    const week = nextWeekAfter(rel.publish_on)
    const { data: next, error: nextErr } = await supabaseService
      .from('help_releases')
      .insert({ ...week, status: 'draft', created_by: userId, updated_by: userId })
      .select('*').single()
    if (next) {
      const { error: mvErr } = await supabaseService
        .from('help_release_items')
        .update({ release_id: (next as ReleaseRow).id, updated_by: userId, updated_at: stamp })
        .in('id', carry.map(c => c.id))
      if (mvErr) carryProblem = mvErr.message
      else carriedTo = week
    } else {
      carryProblem = nextErr?.message || 'next_draft_failed'
    }
    if (carryProblem) console.error('[help releases publish] carry-forward failed:', carryProblem)
  }

  // 3. Post — the one step allowed to fail without undoing anything.
  let slack: { posted: boolean; problem: string | null; skipped: boolean } = { posted: false, problem: null, skipped: true }
  if (postSlack) {
    const result = await postWaggleMessage(text)
    slack = { posted: result.ok, problem: wagglePostProblem(result), skipped: false }
    await supabaseService
      .from('help_releases')
      .update(result.ok ? { slack_posted_at: new Date().toISOString(), slack_error: null } : { slack_error: slack.problem })
      .eq('id', id)
  }

  return NextResponse.json({
    release: published,
    published_count: items.length - carry.length,
    left_out: carry.length,
    carried_to: carriedTo,
    carry_problem: carryProblem,
    slack,
    slack_text: postSlack ? text : null,
  })
}
