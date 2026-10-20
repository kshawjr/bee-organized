// lib/other-card-backlog.ts
// ─────────────────────────────────────────────────────────────
// Which leads already in Other should get their route-suggestion card posted
// to Other's Slack channel (20 Oct 2026). The card normally posts only at
// intake, so leads that were in Other before Other was connected to Slack —
// Leslie's backlog — never had one. scripts/post-other-cards.mjs runs this;
// the tests pin it. Pure: no database, no Slack.
//
// THE RULES — a card only for a lead that is still OPEN in Other, by the
// same test as Bee Hub's own Needs-transfer list, so Slack and the Inbox
// never disagree about what Leslie still has to route:
//   • in Other; not binned (is_junk) and not archived — applyLeadActiveFilter
//   • not dismissed (inbox_dismissed_at) — Leslie's "handled"
//   • not snoozed (snoozed_until still ahead) — her "not yet"
//     (isSoftRemovedFromInbox, components/hive/shared/inboxSoftRemoval.js)
// and two more the Inbox doesn't need but a card does:
//   • not already sent the no-coverage email (an accepted no_coverage_optin
//     row). That send dismisses the lead, but if the dismiss write failed
//     afterwards the lead would look open — and must never get a card that
//     could route a customer we've told we don't serve. (20 Oct 2026: six of
//     the seven backlog leads had been sent it.)
//   • movable: no engagement (a lead closed as not interested has a Closed
//     Lost one) and nothing in Jobber. lib/lead-transfer-rule refuses those,
//     so every hive button on their card could only fail.
// Then:
//   • oldest first — the order Leslie would work them
//   • a lead that already has a posted card (a 'slack' notification_log row
//     at Other with send_status 'accepted') is SKIPPED, so running the script
//     twice never double-posts. --again lifts THIS rule only, for ONE named
//     lead; it never revives a lead that is resolved.
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
  archived_at?: string | null
  inbox_dismissed_at?: string | null
  snoozed_until?: string | null
  // Read alongside the lead by the script (engagements, Jobber ids,
  // notification_log); booleans here so the rules stay pure.
  no_coverage_sent?: boolean
  has_engagement?: boolean
  in_jobber?: boolean
}

export type SkipReason =
  | 'not_in_other' | 'binned' | 'archived' | 'dismissed' | 'snoozed'
  | 'no_coverage_sent' | 'has_engagement' | 'in_jobber'
  | 'already_posted' | 'test_record' | 'not_found'

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
  nowMs?: number
}): BacklogPlan {
  const nowMs = args.nowMs ?? Date.now()
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
    const resolved = resolvedReason(l, nowMs)
    if (resolved) { plan.skipped.push({ id: l.id, reason: resolved }); continue }
    if (!only && isTestRecord(l)) { plan.skipped.push({ id: l.id, reason: 'test_record' }); continue }
    if (posted.has(l.id) && !(args.again && only)) { plan.skipped.push({ id: l.id, reason: 'already_posted' }); continue }
    plan.post.push(l)
  }
  return plan
}

// Why a lead in Other is no longer open, or null when it is. Order: the
// Inbox's own holds first, then the card-only rules.
export function resolvedReason(l: BacklogLead, nowMs: number): SkipReason | null {
  if (l.archived_at) return 'archived'
  if (l.inbox_dismissed_at) return 'dismissed'
  if (l.snoozed_until && new Date(l.snoozed_until).getTime() > nowMs) return 'snoozed'
  if (l.no_coverage_sent) return 'no_coverage_sent'
  if (l.has_engagement) return 'has_engagement'
  if (l.in_jobber) return 'in_jobber'
  return null
}
