// lib/partner-tag-writes.ts
// ─────────────────────────────────────────────────────────────
// Attach tags to a Network person at the moment they are created (the add
// sheet, the lead → Network conversion, the referrer quick-add). Same rules
// as POST /api/partner-tags, applied to a list: each id must be a tag from
// the one list (lib/tags.ts) and either corporate or owned by the person's
// own location. Ids that fail are skipped and reported, never written.
//
// Server-only (service role — partner_tags has RLS and no policies).
// ─────────────────────────────────────────────────────────────
import { supabaseService } from '@/lib/supabase-service'
import { cleanTagIds, tagApplyError } from '@/lib/tags'

export type PartnerTagWriteResult = {
  applied: string[]
  rejected: { id: string; error: string }[]
}

export async function attachPartnerTags(
  partnerId: string,
  partnerLocation: string | null,
  rawTagIds: unknown,
  addedBy: string | null
): Promise<PartnerTagWriteResult> {
  const ids = cleanTagIds(rawTagIds)
  if (ids.length === 0) return { applied: [], rejected: [] }

  const { data: defs, error: defsErr } = await supabaseService
    .from('lookups')
    .select('id, category, location_id')
    .in('id', ids)
  if (defsErr) throw new Error(`tag lookup read failed: ${defsErr.message}`)

  const rejected: { id: string; error: string }[] = []
  const ok: string[] = []
  for (const id of ids) {
    const err = tagApplyError((defs || []).find((d: any) => d.id === id), partnerLocation)
    if (err) rejected.push({ id, error: err })
    else ok.push(id)
  }
  if (ok.length === 0) return { applied: [], rejected }

  const { error: insErr } = await supabaseService
    .from('partner_tags')
    .upsert(
      ok.map((tag_lookup_id) => ({ partner_id: partnerId, tag_lookup_id, added_by: addedBy })),
      { onConflict: 'partner_id,tag_lookup_id', ignoreDuplicates: true }
    )
  if (insErr) throw new Error(`partner_tags write failed: ${insErr.message}`)

  return { applied: ok, rejected }
}
