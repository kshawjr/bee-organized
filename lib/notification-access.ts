// lib/notification-access.ts
// ─────────────────────────────────────────────────────────────
// Single source of truth for "who may VIEW/MANAGE the Lead Notification
// Recipients list" (which interface users + external emails get notified
// when a new client comes in). Consumed by BOTH the Settings UI section
// (BeeHub SettingsScreen → My Location) and the API routes
// (app/api/locations/[id]/notification-recipients/*), so UI-hidden and
// server-enforced can't drift.
//
// Recipient management is OWNER-or-CORPORATE only:
//   • super_admin / admin / corporate (elevated) — any location.
//   • franchise OWNER (franchiseRole==='owner') — their OWN location only.
// Explicitly EXCLUDED:
//   • franchise MANAGER (franchiseRole==='manager') — a Hive Manager is
//     auto-ADDED as a recipient (they receive lead emails) but must NOT be
//     able to see or edit WHO gets notified. Removing a terminated manager
//     from the list is precisely an owner action they must not undo.
//   • lite_user (viewer / light / readonly) — never manages config.
//
// Mirrors lib/financial-access.financialsVisible exactly (same owner-vs-
// manager split, same reuse-not-parallel-path intent) so the two owner-only
// gates stay consistent.
// ─────────────────────────────────────────────────────────────

// CLIENT-side gate. Vocabulary is the mapRole shape (super_admin | corporate |
// franchise + franchiseRole owner|manager|viewer|...). Used to hide/show the
// Settings section. Elevated callers mount with franchiseRole='owner', so the
// owner branch also covers them; the explicit elevated checks make intent
// obvious and survive any future franchiseRole default change.
export function notificationRecipientsManageable(
  role: string | null | undefined,
  franchiseRole: string | null | undefined,
): boolean {
  if (role === 'super_admin' || role === 'corporate') return true
  return role === 'franchise' && franchiseRole === 'owner'
}

// SERVER-side gate. Vocabulary is the RAW hub_users.role
// ('super_admin' | 'admin' | 'owner' | 'manager' | 'lite_user'). A caller may
// manage a location's recipients if they are elevated (any location) OR they
// are the OWNER of that exact location. Manager / lite_user are always denied,
// including on a direct API hit. locationId comparison is plain string
// equality — hub_users.location_id is TEXT holding the location UUID string,
// and the recipients tables store location_id as the same TEXT.
export function notificationRecipientsManageableServer(
  dbRole: string | null | undefined,
  callerLocationId: string | null | undefined,
  targetLocationId: string,
): boolean {
  if (dbRole === 'super_admin' || dbRole === 'admin') return true
  if (dbRole === 'owner') return !!callerLocationId && callerLocationId === targetLocationId
  return false
}
