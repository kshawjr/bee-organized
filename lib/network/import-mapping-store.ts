// lib/network/import-mapping-store.ts
// ─────────────────────────────────────────────────────────────
// Network slice 5, third follow-up — the remembered import mappings, kept on
// locations.network_import_mappings (Kevin's ruling 2026-11-19; the column is
// added by migrations/network_names_columns.sql). Server only.
//
// It reads and writes that ONE column of ONE location, nothing else. Neither
// call can stop an import: if the column is not there yet (the migration has
// not been run) or the database says no, the read answers "nothing saved"
// and the save answers saved: false, and the import goes on as it would.
// ─────────────────────────────────────────────────────────────

import { withMapping, type SavedMapping, type SavedMappings } from './import-mapping'

type Db = { from: (table: string) => any }

export async function readImportMappings(db: Db, locationId: string): Promise<{ ok: boolean; mappings: SavedMappings }> {
  const { data, error } = await db.from('locations').select('network_import_mappings').eq('id', locationId).maybeSingle()
  if (error || !data) return { ok: false, mappings: {} }
  const m = data.network_import_mappings
  return { ok: true, mappings: m && typeof m === 'object' && !Array.isArray(m) ? m : {} }
}

export async function saveImportMapping(db: Db, locationId: string, signature: string, mapping: SavedMapping, now: Date): Promise<{ saved: boolean }> {
  const cur = await readImportMappings(db, locationId)
  if (!cur.ok) return { saved: false }
  const next = withMapping(cur.mappings, signature, mapping, now)
  const { error } = await db.from('locations').update({ network_import_mappings: next }).eq('id', locationId)
  return { saved: !error }
}
