// app/api/network/contacts/bulk/route.ts
//
//   POST   one bulk action on many contacts at ONE location (slice 6)
//
// WHO MAY CALL IT: super admins only, for now (lib/network/access.ts), the
// same rule as the rest of the new Network. Everyone else: 403, nothing read.
//
// Body: { location_id, ids: [...], action, value, confirmed: true }
//   action  tag_add | tag_remove | level | stage   (lib/network/bulk.ts)
//   value   a tag id, a level, or a stage
//   confirmed  must be true: the list asks ONCE for the whole selection.
//              Without it the answer is 428 and nothing is read or written.
//
// THE RULES: lib/network/bulk.ts planBulk. Every contact must be live and at
// the location named, or nothing is written. A level or stage goes on
// Referral partners only; anyone else is skipped and named. Only contacts
// that really change are written, in ONE statement (an update, an insert
// or a delete), with updated_at moved on the level/stage rows only.

import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'
import { supabaseService } from '@/lib/supabase-service'
import { loadCaller } from '@/lib/crm'
import { readOnlyWriteBlock } from '@/lib/read-only-access'
import { maySeeNewNetwork } from '@/lib/network/access'
import { networkWriteVerdict, READ_ONLY_ANSWER } from '@/lib/network/route-access'
import { checkBulkRequest, planBulk, type BulkLink, type BulkRow } from '@/lib/network/bulk'
import { networkTagsFor } from '@/lib/network/contact-create'
import { UUID_RE, readLocation, readLocationTags } from '@/lib/network/contact-reads'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const caller = await loadCaller(supabase)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!maySeeNewNetwork(caller.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  let body: any
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid_json_body' }, { status: 400 }) }
  const locationId = body?.location_id
  if (typeof locationId !== 'string' || !UUID_RE.test(locationId)) return NextResponse.json({ error: 'location_required' }, { status: 400 })
  const may = networkWriteVerdict(caller, locationId)
  if (may === 'not_found') return NextResponse.json({ error: 'location_not_found', changed: 0 }, { status: 404 })
  if (may === 'read_only') return NextResponse.json({ ...READ_ONLY_ANSWER, changed: 0 }, { status: 403 })
  const req = checkBulkRequest(body)
  if (!req.ok) return NextResponse.json({ error: req.error, changed: 0 }, { status: req.status })

  const loc = await readLocation(supabaseService, locationId)
  if (!loc.ok) return NextResponse.json({ error: loc.error }, { status: 500 })
  if (!loc.location) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })
  const blocked = await readOnlyWriteBlock({ role: caller.role }, locationId)
  if (blocked) return blocked

  const read = await supabaseService.from('partners').select('id, name, location_id, deleted_at, network_types, partner_level, partner_stage').in('id', req.ids)
  if (read.error) return NextResponse.json({ error: read.error.message }, { status: 500 })

  let links: BulkLink[] = []
  let allowedTagIds: string[] = []
  if (req.action === 'tag_add' || req.action === 'tag_remove') {
    const tags = await readLocationTags(supabaseService, locationId)
    if (!tags.ok) return NextResponse.json({ error: tags.error }, { status: 500 })
    allowedTagIds = networkTagsFor(tags.tags, locationId).map((t) => t.id)
    const l = await supabaseService.from('partner_tags').select('partner_id, tag_lookup_id').in('partner_id', req.ids).eq('tag_lookup_id', req.value)
    if (l.error) return NextResponse.json({ error: l.error.message }, { status: 500 })
    links = (l.data || []) as BulkLink[]
  }

  const plan = planBulk(req, { locationId, rows: (read.data || []) as BulkRow[], links, allowedTagIds })
  if (!plan.ok) return NextResponse.json({ error: plan.error, changed: 0 }, { status: plan.status })

  if (plan.changeIds.length) {
    let w: { error: any }
    if (plan.update) {
      w = await supabaseService.from('partners').update({ [plan.update.column]: plan.update.value, updated_at: new Date().toISOString() }).in('id', plan.changeIds)
    } else if (plan.action === 'tag_add') {
      w = await supabaseService.from('partner_tags').insert(plan.changeIds.map((partner_id) => ({ partner_id, tag_lookup_id: plan.tagId, added_by: caller.userId })))
    } else {
      w = await supabaseService.from('partner_tags').delete().eq('tag_lookup_id', plan.tagId).in('partner_id', plan.changeIds)
    }
    if (w.error) {
      console.error('[network bulk]', { action: plan.action, n: plan.changeIds.length, error: w.error })
      return NextResponse.json({ error: 'not_saved', changed: 0 }, { status: 500 })
    }
  }
  return NextResponse.json({ ok: true, action: plan.action, changed: plan.changeIds.length, changedIds: plan.changeIds, unchanged: plan.unchanged, skipped: plan.skipped })
}
