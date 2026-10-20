-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/slack_cards.sql — which Slack message is which lead's card
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: WRITTEN, NOT RUN.
--
-- WHY. Other's route-suggestion card (lib/route-suggestion-slack.ts) must be
-- edited when its lead leaves Other by ANY route — routed in Bee Hub, binned,
-- dismissed, snoozed, no-coverage sent, moved to the Network — so the channel
-- never fills with cards whose buttons act on leads that are already handled.
-- Slack edits a message by its channel + message id ("ts"), and until now
-- Bee Hub threw that id away. One row per card posted.
--
-- WHO WRITES IT (lib/other-card-sync.ts):
--   · a row when Other's card posts (intake, scripts/post-other-cards.mjs)
--   · resolved_at / resolution / resolved_line when the card is edited —
--     by a button press, an exit hook, or the sweep (/api/cron/other-cards)
-- A card whose lead comes BACK into Other (dismiss undone, restored from the
-- bin, snooze over) is left resolved, and the sweep posts a fresh card — a new
-- row.
--
-- NO CUSTOMER DATA beyond the lead id; the card's words live in Slack.
--
-- UNDO: migrations/slack_cards_undo.sql drops the table. Cards already posted
-- stay in Slack; Bee Hub just stops editing them.
--
-- NO POLICIES. RLS on with no policy: browser clients read nothing. The
-- service-role client (server code only) bypasses RLS.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.slack_cards (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id        uuid        NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  -- The location whose Slack the card is in (Other), for its bot token.
  location_uuid  uuid        NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  channel_id     text        NOT NULL,
  message_ts     text        NOT NULL,
  posted_at      timestamptz NOT NULL DEFAULT now(),
  -- NULL = the card still shows live buttons.
  resolved_at    timestamptz NULL,
  -- What happened: moved / binned / dismissed / snoozed / no_coverage /
  -- network / left_in_other / archived / has_engagement / in_jobber / gone.
  resolution     text        NULL,
  -- The line the card now shows, e.g. "✅ Moved to Lincoln by Leslie Mullins."
  resolved_line  text        NULL,
  CONSTRAINT slack_cards_message_key UNIQUE (channel_id, message_ts)
);

-- "Which cards for this lead still have live buttons" — every exit hook asks.
CREATE INDEX IF NOT EXISTS slack_cards_lead_open_idx
  ON public.slack_cards (lead_id) WHERE resolved_at IS NULL;

ALTER TABLE public.slack_cards ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.slack_cards IS
  'One row per Slack route-suggestion card posted for a lead in Other, so it can be edited when the lead leaves Other (lib/other-card-sync.ts).';
