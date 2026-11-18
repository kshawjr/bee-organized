// lib/network/contact-reads.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 5 — the reads the add flow and an import
// make BEFORE they write, so both ask the same questions the same way.
// Server only. Reads, never writes.
//
//   · the location, so a contact is never sent to one that does not exist
//   · that location's tag list (corporate tags plus its own), as the tag
//     picker reads it
//   · that location's LIVE contacts' id, name and email, for the duplicate
//     check. The recycle bin is not looked at: a contact someone deleted is
//     not "already here".
// ─────────────────────────────────────────────────────────────

import { TAG_CATEGORY } from '@/lib/tags'
import type { ExistingContact, TagDef } from './contact-create'

type Db = { from: (table: string) => any }
const PAGE = 1000
const MAX_ROWS = 20000

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function readLocation(db: Db, locationId: string): Promise<{ ok: true; location: { id: string; name: string } | null } | { ok: false; error: string }> {
  const { data, error } = await db.from('locations').select('id, name').eq('id', locationId).maybeSingle()
  if (error) return { ok: false, error: String(error.message || error) }
  return { ok: true, location: data ? { id: data.id, name: data.name } : null }
}

export async function readLocationTags(db: Db, locationId: string): Promise<{ ok: true; tags: TagDef[] } | { ok: false; error: string }> {
  const { data, error } = await db
    .from('lookups')
    .select('id, label, category, location_id, is_active, attrs')
    .eq('category', TAG_CATEGORY)
    .or(`location_id.is.null,location_id.eq.${locationId}`)
  if (error) return { ok: false, error: String(error.message || error) }
  return { ok: true, tags: (data || []) as TagDef[] }
}

export async function readLiveContacts(db: Db, locationId: string): Promise<{ ok: true; contacts: ExistingContact[] } | { ok: false; error: string }> {
  const out: ExistingContact[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await db
      .from('partners')
      .select('id, name, email, phone')
      .eq('location_id', locationId)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return { ok: false, error: String(error.message || error) }
    out.push(...((data || []) as ExistingContact[]))
    if ((data || []).length < PAGE) return { ok: true, contacts: out }
  }
  // Never check duplicates against a list that was cut short.
  return { ok: false, error: 'too_many_contacts_to_check' }
}
