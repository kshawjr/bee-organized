-- ════════════════════════════════════════════════════════════════════
--  feedback_items.is_internal — one tracker for everything. Issue 247 step 1.
--
--  HELD: run this by hand (Kevin). The system is LIVE. Until it runs the app
--  degrades gracefully — every owner-facing read retries without the filter
--  (lib/feedback-internal withInternalFallback), which is a no-op because no
--  row can be internal while the column does not exist.
-- ════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS FOR. feedback_items becomes the single tracker: owner reports
-- AND internally-found bugs in one table, so overlap is VISIBLE. When Kevin
-- logs "Palm Beach import is stuck" and Ankur reports the same thing a week
-- later, both rows sit in one list against one location instead of one being in
-- ClickUp where nobody cross-references it.
--
-- THE RULE THIS COLUMN EXISTS TO ENFORCE:
--
--     An owner sees items THEIR LOCATION SUBMITTED. Nothing else.
--
-- WHY A NEW COLUMN AND NOT AN EXISTING ONE.
--
--   · NOT `type`. It is CHECK-constrained to ('bug','feature') and the internal
--     backlog also holds decisions and hazards. Widening that CHECK to carry a
--     visibility meaning would conflate "what kind of work is this" with "who
--     may see it" — two axes that have to vary independently.
--
--   · NOT `location_id`, and this is the whole reason the issue exists.
--     location_id is COPIED FROM THE SUBMITTER on insert (app/api/feedback
--     POST reads hub_users.location_id), so it has always meant "submitted
--     from here". The owner read filters `.eq('location_id', <theirs>)`, which
--     today IS "what my location submitted" — owners are the only filers, so
--     the two readings are indistinguishable.
--
--     Tagging an internal item with a location is exactly what makes the
--     overlap show, and it is exactly what splits those two readings apart. The
--     moment it happens, the existing predicate publishes internal work to the
--     owner it is about. This flag re-separates them.
--
-- NO SECOND "SUBJECT LOCATION" COLUMN IS NEEDED. Internal rows are excluded
-- from owner reads WHOLESALE, so location_id's second meaning is never
-- observable to an owner. One boolean restores the guarantee and unlocks the
-- tag at the same time.
--
-- DEFAULT false, NOT NULL — both load-bearing:
--
--   · DEFAULT false makes this a NO-OP for the 63 existing rows. Every one of
--     them is a genuine owner report and every one must stay visible to the
--     owner who filed it. There is no backfill step and no row to re-check.
--
--   · NOT NULL is the one that would bite if it were skipped. The owner reads
--     filter `is_internal = false`, and in SQL that predicate is NULL — not
--     true — for a NULL value, so a nullable column with no default would make
--     all 63 existing reports VANISH from their owners' screens. NOT NULL
--     DEFAULT false backfills every existing row to false in the same
--     statement, so the filter matches them.
--
-- NO INDEX, deliberately. feedback_items is 63 rows today and perhaps ~110
-- after the ClickUp items land. Every read of this column is already inside a
-- per-location or per-user filtered set that feedback_items_location_idx /
-- feedback_items_user_idx already narrow. An index here would be ceremony, not
-- performance — the same call migrations/feedback_reply_seen.sql made.

ALTER TABLE feedback_items
  ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN feedback_items.is_internal IS
  'TRUE = found internally (engineering/triage), never shown to franchise owners even when location_id tags that owner''s location. FALSE = submitted by a hub user through the app; visible to their location. Owner-facing reads filter is_internal=false server-side (GET/PATCH /api/admin/feedback, GET /api/feedback); elevated roles (super_admin, admin) see everything. Issue 247 step 1.';


-- ─── VERIFY AFTER RUNNING ────────────────────────────────────────────
-- Expect: 63 rows, all is_internal=false, none newly hidden.
--
--   SELECT count(*) AS total,
--          count(*) FILTER (WHERE is_internal) AS internal,
--          count(*) FILTER (WHERE NOT is_internal) AS owner_visible
--   FROM feedback_items;
--
-- Expect total = owner_visible and internal = 0 immediately after the ALTER.
