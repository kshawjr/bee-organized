// components/hive/shared/betaGate.js
// ─────────────────────────────────────────────────────────────
// PURE module (zero imports) — the single gate for Phase 1 beta
// surfaces. Every step-4 screen (board, panel, list, inbox,
// directory) checks THIS function; when the read flip goes
// permanent, this is the one place that opens.
//
// `role` is App's role state (mapRole vocabulary: 'super_admin'
// passes through verbatim; 'admin'→'corporate', owner/manager→
// 'franchise'). Never gate on initialFranchiseRole or raw DB roles.
// ─────────────────────────────────────────────────────────────

export function canSeeBetaBoard(role) {
  return role === 'super_admin'
}
