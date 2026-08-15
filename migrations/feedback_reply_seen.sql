-- "Has this person actually seen the reply we wrote them?" — issue 235.
--
-- WHY A COLUMN AND NOT A CLIENT-SIDE FLAG. Nothing in the product tracks read
-- state today, so the new "What you've told us" screen has no way to say "two
-- new replies" without inventing one. The two cheap alternatives both lie:
--
--   · localStorage — per DEVICE. This audience reads the reply notification on
--     a phone and works in Bee Hub on a desktop, so the surface where the
--     banner matters most is exactly the one that would never have the flag.
--   · a single "last visited feedback" stamp on hub_users — one bit for the
--     whole screen. It cannot mark an individual item, so a second reply on an
--     older report is indistinguishable from one already read.
--
-- THE PREDICATE this column exists to answer:
--
--   unread  =  admin_response_at IS NOT NULL
--              AND (reply_seen_at IS NULL OR reply_seen_at < admin_response_at)
--
-- The second clause is the reason this is a TIMESTAMP and not a boolean: when
-- triage replies a SECOND time on an item the submitter already read, the new
-- reply must go back to unread. A boolean would stay "read" forever and the
-- owner would never learn we wrote again.
--
-- SEMANTICS: this means "the SUBMITTER has seen it", never "somebody at this
-- location opened the screen". The stamping route (POST /api/feedback/seen)
-- filters to user_id = the caller, so an owner reading a colleague's answered
-- item cannot clear that colleague's banner.
--
-- BACKFILL: deliberately NONE. Forty-seven replies were written in production
-- and delivered to nobody (issue 233 found this; zero feedback_reply emails had
-- been sent when issue 235 was built). Those replies are genuinely unread, so
-- leaving every row NULL is the accurate state, not a convenience. The
-- consequence is real and intended: the first time an owner opens the new
-- screen, every answer they were never told about is waiting for them, and the
-- Palm Beach owner — answered twenty-six times, told zero times — sees all of
-- them. That is the point of the screen, not a side effect to be smoothed over.
--
-- FAILS SOFT UNTIL RUN: the screen detects the column's absence and simply
-- shows no banner, in the same spirit as insertFeedbackRow's contextDropped
-- path. Nothing 500s and no reply is hidden — the reply text itself renders
-- from admin_response, which has always existed. Running this only turns the
-- "new" marker on.

ALTER TABLE feedback_items
  ADD COLUMN IF NOT EXISTS reply_seen_at timestamptz;

COMMENT ON COLUMN feedback_items.reply_seen_at IS
  'When the SUBMITTER last viewed the team reply on this item (issue 235). NULL = never seen. Compared against admin_response_at, so a newer reply re-marks the item unread. Stamped only by POST /api/feedback/seen, filtered to the caller''s own rows.';

-- No index. feedback_items is ~63 rows in production and every read of this
-- column is already inside a per-location or per-user filtered set; an index
-- here would be ceremony, not performance.
