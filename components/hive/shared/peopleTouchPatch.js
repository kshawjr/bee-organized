// components/hive/shared/peopleTouchPatch.js
// ─────────────────────────────────────────────────────────────
// PURE merge for the LOG-CALL override — the people analogue of
// engagementRevalidate's mergeEngagements.
//
// THE BUG THIS CLOSES: logging a call writes a real client-level reach_out
// touchpoint, but every lens derives client status (clientStatus.js) from
// person.outreachTimeline — a PAGE-LOAD snapshot. The write lands and nothing
// moves until a reload, which reads as "I logged a call and nothing happened".
// The Inbox used to paper over this with an Inbox-LOCAL loggedIds Set that
// reassigned its own row's section, which is why the SAME person kept reading
// New in the directory and on the badge. Lifting the override to HiveShell and
// merging HERE — once, before people is spread to the lenses — means every
// lens derives through it and no lens has to know it exists.
//
// PRECEDENCE DIFFERS FROM mergeEngagements ON PURPOSE. Engagement rowPatches
// are field OVERWRITES, so "local wins last" is idempotent and safe. Timeline
// entries are APPENDS: winning last would DOUBLE-COUNT the same call the
// moment a refetch brings it back (two reach_outs → a wrong Inbox touch-band
// filter). So this merge is ADDITIVE-BY-ID: entries the snapshot already
// carries are dropped, server truth wins for every row it has, and the
// override only ever contributes rows the server hasn't shown us yet. The two
// layers agree by construction — the entry is projected from the CONFIRMED API
// row through people-mapper's touchpointToTimelineEntry, the same function
// hydration uses — so the override converges into the snapshot rather than
// fighting it, and can never drift.
//
// Only CONFIRMED server rows land here (the same real-row rule as
// onPersonCreated / sessionEngagements), never optimistic stubs, so `id` is
// always the real one the reload will echo.
//
// SCOPE: this is a purely local re-derive of the user's OWN action. Someone
// else's (or a webhook's) touchpoint appearing live is a separate build —
// it needs touchpoints realtime and the leads RLS fix.
//
// Zero imports — safe in any bundle (§8.5 pure-module rule).
// ─────────────────────────────────────────────────────────────

// people           — the page-load snapshot (BeeHub state, server-hydrated)
// touchPatches     — personId → CONFIRMED outreachTimeline entries logged
//                    this session
//
// Returns the SAME `people` reference when there is nothing to add (no
// patches, or the server has echoed every one), so a refetch that catches up
// costs zero re-renders and the override quietly retires itself.
export function mergePeopleTouches(people, touchPatches) {
  if (!touchPatches || Object.keys(touchPatches).length === 0) return people
  let changed = false
  const merged = people.map(p => {
    const local = touchPatches[p.id]
    if (!local || local.length === 0) return p
    const timeline = p.outreachTimeline || []
    const seen = new Set(timeline.map(t => t.id).filter(Boolean))
    // The dedupe: once a reload/refetch hydrates the touchpoint, the snapshot
    // is already true and the override contributes nothing.
    const add = local.filter(t => t && t.id && !seen.has(t.id))
    if (add.length === 0) return p
    changed = true
    return {
      ...p,
      // people-mapper hands the snapshot over sorted occurred_at ASCENDING;
      // hold that contract so the "last entry is the newest" readers stay
      // correct rather than depending on insertion order.
      outreachTimeline: [...timeline, ...add].sort(
        (a, b) => new Date(a.occurred_at || 0).getTime() - new Date(b.occurred_at || 0).getTime()
      ),
    }
  })
  return changed ? merged : people
}
