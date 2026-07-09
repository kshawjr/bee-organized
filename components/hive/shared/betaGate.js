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

// TODO before onboarding any lite_user or hitting past-due: beta ignores
// readOnly — lite/past-due users get edit chrome with 403 writes. Must add
// read-only mode to the beta surfaces before those user states exist.
//
// GO-LIVE 2026-07-09: gate opened — beta is the default for ALL roles.
// Rollback = restore `return role === 'super_admin'`. Keep this function
// (don't inline at call sites); it stays the single flip point.
export function canSeeBetaBoard(role) {
  return true
}

// Landing-view policy — lives here so the flip point and its landing
// behavior stay in ONE pure module (and stay unit-testable).
//
// Initial view (SSR + first client render — derived from role, so no
// hydration mismatch): beta when the gate is open, Classic otherwise.
export function defaultHiveView(newBoardAllowed) {
  return newBoardAllowed ? 'engagements' : 'list'
}

// Mount-time hydration from the stored bee_hive_view. Returns the view to
// set, or null to keep the default.
//
// GO-LIVE 2026-07-09: with the gate OPEN, stored Classic views
// ('list'/'kanban') no longer win the initial landing — everyone lands on
// beta. The in-session "Back to classic" toggle still works; the
// preference just doesn't decide the NEXT load's landing view.
//
// With the gate CLOSED (rollback), hydration behaves as it always did:
// stored Classic views restore, and a stored 'engagements' is ignored so
// that user self-heals back to Classic on next load.
export function hydrateHiveView(newBoardAllowed, stored) {
  if (!stored) return null
  if (newBoardAllowed) return null
  if (stored === 'engagements') return null
  return stored
}
