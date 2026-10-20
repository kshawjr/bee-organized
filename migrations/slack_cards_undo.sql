-- migrations/slack_cards_undo.sql
--
-- Undoes migrations/slack_cards.sql: drops the slack_cards table. The cards
-- already posted stay in Slack exactly as they are; Bee Hub just stops
-- editing them, and lib/other-card-sync.ts skips its work (every read and
-- write there is fail-soft, so nothing that calls it breaks).

DROP TABLE IF EXISTS public.slack_cards;
