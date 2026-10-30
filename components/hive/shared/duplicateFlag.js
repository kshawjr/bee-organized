// components/hive/shared/duplicateFlag.js
// ─────────────────────────────────────────────────────────────
// PURE module — reading leads.possible_duplicate_of for display.
//
// The column is JSONB holding an ARRAY of lead ids (intake, the Jobber
// import, the transfer bin and the in-app create all write it that way; the
// import has written up to 17 on one row). It was write-only until 29 Oct
// 2026: nothing showed it, so an owner who opened a flagged copy saw no sign
// it was one (Andrea Stevens, Central Denver, twice in a week).
//
// duplicateIdsOf()      — the ids, from whatever is stored. An array is the
//                         real shape; a lone string is tolerated (the
//                         transfer helper reads it that way too); anything
//                         else is no flag. Never the record's own id.
// resolveDuplicateOf()  — each id against the rows the server could fetch:
//                         'ok' (open it), 'junk' (it is in the bin — still
//                         openable, Restore brings it back) or 'gone' (no
//                         row: deleted, or not this viewer's to see).
// ─────────────────────────────────────────────────────────────

/**
 * @param {unknown} raw
 * @param {string | null} [selfId]
 * @returns {string[]}
 */
export function duplicateIdsOf(raw, selfId = null) {
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? [raw] : [])
  const out = []
  for (const v of list) {
    if (typeof v !== 'string' || !v || v === selfId || out.includes(v)) continue
    out.push(v)
  }
  return out
}

// `rows` are leads rows ({ id, name, is_junk }) already filtered to what this
// viewer may see. Order follows the stored array.
export function resolveDuplicateOf(ids, rows) {
  const byId = new Map((rows || []).filter(r => r?.id).map(r => [r.id, r]))
  return (ids || []).map(id => {
    const r = byId.get(id)
    if (!r) return { id, name: null, state: 'gone' }
    return { id, name: (r.name || '').trim() || 'Unnamed client', state: r.is_junk === true ? 'junk' : 'ok' }
  })
}
