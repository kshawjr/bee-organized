// lib/financial-access.ts
// ─────────────────────────────────────────────────────────────
// Single source of truth for "who may see money figures" (revenue,
// collected, royalties). Consumed by BOTH the Home Revenue tile
// (DashboardScreen) and the Reports revenue sections (ReportsScreen /
// FranchiseReports) so the two surfaces can't drift apart.
//
// Financials are OWNER-or-CORPORATE only:
//   • super_admin / corporate (elevated) — full platform/location money.
//   • franchise OWNER (franchiseRole==='owner') — their own location's money.
// Explicitly EXCLUDED:
//   • franchise MANAGER (franchiseRole==='manager') — operational lead; sees
//     counts/stages/activity but NOT revenue (Kevin's call, Hive Manager launch).
//   • lite_user (franchiseRole viewer/light/readonly) — unchanged, never saw it.
//
// Vocabulary is the CLIENT mapRole shape (super_admin | corporate | franchise
// + franchiseRole owner|manager|viewer|light|readonly), NOT raw DB roles.
// Elevated callers pass franchiseRole='owner' at their mount, so the
// owner-branch also covers them; the explicit elevated checks make intent
// obvious and survive any future franchiseRole default change.
// ─────────────────────────────────────────────────────────────

export function financialsVisible(
  role: string | null | undefined,
  franchiseRole: string | null | undefined,
): boolean {
  if (role === 'super_admin' || role === 'corporate') return true
  return role === 'franchise' && franchiseRole === 'owner'
}
