-- ════════════════════════════════════════════════════════════════════
--  feedback_items.type — add 'decision' and 'hazard', internal-only.
--  Issue 247 step 2, part 1.
--
--  HELD: run this by hand (Kevin). The system is LIVE. Nothing in the app
--  can produce these values yet — the writer is step 2 part 2 — so running
--  this is inert until then, by design.
-- ════════════════════════════════════════════════════════════════════
--
-- WHY. type is CHECK-constrained to ('bug','feature'). The internal backlog
-- holds work that is neither: "Decide what happens to 9 locations marked active
-- with no Stripe record" is a decision waiting on Kevin, and "⚠️ HAZARD:
-- past-due pending touchpoints backlog" is a risk. Filing those as bugs makes
-- the open-bug count wrong, which is the one number a single tracker exists to
-- get right.
--
-- ─── THE COUPLING RULE, AND WHY IT IS A CONSTRAINT ───────────────────
--
--     A row whose type is 'decision' or 'hazard' MUST also be is_internal.
--
-- This is not tidiness. `type` IS PRESENT IN OWNER-FACING RESPONSE PAYLOADS
-- today — both owner reads select '*' — and one owner surface renders it
-- (components/feedback/feedbackShared FeedbackItemCard, the "My Items" tab,
-- prints an emoji chosen by type). So an owner-visible row carrying 'decision'
-- would ship a value their screen cannot render, in a payload they receive.
--
-- ENFORCED AS A CHECK, NOT ONLY IN THE ROUTE. Both, but the CHECK is the
-- load-bearing one, for a reason specific to right now: there is no route that
-- can set is_internal or file a decision/hazard. Hand-run SQL is currently the
-- ONLY way an internal item gets filed, so a route-level rule would today be
-- guarding a door nobody uses while the open window goes unwatched. A CHECK is
-- the only enforcement a hand-run UPDATE cannot bypass. It turns "an owner
-- might receive an unrenderable type" from a runtime possibility into a state
-- the database cannot represent.
--
-- The route-level half still earns its place (better error than a 23514, and it
-- fails before the round trip) — it belongs with the writer in part 2.
--
-- TWO CONSTRAINTS, NOT ONE. They could be a single expression; they are split
-- so the violation message names which rule was broken, which matters when the
-- filing mechanism is a human typing SQL. The domain keeps its existing name.
--
-- THE SECOND CONSTRAINT FAILS SAFE. Its form is "the owner-visible types are
-- always allowed; anything else requires is_internal". So if a fifth type is
-- ever added to the domain and nobody thinks about visibility, it is
-- internal-only by default rather than owner-visible by default. The safe
-- direction is the lazy one.
--
-- WHY `is_internal` BEING NOT NULL MATTERS HERE. A CHECK constraint PASSES when
-- its expression evaluates to NULL. If is_internal were nullable, a row with
-- type='decision' and is_internal=NULL would evaluate to `false OR NULL` = NULL
-- and be ACCEPTED — the constraint would be silently defeated by exactly the
-- rows it exists to catch. migrations/feedback_items_internal.sql declared it
-- NOT NULL DEFAULT false, so this is safe. Do not relax that column to nullable
-- without revisiting this constraint.


-- ─── DDL ─────────────────────────────────────────────────────────────
--
-- A CHECK cannot be altered in place; it must be dropped and re-added. The
-- existing constraint's name and definition, read from production rather than
-- assumed:
--
--   feedback_items_type_check
--     CHECK ((type = ANY (ARRAY['bug'::text, 'feature'::text])))
--
-- Wrapped in a transaction. If the re-add fails, the DROP must not survive on
-- its own — that would leave the table with NO type constraint, which is worse
-- than either the old state or the new one.

BEGIN;

-- 1. Widen the type domain.
ALTER TABLE feedback_items
  DROP CONSTRAINT IF EXISTS feedback_items_type_check;

ALTER TABLE feedback_items
  ADD CONSTRAINT feedback_items_type_check
  CHECK (type = ANY (ARRAY['bug'::text, 'feature'::text, 'decision'::text, 'hazard'::text]));

-- 2. The coupling: the two new types exist only on internal rows.
--    'bug' and 'feature' remain legal either way — an internally-found BUG is
--    the main case ("Jobber token rotation race" is a bug, and internal).
ALTER TABLE feedback_items
  ADD CONSTRAINT feedback_items_internal_type_check
  CHECK (
    type = ANY (ARRAY['bug'::text, 'feature'::text])
    OR is_internal
  );

COMMENT ON CONSTRAINT feedback_items_internal_type_check ON feedback_items IS
  'decision/hazard are internal-only. type appears in owner-facing payloads (both owner reads select *), so an owner-visible row must never carry a type the owner UI cannot render. Enforced in the database because hand-run SQL is currently the only way an internal item is filed. Issue 247 step 2.';

COMMIT;


-- ─── 1. THE 63 EXISTING ROWS: NOTHING HAPPENS ────────────────────────
--
-- Production today: 41 'bug' + 22 'feature' = 63, every one is_internal=false.
--
--   · Constraint 1: 'bug' and 'feature' are both still in the widened domain.
--   · Constraint 2: short-circuits true on the first branch for all 63 —
--     is_internal is never consulted.
--
-- ADD CONSTRAINT validates every existing row, and all 63 pass. No row is
-- rewritten, no value changes, no backfill. The answer is literally nothing.
-- At 63 rows the validating scan is instant; the ACCESS EXCLUSIVE lock is held
-- for microseconds.


-- ─── 2. VERIFY AFTER RUNNING ─────────────────────────────────────────
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'public.feedback_items'::regclass AND contype = 'c'
--   ORDER BY conname;
--   -- expect: feedback_items_internal_type_check,
--   --         feedback_items_status_check,
--   --         feedback_items_type_check (now 4 values)
--
--   SELECT type, is_internal, count(*) FROM feedback_items
--   GROUP BY type, is_internal ORDER BY type;
--   -- expect unchanged: bug/false 41, feature/false 22
--
-- Prove the coupling actually bites (both must ERROR with 23514):
--
--   UPDATE feedback_items SET type='decision' WHERE is_internal = false;
--   INSERT INTO feedback_items (user_id, type, title, description, is_internal)
--     VALUES ('<a hub_user uuid>', 'hazard', 't', 'd', false);


-- ─── 3. ROLLBACK ─────────────────────────────────────────────────────
--
-- SAFE ONLY WHILE NO ROW CARRIES A NEW VALUE. Run as one transaction:

--   BEGIN;
--     ALTER TABLE feedback_items
--       DROP CONSTRAINT IF EXISTS feedback_items_internal_type_check;
--     ALTER TABLE feedback_items
--       DROP CONSTRAINT IF EXISTS feedback_items_type_check;
--     ALTER TABLE feedback_items
--       ADD CONSTRAINT feedback_items_type_check
--       CHECK (type = ANY (ARRAY['bug'::text, 'feature'::text]));
--   COMMIT;
--
-- WHAT BREAKS IF IT IS RUN AFTER ROWS CARRY 'decision' OR 'hazard':
--
-- The final ADD CONSTRAINT validates existing rows, finds them, and fails:
--   ERROR: check constraint "feedback_items_type_check" of relation
--          "feedback_items" is violated by some row   (SQLSTATE 23514)
--
-- Inside the transaction above that is harmless — the whole thing rolls back
-- and the widened constraints stay in place.
--
-- RUN AS FOUR LOOSE STATEMENTS INSTEAD AND IT IS NOT HARMLESS: the two DROPs
-- each commit, the ADD fails, and the table is left with NO type constraint at
-- all. Any string then becomes a legal type, and the coupling that keeps
-- internal-only values out of owner payloads is gone with it — a strictly worse
-- state than either the old schema or the new one. The BEGIN/COMMIT is the
-- whole safety of this rollback; do not run it statement by statement.
--
-- To roll back WITH such rows present, resolve them first — inside the same
-- transaction, before the DROPs:
--
--   SELECT count(*) FROM feedback_items WHERE type IN ('decision','hazard');
--   -- then ONE of:
--   UPDATE feedback_items SET type = 'bug'
--     WHERE type IN ('decision','hazard');          -- keep the work, lose the distinction
--   DELETE FROM feedback_items WHERE type IN ('decision','hazard');   -- discard it
--
-- Note the UPDATE re-creates the exact problem this issue was opened to fix
-- (decisions and hazards counted as open bugs), so it is a deliberate trade,
-- not a clean revert.


-- ─── 4. WHO READS `type`, AND WHAT EACH DOES WITH AN UNKNOWN VALUE ───
--
-- Nothing crashes. NOTHING THROWS. Every consumer has an else-branch, which is
-- precisely the hazard: a new enum value lands as a wrong label rather than an
-- error, so it ships broken and quiet. Nine of the ten read sites fail silently.
--
-- ── Not consumers at all (checked, and worth stating) ──
--   lib/feedback-queues.ts          — does NOT read type. Its only "type" token
--                                     is `export type FeedbackQueueKey`. Queue
--                                     classification is status-only, so open
--                                     counts, the four queues, staleness and
--                                     the nav badge are ALL unaffected.
--   components/feedback/OwnerFeedbackScreen.jsx
--                                   — does NOT read item.type. The owner screen
--                                     renders nothing from it (it still RECEIVES
--                                     it — see §5).
--   PATCH /api/admin/feedback/[id]  — does not accept `type` in its body at all
--                                     (only status, admin_response). type is
--                                     effectively immutable after insert.
--
-- ── SILENT (9) ──
--  a. app/api/admin/feedback/route.ts:82   ?type= filter
--       `if (type && VALID_TYPES.has(type)) query = query.eq('type', type)`
--       An unknown value DROPS THE FILTER and returns the unfiltered list.
--       Asking for decisions silently returns everything. Worst of the nine:
--       a wrong RESULT SET, not just a wrong label.
--  b. AdminFeedbackScreen.jsx:550  matchType = (i,t) => t==='all' || i.type===t
--       decision/hazard match 'all' but neither 'bug' nor 'feature', so the tab
--       counts stop summing: Bugs + Ideas < Everything. Exactly the class of
--       disagreeing counts issue 233 existed to end.
--  c. AdminFeedbackScreen.jsx:605-606      type tabs hardcode bug + feature.
--       New types have no tab and are unreachable by filter.
--  d. AdminFeedbackScreen.jsx:261,306-307  detail modal `bug ? IconBug : IconBulb`
--       → renders the LIGHTBULB. A hazard looks like an idea.
--  e. AdminFeedbackScreen.jsx:755,770-771  list row, same binary → lightbulb.
--  f. components/feedback/feedbackShared.jsx:115  FeedbackItemCard
--       `item.type === 'bug' ? '🐛' : '✨'` → sparkles.
--       OWNER-REACHABLE SURFACE (the FeedbackModal "My Items" tab) — see §5.
--  g. components/admin/SystemHealthScreen.jsx:373
--       `label={item.type === 'bug' ? 'bug' : 'feature'}`
--       → does not merely fail to render it, it PRINTS THE WORD "feature" on a
--         hazard. Renders a lie rather than an unknown.
--  h. components/hive/HomeSystemHealth.jsx:336 — identical expression, same lie.
--  i. lib/feedback-reply-email.ts:119  `const feature = itemType === 'feature'`
--       decision/hazard take the "problem" wording. Reachable only if triage
--       replies to an internal item filed by someone else (rule 4's self-notify
--       guard covers Kevin replying to his own).
--
-- ── LOUD (1) ──
--  j. app/api/feedback/route.ts:113  POST validator
--       `if (!VALID_TYPES.has(type)) return 400 type_must_be_bug_or_feature`
--       Hard reject. This is the OWNER filing path and it MUST STAY as-is —
--       see §6.
--
-- NONE OF a–i IS A BLOCKER FOR THIS MIGRATION, because until part 2 ships a
-- writer no row can carry the new values. They are the part-2 checklist: (a),
-- (b) and (c) are the ones that produce wrong NUMBERS; (g) and (h) are the ones
-- that produce a wrong WORD on a corp screen. All are corp-facing except (f).


-- ─── 5. IS `type` IN OWNER-FACING PAYLOADS? YES ──────────────────────
--
-- Both owner reads select the whole row:
--   GET /api/admin/feedback  → .select('*, submitter:…, location:…')  ← owner screen
--   GET /api/feedback        → .select('*')                            ← "My Items" tab
--
-- So `type` is on the wire to an owner today, and consumer (f) above RENDERS it
-- as an emoji. This is why the brief's instinct is right and why the coupling is
-- a constraint rather than a convention: the new values have to be UNREACHABLE
-- in those payloads, not merely unrendered.
--
-- They are made unreachable by composition, and it needs both halves:
--   · issue 247 step 1 filters `is_internal = false` server-side on both reads;
--   · feedback_items_internal_type_check guarantees decision/hazard ⇒ is_internal.
-- Therefore decision/hazard ⇒ is_internal ⇒ excluded from every owner read.
-- Neither half alone is sufficient: without the constraint a hand-run UPDATE can
-- set type='hazard' while leaving is_internal=false, and that row is served to
-- the owner with a type their UI turns into ✨.


-- ─── 6. WRITE PATHS THAT MUST ACCEPT THE NEW VALUES ──────────────────
--
-- The enumeration (the issue-240 / issue-246 sweep, done for `type`). There is
-- NO zod and no schema library anywhere in the feedback paths — every validator
-- is hand-rolled, so each one is its own silent-drop candidate.
--
-- ALL writers to feedback_items, complete:
--   1. app/api/feedback/route.ts:175          INSERT   ← the only insert
--   2. app/api/admin/feedback/[id]/route.ts:202  UPDATE  status/admin_response only
--   3. app/api/feedback/seen/route.ts:53      UPDATE   reply_seen_at only
--   (4. hand-run SQL — today the ONLY path that can produce an internal row)
--
-- Layer by layer:
--
--   POST /api/feedback  VALID_TYPES = new Set(['bug','feature'])   [route.ts:21]
--     MUST NOT BE WIDENED. This is the owner filing path; the brief requires an
--     owner can never file a decision or hazard. Leaving it is the enforcement,
--     not an oversight. LOUD (400) if anyone tries.
--
--   FeedbackModal.jsx:201  the type picker
--     Hardcodes [{k:'bug'},{k:'feature'}]. MUST NOT GAIN the new options — "never
--     see the words in any picker". Also FeedbackModal.jsx:33,140 default to
--     'bug', and BeeHub.jsx:35792's report-a-problem seed pins type:'bug'. All
--     three stay.
--
--   PATCH /api/admin/feedback/[id]
--     Does not accept `type` at all. So a mis-typed row cannot be corrected
--     through the app by anyone, including super_admin — only by hand SQL.
--     Whether part 2 opens this up is a decision, not an oversight; note that
--     doing so requires the coupling to be re-checked in the route, because a
--     PATCH could otherwise move an internal row's type while is_internal stays
--     put. The CHECK would catch it, as a 23514 rather than a clean 400.
--
--   GET /api/admin/feedback  VALID_TYPES  [route.ts:38]
--     Read-side, but the SAME constant name in a different file with a different
--     job. Widening it makes ?type=decision filter correctly; leaving it keeps
--     silent-drop (a). It is corp-only, so widening it is safe — but it must be
--     widened SEPARATELY and deliberately, because the two VALID_TYPES sets now
--     mean different things: one is "what an owner may file", the other is "what
--     may be filtered on". They are only accidentally equal today, and part 2
--     will make them genuinely different. Do not refactor them into one shared
--     constant.
--
-- NET: this migration requires NO code change to be safe to run. Exactly one
-- write path exists that could produce the new values, and it is hand-run SQL,
-- which the CHECK now polices.
