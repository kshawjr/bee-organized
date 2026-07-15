// components/hive/shared/leadsRealtime.js
// ─────────────────────────────────────────────────────────────
// The leads-realtime merge: fold a person refetched off a realtime event into
// the `people` snapshot BeeHub owns and every lens derives from.
//
// Extracted from BeeHub's handler for the same reason engagementRevalidate.js
// was extracted from the board's: the merge is the part with a rule worth
// pinning, and it is untestable while it lives inline in a 34k-line component.
//
// DELIBERATELY NOT reconcileServerRows. That seam DROPS rows absent from
// baseById — new engagements are reload-only by design, and the board's
// stage-move path depends on that drop. This is the opposite rule (a row it has
// never seen is exactly what it must accept), so it is a SEPARATE function on a
// separate state tree (people, not engagements). The two never share code, so
// extending leads with an insert path cannot leak an insert into the board.
//
// ADDITIVE-BY-ID, not append: a lead already in the snapshot — created locally
// this session, or named by a duplicate/burst event — is REPLACED in place, so
// it can never render twice. Note this differs from peopleTouchPatch's
// additive-by-id override, which layers timeline entries; here the refetched
// person IS the server's whole truth for that row, so last-wins is correct.
//
// New rows land at the FRONT: an Inbox sorted newest-first is where a brand-new
// lead belongs, and the row buckets through the same deriveClientStatus as
// every other person — there is no realtime-specific status path.
// ─────────────────────────────────────────────────────────────

// `pulseMs` stamps _realtimePulse so the card can briefly highlight as the
// change lands. Injected rather than read off Date.now() inside so the merge
// stays pure (and testable without faking the clock).
export function upsertRealtimePerson(prev, person, pulseMs) {
  if (!person || !person.id) return prev
  const next = { ...person, _realtimePulse: pulseMs }
  const i = prev.findIndex(p => p.id === person.id)
  if (i === -1) return [next, ...prev]
  const copy = prev.slice()
  copy[i] = next
  return copy
}

export function removeRealtimePerson(prev, leadId) {
  if (!leadId) return prev
  return prev.some(p => p.id === leadId) ? prev.filter(p => p.id !== leadId) : prev
}
