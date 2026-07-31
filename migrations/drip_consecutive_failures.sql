-- #73 — retry-cap backstop for the drip engine.
--
-- Terminal send failures (invalid recipient) now stop a lead's drip
-- immediately (lib/drip-send.ts, stopped_reason='invalid_recipient'). This
-- column is the BACKSTOP for everything the terminal classifier misses: after
-- MAX_CONSECUTIVE_SEND_FAILURES (5) consecutive TRANSIENT failures on the same
-- lead+step, the engine stops the drip with stopped_reason='max_send_retries'
-- so no unclassified failure mode can rack up hundreds of retries the way the
-- two seeded test leads did (259 / 257 hourly failures).
--
-- Counts CONSECUTIVE failures: incremented on each transient failure, reset to
-- 0 on the next successful send.
--
-- HELD — Kevin runs this in the Supabase SQL editor. The cap code degrades
-- gracefully while the column is absent (the read errors and is swallowed, so
-- the cap is simply inert); terminal-stop and per-tick retry are unaffected.
-- Nothing else ships dark: this is the only piece gated on the migration.
--
-- NOT NULL DEFAULT 0 backfills every existing progress row to 0, so a
-- currently-stuck row starts its count fresh from the first post-migration tick.

alter table lead_drip_progress
  add column if not exists consecutive_failures int not null default 0;
