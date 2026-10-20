// lib/other-card-backlog.ts
// ─────────────────────────────────────────────────────────────
// Which leads already in Other should get their route-suggestion card posted
// to Other's Slack channel (20 Oct 2026). The card normally posts only at
// intake, so leads that were in Other before Other was connected to Slack —
// Leslie's backlog — never had one. scripts/post-other-cards.mjs runs this;
// the tests pin it. Pure: no database, no Slack.
//
// THE RULES
//   • only leads in Other, not binned (is_junk)
//   • oldest first — the order Leslie would work them
//   • a lead that already has a posted card (a 'slack' notification_log row
//     at Other with send_status 'accepted') is SKIPPED, so running the script
//     twice never double-posts. --again lifts this for ONE named lead only
//     (the deliberate re-post the second test needs).
//   • --all leaves out test records: a lead whose first or last name is
//     exactly "test" (any case). --lead posts a named lead whatever its name,
//     because the test needs Roza TEST.
// ─────────────────────────────────────────────────────────────

export const OTHER_SLUG = 'loc_other'

export type BacklogLead = {
  id: string
  first_name: string | null
  last_name: string | null
  location_id: string | null
  is_junk: boolean | null
  created_at: string
}

export type SkipReason = 'not_in_other' | 'binned' | 'already_posted' | 'test_record' | 'not_found'

export type BacklogPlan = {
  post: BacklogLead[]
  skipped: { id: string; reason: SkipReason }[]
}

export function isTestRecord(l: Pick<BacklogLead, 'first_name' | 'last_name'>): boolean {
  const word = (s: string | null) => (s || '').trim().toLowerCase() === 'test'
  return word(l.first_name) || word(l.last_name)
}

export function planBacklog(args: {
  leads: BacklogLead[]
  // lead ids that already have an accepted Slack card at Other
  posted: Set<string>
  // one named lead (--lead), or every eligible lead (--all)
  only?: string | null
  again?: boolean
}): BacklogPlan {
  const { leads, posted } = args
  const only = args.only ?? null
  if (args.again && !only) throw new Error('--again needs --lead: it re-posts one named lead, never the whole backlog')

  const pool = only ? leads.filter((l) => l.id === only) : leads
  const plan: BacklogPlan = { post: [], skipped: [] }
  if (only && pool.length === 0) {
    plan.skipped.push({ id: only, reason: 'not_found' })
    return plan
  }
  const ordered = [...pool].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  for (const l of ordered) {
    if (l.location_id !== OTHER_SLUG) { plan.skipped.push({ id: l.id, reason: 'not_in_other' }); continue }
    if (l.is_junk === true) { plan.skipped.push({ id: l.id, reason: 'binned' }); continue }
    if (!only && isTestRecord(l)) { plan.skipped.push({ id: l.id, reason: 'test_record' }); continue }
    if (posted.has(l.id) && !(args.again && only)) { plan.skipped.push({ id: l.id, reason: 'already_posted' }); continue }
    plan.post.push(l)
  }
  return plan
}
