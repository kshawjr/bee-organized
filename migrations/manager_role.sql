-- migrations/manager_role.sql
--
-- Make the Hive Manager tier a REAL role. Previously manager seat-holders were
-- forced into 'lite_user' (read-only) despite paying the $400 tier price —
-- highest-impact finding from the audit at d414443. This adds 'manager' to the
-- hub_users.role CHECK constraint so roleForTier() can map manager → 'manager'
-- (see app/api/hub_users/invite + seats/buy-and-invite).
--
-- Applied to production by Kevin BEFORE this deploy. Safe to re-run: the
-- DROP ... IF EXISTS + re-ADD makes it idempotent.
--
-- NOTE: pending_invites intentionally has NO role CHECK constraint (it only
-- constrains `tier`, and 'manager' is already in its allowed tier values), so
-- no change is needed there — roleForTier writing pending_invites.role='manager'
-- is accepted as-is. Existing rows are unaffected; this only widens the allowed
-- set, it does not migrate any 'lite_user' rows to 'manager'.

ALTER TABLE hub_users DROP CONSTRAINT IF EXISTS hub_users_role_check;
ALTER TABLE hub_users ADD CONSTRAINT hub_users_role_check
  CHECK (role IN ('super_admin', 'admin', 'owner', 'manager', 'lite_user'));
