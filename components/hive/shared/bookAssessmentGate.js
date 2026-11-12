// components/hive/shared/bookAssessmentGate.js
// ─────────────────────────────────────────────────────────────
// When the engagement card offers "Book assessment".
//
// Shows when the card's work is a Jobber request with NO assessment yet —
// the "Request only" send, waiting on a time. Hidden when:
//   · there is no Jobber request to hang it on (not sent → Send to Jobber is
//     the door instead, and the two never show together);
//   · the card already has an assessment (moving it is a reschedule, which
//     this does not do — never a second one by accident);
//   · the deal is closed, or the viewer is read-only (lite_user, paused
//     location) — the route refuses those independently.
// The route re-checks all of this, including a live read of the request in
// Jobber, so a stale screen can never book a second one.
// ─────────────────────────────────────────────────────────────

const TERMINAL = new Set(['Closed Won', 'Closed Lost'])

export function canBookAssessment({ eng, children, readOnly }) {
  if (readOnly || !eng || TERMINAL.has(eng.stage)) return false
  const srs = (children && children.service_requests) || []
  const sent = srs.filter(sr => !!sr && !!sr.jobber_request_id)
  if (sent.length !== 1) return false
  return ((children && children.assessments) || []).length === 0
}
