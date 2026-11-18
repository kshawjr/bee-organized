// lib/network/contact-writes.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign, slice 5 — the ONE place new contacts are
// written, for the add flow and for an import. Server only.
//
// ALL OR NOTHING, and how. Bee Hub talks to the database through Supabase's
// REST API, which runs each request as its own statement; it has no way to
// hold one transaction open across two requests, and this slice adds no
// database function (no migration). So the write is two statements and an
// undo:
//
//   1. ONE insert of every contact row. A single statement in Postgres is
//      all or nothing by itself: if any row breaks a rule of the table (a
//      check, a missing location), not one row of the file is kept.
//   2. ONE insert of every tag link for those contacts. Also all or nothing.
//   3. If 2 fails, the contacts from 1 are deleted again, by the ids 1
//      handed back (their tag links go with them: partner_tags cascades).
//      If that delete ALSO fails, the answer says so and lists the ids, and
//      the server log says so too, so nobody is told "nothing was added"
//      when something was.
//
// Nothing else is written: no touchpoint, no reminder, no tag, no other
// table. (A phone note from an import is kept on the contact's own notes,
// inside the same row, for exactly this reason.)
// ─────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto'
import { NEW_CONTACT_COLUMNS, type NewContactRow } from './contact-create'

export type WriteResult =
  | { ok: true; ids: string[] }
  | { ok: false; stage: 'contacts' | 'tags'; error: string; undone: boolean; leftBehind: string[] }

type Db = { from: (table: string) => any }

const pick = (row: NewContactRow) => Object.fromEntries(NEW_CONTACT_COLUMNS.map((c) => [c, (row as any)[c]]))

/**
 * Write contacts and their tags. `items` is in file order; the ids come back
 * in the same order. `db` is the service client (or a stand-in in tests).
 */
export async function writeNewContacts(
  db: Db,
  items: { row: NewContactRow; tagIds: string[] }[],
  addedBy: string | null,
): Promise<WriteResult> {
  if (items.length === 0) return { ok: true, ids: [] }

  // 1. Every contact, in one statement. Each id is made HERE, so a tag link
  // is tied to its contact by id, never by the order rows come back in.
  const ids = items.map(() => randomUUID())
  const ins = await db.from('partners').insert(items.map((i, n) => ({ id: ids[n], ...pick(i.row) }))).select('id')
  if (ins.error) return { ok: false, stage: 'contacts', error: String(ins.error.message || ins.error), undone: true, leftBehind: [] }
  const back = new Set<string>((ins.data || []).map((r: any) => r.id))
  if (back.size !== ids.length || ids.some((id) => !back.has(id))) {
    const undo = await undoContacts(db, ids)
    return { ok: false, stage: 'contacts', error: `wrote ${back.size} of ${items.length}`, undone: undo.ok, leftBehind: undo.ok ? [] : ids }
  }

  // 2. Every tag link, in one statement.
  const links = items.flatMap((i, n) => i.tagIds.map((tag_lookup_id) => ({ partner_id: ids[n], tag_lookup_id, added_by: addedBy })))
  if (links.length) {
    const tl = await db.from('partner_tags').insert(links)
    if (tl.error) {
      // 3. Take the contacts back out.
      const undo = await undoContacts(db, ids)
      if (!undo.ok) console.error('[network write] UNDO FAILED, contacts left behind:', ids, undo.error)
      return { ok: false, stage: 'tags', error: String(tl.error.message || tl.error), undone: undo.ok, leftBehind: undo.ok ? [] : ids }
    }
  }
  return { ok: true, ids }
}

async function undoContacts(db: Db, ids: string[]): Promise<{ ok: boolean; error?: string }> {
  if (!ids.length) return { ok: true }
  const del = await db.from('partners').delete().in('id', ids)
  return del.error ? { ok: false, error: String(del.error.message || del.error) } : { ok: true }
}
