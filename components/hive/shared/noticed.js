// components/hive/shared/noticed.js
// ─────────────────────────────────────────────────────────────
// "Bee Hub noticed" — the second tab on the Reminders page (2026-09-30).
//
// WHAT IT IS NOT. It is not the 71 automatic "follow-up" timeline entries.
// 67 of those are the log line Bee Hub writes AFTER it has emailed a client
// its estimate follow-up (lib/stage-emails.ts: kind 'drip', method 'email',
// status 'sent', label = the template name, e.g. "Opportunity · Organizing
// Estimate — 3 day follow up"). They record something already DONE, have no
// owner, no due date and no way to finish — a tab of them would only grow.
// (That email series was also retired in issue 240.) The other 4 are the
// Won wizard's "⚠️ Satisfaction follow-up needed" flag, which lost its author
// when it was written.
//
// WHAT IT IS. The live fact those emails stood in for: an ESTIMATE WAS SENT
// AND THE JOB HAS NOT MOVED. An open engagement at the Estimate stage whose
// latest quote went out more than ESTIMATE_FOLLOWUP_DAYS ago — the SAME rule,
// SAME threshold and SAME data as Home's "estimates awaiting follow-up" card
// (BeeHub.jsx DashboardScreen), so the two cannot disagree on who is in it.
//
//   · Whose: the LOCATION's. Nobody set these; everyone at the location sees
//     the same list. (Mine is personal — this is not.)
//   · Order: longest waiting first — sent-age is the only honest clock, since
//     Jobber records no reply.
//   · "Overdue": everything here is already past the 3-day mark by
//     definition, so there is no separate overdue state; the row says how
//     many days the estimate has waited instead.
//   · What makes one go away: the job moving. Won, lost, or on to another
//     stage and it leaves the list by itself. There is nothing to tick —
//     ticking would hide a quote that is still unanswered.
// ─────────────────────────────────────────────────────────────

import { ESTIMATE_FOLLOWUP_DAYS } from './attentionThresholds'
import { daysSince } from './engagementStatus'

const latestSent = (e) => (e?.quotes || []).map(q => q?.sent_at).filter(Boolean).sort().pop() || null

// engagements: the Hub's open-engagement payload (stage, location_uuid,
// client_id, client_name, title, quotes[{sent_at}]). locationId: the scope;
// null = no filter (callers pass a location — the tab asks for one on 'all').
export function estimatesAwaitingReply(engagements = [], { locationId = null, nowMs = Date.now() } = {}) {
  const out = []
  for (const e of engagements || []) {
    if (!e || e.stage !== 'Estimate') continue
    if (locationId && e.location_uuid !== locationId) continue
    const sent = latestSent(e)
    if (!sent) continue
    const days = daysSince(sent, nowMs)
    if (!(days > ESTIMATE_FOLLOWUP_DAYS)) continue
    out.push({
      engagement_id: e.id, client_id: e.client_id,
      client_name: e.client_name || 'Unnamed client', title: e.title || null,
      sent_at: sent, days,
    })
  }
  return out.sort((a, b) => b.days - a.days || String(a.client_name).localeCompare(String(b.client_name)))
}
