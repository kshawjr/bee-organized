// lib/access-removal.ts
// ─────────────────────────────────────────────────────────────
// Pure guards for the reversible "Remove access" offboard
// (POST/PATCH /api/hub_users/[id]/access). Kept side-effect-free so the
// permission + safety logic is unit-testable without a DB or network.
//
// Who may remove/restore access:
//   • super_admin / admin (elevated) — any location.
//   • owner — their OWN location only.
//   • manager / lite_user — NEVER (rejected even on a direct API hit).
// This mirrors lib/notification-access.notificationRecipientsManageableServer
// exactly (same owner-vs-manager split, same TEXT location_id equality) so
// the two owner-only gates never drift.
//
// Two additional safety guards, independent of role:
//   • SELF-REMOVAL — a caller can never remove/restore their own access.
//   • LAST OWNER   — the last enabled owner of a location can't be removed
//                    (would orphan the location). Counts enabled owners
//                    INCLUDING the target; ≤ 1 means the target is the last.
// ─────────────────────────────────────────────────────────────

export const BAN_DURATION = '876000h' // ~100 years — an effectively permanent ban
export const UNBAN_DURATION = 'none'

// TEXT location_id equality (hub_users.location_id holds the location UUID as
// text). Returns true when this caller may manage access for the target's
// location.
export function canManageAccess(
  callerRole: string | null | undefined,
  callerLocationId: string | null | undefined,
  targetLocationId: string | null | undefined,
): boolean {
  if (callerRole === 'super_admin' || callerRole === 'admin') return true
  if (callerRole === 'owner') {
    return !!callerLocationId && !!targetLocationId && callerLocationId === targetLocationId
  }
  return false
}

// A caller may never act on their own membership.
export function isSelfRemoval(
  callerUserId: string | null | undefined,
  targetUserId: string | null | undefined,
): boolean {
  return !!callerUserId && !!targetUserId && callerUserId === targetUserId
}

// Removing the target would orphan the location when the target is an owner
// and is the LAST enabled owner. enabledOwnerCount counts owners at the
// location whose disabled_at IS NULL, INCLUDING the target.
export function wouldOrphanLastOwner(
  targetRole: string | null | undefined,
  enabledOwnerCount: number,
): boolean {
  if (targetRole !== 'owner') return false
  return enabledOwnerCount <= 1
}

// One-shot precondition check shared by the route. Returns a machine code +
// http status on rejection, or null when the offboard may proceed. Keeping
// the whole decision here (not scattered in the route) makes it fully
// testable and keeps the route a thin orchestration layer.
export type AccessGuardInput = {
  callerRole: string | null | undefined
  callerUserId: string | null | undefined
  callerLocationId: string | null | undefined
  targetUserId: string | null | undefined
  targetRole: string | null | undefined
  targetLocationId: string | null | undefined
  // Only consulted for a REMOVE of an owner target; pass 0 for reactivation.
  enabledOwnerCount: number
}

export type AccessGuardRejection = { code: string; status: number; error: string }

// mode 'remove' enforces the self + last-owner guards; 'restore' only needs
// the permission + self guards (re-adding login can't orphan a location and
// re-enabling yourself is still nonsensical — you're locked out anyway).
export function checkAccessGuards(
  input: AccessGuardInput,
  mode: 'remove' | 'restore',
): AccessGuardRejection | null {
  if (!canManageAccess(input.callerRole, input.callerLocationId, input.targetLocationId)) {
    return { code: 'forbidden', status: 403, error: 'forbidden' }
  }
  if (isSelfRemoval(input.callerUserId, input.targetUserId)) {
    return {
      code: 'self_removal',
      status: 400,
      error: 'You cannot remove your own access.',
    }
  }
  if (mode === 'remove' && wouldOrphanLastOwner(input.targetRole, input.enabledOwnerCount)) {
    return {
      code: 'last_owner',
      status: 409,
      error: 'Cannot remove the last owner of a location.',
    }
  }
  return null
}
