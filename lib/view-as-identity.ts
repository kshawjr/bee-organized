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
