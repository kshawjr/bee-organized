-- One-off cleanup: remove orphan "System Admin" hub_users row that was
-- seeded directly into the DB (admin@beeorganized.com on Test Location)
-- without going through the invite/accept flow. The row has no matching
-- subscription_seats claim, which makes LocationDetailSheet show a
-- misleading "System Admin · joined May 2026" subtitle for a location
-- whose owner seat is in fact still unclaimed.
--
-- Run this in the Supabase SQL editor. The script is verify-then-delete:
-- the SELECTs at the top must look right BEFORE uncommenting the DELETE.
--
-- Sibling orphan to consider post-launch (NOT cleaned here):
-- test.palmbeach@bmave.com on Palm Beach Test was also seeded the same
-- way, but Tuesday's real owner will use that identity, so we leave it
-- alone for now. Tech debt: rerun this pattern after launch.

BEGIN;

-- 1. Identify the orphan row. Expect exactly 1 result.
SELECT
  hu.id,
  hu.email,
  hu.full_name,
  hu.role,
  hu.location_id,
  l.name AS location_name,
  hu.created_at
FROM hub_users hu
LEFT JOIN locations l ON l.id = hu.location_id
WHERE hu.email = 'admin@beeorganized.com';

-- 2. Confirm orphan — no subscription_seats row should reference this user.
--    If this returns rows, STOP — the user is actually claiming a seat,
--    deleting them would silently leak the seat back to the pool without
--    any audit trail.
SELECT
  s.id AS seat_id,
  s.location_id,
  s.tier,
  s.user_id,
  s.status,
  hu.email
FROM subscription_seats s
JOIN hub_users hu ON hu.id = s.user_id
WHERE hu.email = 'admin@beeorganized.com';

-- 3. Confirm the loc_test owner seat is unclaimed (already reset per
--    Kevin's earlier work). Expect: 1 row with user_id IS NULL.
SELECT
  s.id,
  s.tier,
  s.user_id,
  s.status,
  l.name AS location_name
FROM subscription_seats s
JOIN locations l ON l.id = s.location_id
WHERE l.name ILIKE '%test%location%'
  AND s.tier = 'owner'
  AND s.status = 'active';

-- 4. After verifying the above match expectations, uncomment and re-run:
-- DELETE FROM hub_users WHERE email = 'admin@beeorganized.com';

COMMIT;
