// app/api/tags/review/route.ts
//
// POST /api/tags/review — corporate's review of a LOCATION'S OWN tag
// (Kevin, 2026-11-15). Corporate only. Four outcomes in all; promoting a tag
// to the main list is the existing "Make corporate" (/api/tags/make-corporate).
// The other three are here:
//
//   { id, action: 'keep_local' }
//       Marks the tag "reviewed, keep local" in its settings box
//       (attrs.review). Nothing else changes.
//
//   { id, action: 'merge', into, dryRun? }
//       Everyone who carries the tag gets `into` instead (an active tag on the
//       main list, or another of the same location's); then the tag is
//       deleted.
//
//   { id, action: 'delete', dryRun? }
//       Takes the tag off everyone who carries it; then the tag is deleted.
//
// merge and delete take a tag off real people, so each is TWO STEPS:
// `dryRun: true` answers with exactly how many clients and Network contacts
// are affected and changes nothing; only the second call does it.
//
// The delete itself is the database's own (delete_tag_if_unused,
// migrations/tag_delete.sql), which copies the whole tag into tag_deletions
// first. This route then adds, to that same audit row, who carried the tag
// and what was done, so a wrong merge or delete can be put right by hand.
// If the database's rule refuses the delete (an undo log still names the
// tag), the tag is switched off instead and its settings box says what it
// was merged into; nobody carries it by then either way.
//
// No schema change: one settings-box key (attrs.review / attrs.merged_into)
// and the tables that already exist.

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, getHubUser, isAdmin } from '@/lib/auth'
import { supabaseService } from '@/lib/supabase-service'
import { isTagCategory, TAG_REVIEW_ACTIONS, describeTagBlockers } from '@/lib/tags'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TAG_COLS = 'id, category, label, icon, location_id, is_active, attrs'

async function carriers(tagId: string) {
  const [l, p] = await Promise.all([
    supabaseService.from('lead_tags').select('lead_id, added_at, added_by').eq('tag_lookup_id', tagId),
    supabaseService.from('partner_tags').select('partner_id, added_at, added_by').eq('tag_lookup_id', tagId),
  ])
  if (l.error) throw new Error(l.error.message)
  if (p.error) throw new Error(p.error.message)
  return { clients: (l.data || []) as any[], network: (p.data || []) as any[] }
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth()
    const hubUser = await getHubUser()
    if (!hubUser || !isAdmin(hubUser.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

    const body = await req.json().catch(() => ({}))
    const id = typeof body?.id === 'string' ? body.id : ''
    const action = body?.action
    const dryRun = body?.dryRun === true
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'id_required' }, { status: 400 })
    if (!(TAG_REVIEW_ACTIONS as readonly string[]).includes(action)) return NextResponse.json({ error: 'invalid_action', allowed: TAG_REVIEW_ACTIONS }, { status: 400 })

    const { data: tag } = await supabaseService.from('lookups').select(TAG_COLS).eq('id', id).maybeSingle()
    if (!tag || !isTagCategory((tag as any).category)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
    // Review is for a location's own tag. The main list is managed on Configure.
    if (!(tag as any).location_id) return NextResponse.json({ error: 'not_a_location_tag' }, { status: 400 })
    const t = tag as any

    // ── reviewed, keep local ──
    if (action === 'keep_local') {
      const attrs = { ...(t.attrs || {}), review: { decision: 'keep_local', at: new Date().toISOString(), by: hubUser.id } }
      const { error } = await supabaseService.from('lookups').update({ attrs, updated_at: new Date().toISOString() }).eq('id', id)
      if (error) return NextResponse.json({ error: 'update_failed', detail: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, action, receipt: `“${t.label}” is marked reviewed, and stays with its location.` })
    }

    // ── merge / delete ──
    let target: any = null
    if (action === 'merge') {
      const into = typeof body?.into === 'string' ? body.into : ''
      if (!UUID_RE.test(into) || into === id) return NextResponse.json({ error: 'into_required' }, { status: 400 })
      const found = await supabaseService.from('lookups').select(TAG_COLS).eq('id', into).maybeSingle()
      target = found.data
      if (!target || !isTagCategory(target.category) || target.is_active === false) return NextResponse.json({ error: 'into_not_found' }, { status: 404 })
      // The main list, or the same location's own. Never another location's.
      if (target.location_id && target.location_id !== t.location_id) return NextResponse.json({ error: 'into_wrong_location' }, { status: 400 })
    }

    const who = await carriers(id)
    let already = { clients: 0, network: 0 }
    if (target) {
      const has = await carriers(target.id)
      const lc = new Set(has.clients.map((r) => r.lead_id)); const pc = new Set(has.network.map((r) => r.partner_id))
      already = { clients: who.clients.filter((r) => lc.has(r.lead_id)).length, network: who.network.filter((r) => pc.has(r.partner_id)).length }
    }
    const plan = {
      action, tag: { id: t.id, label: t.label }, into: target ? { id: target.id, label: target.label } : null,
      clients: who.clients.length, network: who.network.length, alreadyHave: already,
    }
    if (dryRun) return NextResponse.json({ dryRun: true, plan })

    // 1. merge only: give everyone the target (a person who already has it keeps their own link)
    if (target) {
      if (who.clients.length) {
        const { error } = await supabaseService.from('lead_tags').upsert(
          who.clients.map((r) => ({ lead_id: r.lead_id, tag_lookup_id: target.id, added_at: r.added_at, added_by: r.added_by })),
          { onConflict: 'lead_id,tag_lookup_id', ignoreDuplicates: true })
        if (error) return NextResponse.json({ error: 'merge_failed', detail: error.message, changed: 'nothing' }, { status: 500 })
      }
      if (who.network.length) {
        const { error } = await supabaseService.from('partner_tags').upsert(
          who.network.map((r) => ({ partner_id: r.partner_id, tag_lookup_id: target.id, added_at: r.added_at, added_by: r.added_by })),
          { onConflict: 'partner_id,tag_lookup_id', ignoreDuplicates: true })
        if (error) return NextResponse.json({ error: 'merge_failed', detail: error.message }, { status: 500 })
      }
    }
    // 2. take the tag off everyone
    const offClients = await supabaseService.from('lead_tags').delete().eq('tag_lookup_id', id)
    if (offClients.error) return NextResponse.json({ error: 'unlink_failed', detail: offClients.error.message }, { status: 500 })
    const offNetwork = await supabaseService.from('partner_tags').delete().eq('tag_lookup_id', id)
    if (offNetwork.error) return NextResponse.json({ error: 'unlink_failed', detail: offNetwork.error.message }, { status: 500 })

    // 3. delete the tag, the database's own way (it keeps a whole copy)
    const { data: blockers, error: delError } = await supabaseService.rpc('delete_tag_if_unused', { p_id: id, p_by: hubUser.id })
    if (delError) return NextResponse.json({ error: 'delete_failed', detail: delError.message }, { status: 500 })
    const b: string[] = Array.isArray(blockers) ? blockers : []
    const record = { action, into: target ? { id: target.id, label: target.label } : null, by: hubUser.id, at: new Date().toISOString(), clients: who.clients, network: who.network }
    let deleted = b.length === 0
    if (deleted) {
      // Add who carried it to the audit row the database just wrote.
      const { data: audit } = await supabaseService.from('tag_deletions').select('id, tag_row').eq('tag_id', id).order('deleted_at', { ascending: false }).limit(1).maybeSingle()
      if (audit) await supabaseService.from('tag_deletions').update({ tag_row: { ...((audit as any).tag_row || {}), _review: record } }).eq('id', (audit as any).id)
    } else {
      // The delete rule refused (an undo log names this tag). Nobody carries
      // it now; switch it off and leave the record on the tag itself.
      const attrs = { ...(t.attrs || {}), ...(target ? { merged_into: target.id } : {}), review: { decision: action, at: record.at, by: hubUser.id }, _review: record }
      const { error } = await supabaseService.from('lookups').update({ is_active: false, attrs, updated_at: record.at }).eq('id', id)
      if (error) return NextResponse.json({ error: 'switch_off_failed', detail: error.message }, { status: 500 })
    }

    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
    const people = `${n(who.clients.length, 'client', 'clients')} and ${n(who.network.length, 'Network contact', 'Network contacts')}`
    const end = deleted ? `“${t.label}” is deleted.` : `“${t.label}” is switched off rather than deleted (${describeTagBlockers(b) || 'an undo record still names it'}).`
    const receipt = target
      ? `${people} now carry “${target.label}” in place of “${t.label}”. ${end}`
      : `“${t.label}” was taken off ${people}. ${end}`
    return NextResponse.json({ ok: true, action, deleted, plan, receipt })
  } catch (err: any) {
    console.error('[/api/tags/review POST] error:', err?.message || err)
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 })
  }
}
