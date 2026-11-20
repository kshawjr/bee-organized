// app/api/network/nurturing/bulk/route.ts
//
// POST /api/network/nurturing/bulk — add a tag to, or take a tag off, many
// Nurturing people at one location (Network & Nurture, slice 8). Also used
// for ONE person from the person view (a selection of one id).
//
// Body:
//   { location_id, action: 'tag_add'|'tag_remove', tag_id,
//     selection: { ids: [...] } | { all: true, q?, needs_contact? },
//     dry_run?: true,                      // count only, write nothing
//     confirmed?: true, expected?: number } // the write
//
// TWO STEPS, ONE CONFIRMATION. The screen first asks with dry_run and shows
// the answer's exact number in its one question ("Add “Garage” to 18,816
// people?"). Only the yes sends confirmed + expected. The server works the
// selection out again from scratch and refuses (409, nothing written) if
// the number is no longer the one the person said yes to. A cancel sends
// nothing at all.
//
// LEFT OUT, ALWAYS: anyone who said no to marketing (lib/network/
// nurturing-actions.ts saidNoToMarketing). Nothing in the body can change
// that. Also left out: anyone already as asked, and anyone no longer
// Nurturing here.
//
// ALL OR NOTHING: runBulkTag takes back what it wrote if a chunk fails.
//
// Super admins only (lib/network/access.ts). Writes lead_tags and nothing
// else; it sends no email (nothing that sends is imported here).

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { maySeeNewNetwork } from '@/lib/network/access'
import { searchNurture } from '@/lib/network/nurturing'
import { loadNurturingList, loadNurtureTags, nurtureLocation } from '@/lib/network/nurturing-read'
import { bulkTagFailureWords, bulkTagLeftOut, bulkTagQuestion, isBulkTagAction, planBulkTag, runBulkTag, type LinkRow } from '@/lib/network/nurturing-actions'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!maySeeNewNetwork(caller.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuid.test(String(body?.location_id || ''))) return NextResponse.json({ error: 'location_id must be one location id' }, { status: 400 })
  if (!isBulkTagAction(body?.action)) return NextResponse.json({ error: 'action must be tag_add or tag_remove' }, { status: 400 })
  if (!uuid.test(String(body?.tag_id || ''))) return NextResponse.json({ error: 'tag_id required' }, { status: 400 })
  const sel = body?.selection
  const byIds = Array.isArray(sel?.ids)
  if (!byIds && sel?.all !== true) return NextResponse.json({ error: 'selection required' }, { status: 400 })
  if (byIds && (!sel.ids.length || sel.ids.some((x: unknown) => typeof x !== 'string' || !uuid.test(x)))) return NextResponse.json({ error: 'selection.ids must be person ids' }, { status: 400 })
  const dryRun = body?.dry_run === true
  if (!dryRun && body?.confirmed !== true) return NextResponse.json({ error: 'not_confirmed' }, { status: 400 })

  try {
    const loc = await nurtureLocation(supabaseService, body.location_id)
    if (!loc) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
    const [list, tags] = await Promise.all([loadNurturingList(supabaseService, loc, { useCache: false }), loadNurtureTags(supabaseService, loc.id)])
    if (list.excluded) return NextResponse.json({ error: 'location_left_out' }, { status: 400 })
    const tag = tags.find((t: { id: string }) => t.id === body.tag_id)
    if (!tag) return NextResponse.json({ error: 'tag_not_offered_here' }, { status: 400 })

    // Who the selection names, worked out again here, never trusted from the screen.
    let targets = list.rows
    let notNurturing = 0
    if (byIds) {
      const want = new Set<string>(sel.ids)
      targets = list.rows.filter((r) => want.has(r.id))
      notNurturing = want.size - targets.length
    } else {
      if (sel.needs_contact === true) targets = targets.filter((r) => r.needsContactInfo)
      targets = searchNurture(targets, String(sel.q || '').slice(0, 200))
    }

    // Who already has the tag: every link this tag has (25 lead_tags rows in all, 2026-11-20).
    const before: LinkRow[] = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabaseService.from('lead_tags').select('lead_id, tag_lookup_id, added_at, added_by').eq('tag_lookup_id', tag.id).order('lead_id').range(from, from + 999)
      if (error) throw new Error(`lead_tags: ${error.message}`)
      before.push(...(data || []))
      if ((data || []).length < 1000) break
    }
    const haveTag = new Set(before.map((r) => r.lead_id))
    const plan = planBulkTag({ action: body.action, targets, haveTag, notNurturing })
    const answer = {
      question: bulkTagQuestion(body.action, tag.label, plan.change.length),
      leftOut: bulkTagLeftOut(body.action, plan),
      selected: plan.selected, change: plan.change.length, noMarketing: plan.noMarketing.length,
      already: plan.already.length, notNurturing: plan.notNurturing,
      names: list.rows.filter((r) => plan.change.slice(0, 5).includes(r.id)).map((r) => r.name),
      tag: { id: tag.id, label: tag.label },
    }
    if (dryRun) return NextResponse.json({ dry_run: true, ...answer })

    if (body.expected !== plan.change.length) {
      return NextResponse.json({ error: 'count_changed', ...answer, said_yes_to: body.expected ?? null }, { status: 409 })
    }
    if (!plan.change.length) return NextResponse.json({ ok: true, changed: 0, ...answer })

    const changing = new Set(plan.change)
    const outcome = await runBulkTag(supabaseService, {
      action: body.action, tagId: tag.id, ids: plan.change, by: caller.userId,
      before: before.filter((r) => changing.has(r.lead_id)),
    })
    if (!outcome.ok) {
      console.error('[network nurturing bulk] did not finish', { action: body.action, tag: tag.id, ...outcome, leftChanged: outcome.leftChanged.length })
      return NextResponse.json({ ...outcome, words: bulkTagFailureWords(body.action, tag.label, outcome) }, { status: 500 })
    }
    return NextResponse.json({ ...answer, ok: true, changed: outcome.changed })
  } catch (err: any) {
    console.error('[network nurturing bulk] failed before writing', err)
    return NextResponse.json({ error: err?.message || 'read_failed', state: 'nothing_changed' }, { status: 500 })
  }
}
