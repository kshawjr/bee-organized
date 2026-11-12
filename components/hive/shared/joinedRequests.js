// components/hive/shared/joinedRequests.js
// ─────────────────────────────────────────────────────────────
// "A second request came in and was added to this card" — the owner-facing
// account of fix 2 (2026-11): a second Jobber request minutes after the first
// joins the first's card instead of founding a twin. A card that silently
// absorbed a request is how a real second job gets lost, so the card says so,
// with the request number and a link straight to it in Jobber.
//
// Derived from the card's own service_requests rows (oldest first), so it can
// never drift from what the card holds: every request after the first is
// named. Nothing to store, nothing to forget to write.
// ─────────────────────────────────────────────────────────────

const t = (s) => {
  const n = s ? Date.parse(s) : NaN
  return Number.isFinite(n) ? n : null
}
const when = (r) => t(r.requested_at) ?? t(r.created_at)

export function describeJoinedRequests(serviceRequests) {
  const rows = (serviceRequests || []).filter(r => r && r.jobber_request_id)
  if (rows.length < 2) return []
  const sorted = [...rows].sort((a, b) => (when(a) ?? 0) - (when(b) ?? 0))
  const first = sorted[0]
  return sorted.slice(1).map(r => {
    const gapMs = when(r) != null && when(first) != null ? when(r) - when(first) : null
    const mins = gapMs == null ? null : Math.max(0, Math.round(gapMs / 60000))
    const gap = mins == null ? '' : mins < 1 ? ' less than a minute after' : mins === 1 ? ' 1 minute after' : mins < 120 ? ` ${mins} minutes after` : ' after'
    return {
      jobberRequestId: String(r.jobber_request_id),
      firstJobberRequestId: String(first.jobber_request_id),
      href: r.request_url || null,
      text:
        `A second request came in from Jobber and was added to this card: REQ-${r.jobber_request_id},` +
        `${gap || ' after'} REQ-${first.jobber_request_id}. ` +
        `If it is a separate job, open it in Jobber.`,
    }
  })
}
