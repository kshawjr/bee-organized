// lib/read-only-access.ts
// ─────────────────────────────────────────────────────────────
// Server-side read-only enforcement for the Hive write routes
// (868kawwmh) — the defense-in-depth twin of the client betaGate
// policy (components/hive/shared/betaGate.js resolveBetaReadOnly).
// The UI hides edit affordances for read-only users; this is the
// floor that rejects the write even if the affordance is reached
// (a stale tab, a direct fetch, a future surface). Mirrors the
// forbidden_read_only_role precedent: a clean 4xx BEFORE any write.
//
// Two read-only classes:
//   • DB role `lite_user` — read-only by definition (role-based,
//     no query needed).
//   • paused / inactive LOCATION — lifecycle_status='paused' or
//     subscription_status='inactive'. Recoverable read-only.
//
// past_due is NOT read-only: it keeps FULL write access through its
// 14-day grace window (only 'paused'/'inactive' locks). Elevated
// roles (super_admin / admin) always write, including on paused
// locations they administer, so they short-circuit before the query.
// ─────────────────────────────────────────────────────────────
import { NextResponse } from 'next/server'

// Elevated corporate/super_admin manage every location — never gated.
// Mirrors lib/auth isAdmin (kept local so this module has no cycle risk).
function isElevatedRole(role: string | null | undefined) {
  return role === 'super_admin' || role === 'admin'
}

// A location is read-only ("paused", recoverable) when its lifecycle is
// paused OR its subscription went inactive. past_due is deliberately NOT
// here — grace-period customers keep full write access.
export function isLocationReadOnly(
  loc: { lifecycle_status?: string | null; subscription_status?: string | null } | null | undefined,
): boolean {
  if (!loc) return false
  return loc.lifecycle_status === 'paused' || loc.subscription_status === 'inactive'
}

// Server-side read-only guard for write routes. Returns a rejection
// NextResponse (403) to short-circuit, or null when the write may proceed.
// Call AFTER auth + row load, passing the target row's location_uuid.
//
//   const block = await readOnlyWriteBlock(hubUser, existing.location_uuid)
//   if (block) return block
//
// Role literals (forbidden_read_only_role) match the existing precedent so
// clients that already handle it keep working; the location variant is
// forbidden_read_only_location.
export async function readOnlyWriteBlock(
  hubUser: { role: string | null | undefined },
  locationUuid: string | null | undefined,
): Promise<NextResponse | null> {
  // Elevated roles bypass entirely (no query).
  if (isElevatedRole(hubUser.role)) return null

  // Read-only ROLE (lite_user) — role-based, no query.
  if (hubUser.role === 'lite_user') {
    return NextResponse.json({ error: 'forbidden_read_only_role' }, { status: 403 })
  }

  // Read-only LOCATION (paused / inactive) — one PK lookup, only for the
  // remaining writable roles (owner / manager). Lazy import so pure
  // consumers of isLocationReadOnly don't instantiate the service client.
  if (!locationUuid) return null
  const { supabaseService } = await import('@/lib/supabase-service')
  const { data: loc } = await supabaseService
    .from('locations')
    .select('lifecycle_status, subscription_status')
    .eq('id', locationUuid)
    .maybeSingle()

  if (isLocationReadOnly(loc)) {
    return NextResponse.json(
      {
        error: 'forbidden_read_only_location',
        detail:
          'This location is paused (read-only) — reactivate the subscription to make changes.',
      },
      { status: 403 },
    )
  }

  return null
}
