// Pure identity/scope transitions backing the "view as" (impersonation)
// picker in BeeHub. Extracted so the cancel-revert path is unit-testable
// without mounting the 32k-line hub. An identity is the tuple
// { role, franchiseRole, viewAsUser, locFilter }.
//
// Background (868kaxm20 / view-as strand): the sidebar & mobile "View as
// user…" entries PRE-FLIP role to 'franchise' the instant the picker OPENS —
// before any user is chosen — and only when not already impersonating.
// Location-card entries pre-flip nothing. The strand: cancelling the picker
// used to clear only viewAsTarget, leaving a pre-flipped role stranded at
// 'franchise' with viewAsUser still null (a franchise session impersonating
// nobody). The fix: snapshot the real identity on OPEN, restore it on CANCEL.

export interface ViewAsIdentity {
  role: string
  franchiseRole: string
  viewAsUser: any | null
  locFilter: string
}

// The two roles that see corporate-wide surfaces — chief among them the
// loc_other transfer queue, which is gated CLIENT-side (HiveScreen, Home)
// because under view-as the server session is still super_admin and ships the
// prop populated regardless of who is being impersonated.
//
// Both directions of this matter and neither is the "safe" default: a franchise
// owner seeing corporate's routing queue is a view-as over-exposure artifact,
// and a corp identity NOT seeing it is Leslie unable to do her job.
export function isElevatedRole(role: string | null | undefined): boolean {
  return role === 'super_admin' || role === 'corporate'
}

// The identity to apply when a user is CHOSEN in the picker. Corporate targets
// stay elevated and land on 'all' (their real working scope — corp has no one
// location); everyone else drops to franchise, pinned to their own location,
// carrying their own role as the franchiseRole.
export function viewAsIdentityFor(user: any): ViewAsIdentity {
  const isCorp = user?.role === 'corporate'
  return {
    role: isCorp ? 'corporate' : 'franchise',
    franchiseRole: isCorp ? 'owner' : user?.role,
    viewAsUser: user ?? null,
    locFilter: isCorp ? 'all' : user?.locationId,
  }
}

// The client-side gate on the corporate transfer queue, shared by the Inbox
// hand-off (HiveScreen) and the Home "needs transfer" card so one identity
// cannot pass one surface and fail the other.
//
// It exists because the SERVER cannot make this call: under view-as the session
// is still super_admin, so the prop arrives populated no matter who is being
// impersonated. Elevation is therefore decided here, from the effective role.
export function visibleTransferQueue(
  transferPeople: any[] | null | undefined,
  opts: { isElevated: boolean },
): any[] {
  if (!opts.isElevated) return []
  return Array.isArray(transferPeople) ? transferPeople : []
}

// Snapshot the caller's real identity the instant an entry point opens the
// picker — captured BEFORE any pre-flip runs — so cancel can restore it
// verbatim regardless of which entry (or future entry) opened the picker.
export function captureViewAsSnapshot(identity: ViewAsIdentity): ViewAsIdentity {
  return {
    role: identity.role,
    franchiseRole: identity.franchiseRole,
    viewAsUser: identity.viewAsUser ?? null,
    locFilter: identity.locFilter,
  }
}

// The identity to apply when the picker is CANCELLED. With a snapshot (an
// entry point ran and recorded pre-open state), restore it verbatim — this
// undoes any pre-flip, closing the strand. Without a snapshot (defensive: no
// entry recorded, e.g. state hydrated mid-flight), leave the live identity
// untouched so cancel is a no-op rather than clobbering to defaults.
export function revertViewAsCancel(
  snapshot: ViewAsIdentity | null | undefined,
  live: ViewAsIdentity,
): ViewAsIdentity {
  const src = snapshot ?? live
  return {
    role: src.role,
    franchiseRole: src.franchiseRole,
    viewAsUser: src.viewAsUser ?? null,
    locFilter: src.locFilter,
  }
}
