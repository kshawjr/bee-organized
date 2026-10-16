// lib/tag-guard.ts
// ─────────────────────────────────────────────────────────────
// Server side of location tags (2026-10-16): who may create / rename /
// switch off a location's own tag, the near-match check against what
// already exists (lib/tags.ts nearTagVerdict), and the request filed when a
// location creates its own copy of a tag corporate retired.
// Server-only (service role).
// ─────────────────────────────────────────────────────────────
import { supabaseService } from '@/lib/supabase-service'
import { TAG_CATEGORIES, isTagCategory, nearTagVerdict, type NearTagCandidate, type NearTagVerdict } from '@/lib/tags'

// The roles that may create and manage their OWN location's tags. Read-only
// staff (lite_user) apply nothing and create nothing; corporate uses the
// Configure tab.
export const LOCATION_TAG_ROLES = new Set(['owner', 'manager'])

// Corporate tags (any state) + this location's own (any state).
export async function loadTagCandidates(locationId: string | null): Promise<NearTagCandidate[]> {
  let q = supabaseService
    .from('lookups')
    // attrs carries the stored code (attrs.key) the near-match also checks.
    .select('id, label, icon, location_id, is_active, attrs')
    .in('category', TAG_CATEGORIES)
  q = locationId ? q.or(`location_id.is.null,location_id.eq.${locationId}`) : q.is('location_id', null)
  const { data, error } = await q
  if (error) throw new Error(`tag lookup read failed: ${error.message}`)
  return (data || []) as NearTagCandidate[]
}

export async function checkNearTag(label: string, locationId: string | null, ignoreId: string | null = null): Promise<NearTagVerdict> {
  return nearTagVerdict(label, await loadTagCandidates(locationId), ignoreId)
}

// The 409 a blocked create/rename answers with: what to use (or restore)
// instead, so the picker can offer it in one tap.
export function nearMatchBody(v: NearTagVerdict) {
  if (v.kind !== 'use' && v.kind !== 'restore') return null
  return {
    error: 'near_match',
    verdict: v.kind,
    tag: { id: v.tag.id, label: v.tag.label, icon: v.tag.icon ?? null, location_id: v.tag.location_id ?? null, is_active: v.tag.is_active !== false },
  }
}

// A location made its own copy of a tag corporate switched off — tell
// corporate, through the feedback queue they already triage. Best effort:
// the tag is created either way.
export async function fileRetiredTagRequest(args: {
  userId: string
  locationId: string
  retiredLabel: string
  newLabel: string
}) {
  try {
    const { data: loc } = await supabaseService.from('locations').select('name').eq('id', args.locationId).maybeSingle()
    const where = (loc as any)?.name || 'A location'
    const { error } = await supabaseService.from('feedback_items').insert({
      user_id: args.userId,
      location_id: args.locationId,
      type: 'feature',
      title: `Tag request: bring back "${args.retiredLabel}"`.slice(0, 100),
      description: `${where} needed the corporate tag "${args.retiredLabel}", which is switched off, and created their own "${args.newLabel}" instead. Switching "${args.retiredLabel}" back on (and making their copy corporate) would keep the tag list in one piece.`,
      status: 'submitted',
      attachments: [],
    })
    if (error) console.error('[tag-guard] retired-tag request not filed:', error.message)
  } catch (e: any) {
    console.error('[tag-guard] retired-tag request not filed:', e?.message || e)
  }
}

// May this caller rename / switch off this lookup row as a LOCATION user?
export function canManageLocationTag(hubUser: { role?: string | null; location_id?: string | null }, row: { category?: string | null; location_id?: string | null }) {
  return !!row?.location_id
    && isTagCategory(row.category)
    && LOCATION_TAG_ROLES.has(String(hubUser?.role || ''))
    && hubUser?.location_id === row.location_id
}
