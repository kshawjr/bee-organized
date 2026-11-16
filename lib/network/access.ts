// lib/network/access.ts
// ─────────────────────────────────────────────────────────────
// Network & Nurture redesign — WHO MAY SEE THE NEW NETWORK. One list, read by
// both sides, so the menu and the server can never disagree:
//
//   · components/BeeHub.jsx    Network is greyed and closed for everyone this
//                              says no to, exactly as it has been since
//                              2026-11-13
//   · app/api/network/list     answers 403 to everyone this says no to
//
// SLICE 3: super admins only, so Kevin can look at real data before any
// owner does. Corporate (admin), owners, managers and lite users all still
// see the grey. Opening it to more roles later is a change to this list and
// nowhere else.
//
// The role handed in must be the role the viewer is ACTING as. A super admin
// who is viewing as an owner is shown what that owner sees: the grey.
// ─────────────────────────────────────────────────────────────

export const NEW_NETWORK_ROLES: readonly string[] = ['super_admin']

export function maySeeNewNetwork(role: unknown): boolean {
  return typeof role === 'string' && NEW_NETWORK_ROLES.includes(role)
}
