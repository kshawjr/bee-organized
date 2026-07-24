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

// GO-LIVE 2026-07-09: gate opened — beta is the default for ALL roles.
// Rollback = restore `return role === 'super_admin'`. Keep this function
// (don't inline at call sites); it stays the single flip point.
export function canSeeBetaBoard(role) {
  return true
}

// ─────────────────────────────────────────────────────────────
// Read-only policy for the beta surfaces (868kawwmh). The beta
// board is a WRITE surface; two user classes are look-but-don't-
// touch and must reach it with every edit affordance hidden:
//
//   • lite_user — read-only by definition (their own location).
//     mapRole lands DB `lite_user` on franchiseRole='viewer'; the
//     client-side role/view-as pickers also emit 'light'/'readonly'.
//     All three mean read-only.
//   • paused / inactive locations — the subscription state machine
//     drops a location to paused = read-only (recoverable).
//
// past_due is NOT read-only: it keeps FULL write access through its
// 14-day grace window (crmStatus 'pastdue'); only 'inactive' (paused)
// locks. And the full-access roles (super_admin, corporate/admin,
// owner, manager) always write — including corporate managing a
// paused location — so elevated roles short-circuit to writable.
//
// This is the single policy point (mirrors canSeeBetaBoard): callers
// pass the mapRole vocabulary + crmStatus and thread the boolean into
// the beta tree; the server enforces the same shape independently
// (lib/read-only-access).
// Exported as the ONE definition of "read-only franchiseRole". Every
// consumer must call isReadOnlyFranchiseRole() rather than hand-writing a
// literal subset — a hand-written ['light','readonly'] silently missed
// 'viewer' (the value mapRole actually emits for a real lite_user session)
// and let lite_user past the Settings nav lockout.
export const READ_ONLY_FRANCHISE_ROLES = ['viewer', 'light', 'readonly']

export function isReadOnlyFranchiseRole(franchiseRole) {
  return READ_ONLY_FRANCHISE_ROLES.includes(franchiseRole)
}

export function resolveBetaReadOnly({ role, franchiseRole, crmStatus }) {
  // Elevated roles are never read-only via this gate (they write on
  // every location, paused ones included).
  if (role === 'super_admin' || role === 'corporate') return false
  if (READ_ONLY_FRANCHISE_ROLES.includes(franchiseRole)) return true
  // Paused/inactive location → read-only for its owner/manager too.
  // NOT 'pastdue' — grace-period customers keep writing.
  return crmStatus === 'inactive'
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
