// lib/territory-access.ts
// ─────────────────────────────────────────────────────────────
// Who may SEE and who may CHANGE a location's territory (its zips in
// location_zips). One source for every route that touches the list, so the
// read route and the write routes cannot disagree.
//
// Kevin's ruling (30 Sep 2026): CORPORATE EDITS, OWNERS VIEW. Territories are
// a franchise-agreement matter, and a zip one location gains another loses,
// so no owner adjusts theirs alone.
//
//   edit — super_admin / admin (the corporate tier) only, any location.
//          app/api/admin/location-zips (+ ./resolve) via requireCorporate.
//   view — corporate, any location; an owner or manager of THAT location.
//          app/api/locations/[id]/zips.
//   lite_user, and anyone at another location — neither.
//
// Vocabulary is the RAW hub_users.role, compared server-side. The screen hides
// controls from non-corporate callers, but only because the server has
// already said can_edit=false; a hidden button is not the permission.
// hub_users.location_id is TEXT holding the location UUID string — plain
// string equality, same as lib/notification-access.
// ─────────────────────────────────────────────────────────────

export const TERRITORY_EDIT_ROLES = ['super_admin', 'admin'] as const
const TERRITORY_VIEW_OWN_ROLES = ['owner', 'manager'] as const

export function territoryEditableServer(dbRole: string | null | undefined): boolean {
  return (TERRITORY_EDIT_ROLES as readonly string[]).includes(dbRole ?? '')
}

export function territoryViewableServer(
  dbRole: string | null | undefined,
  callerLocationId: string | null | undefined,
  targetLocationId: string,
): boolean {
  if (territoryEditableServer(dbRole)) return true
  if ((TERRITORY_VIEW_OWN_ROLES as readonly string[]).includes(dbRole ?? '')) {
    return !!callerLocationId && callerLocationId === targetLocationId
  }
  return false
}
