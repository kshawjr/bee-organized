-- ═══════════════════════════════════════════════════════════════════════════
-- notifications_live — the per-location mute switch for Bee Hub's new-lead
-- notifications (email + Slack).
--
-- Schema + seed. NOT YET APPLIED — run manually in the Supabase SQL editor
-- after review (standing migration-files-need-review rule). Additive: one new
-- column, one widened CHECK, one seed UPDATE. No existing column is altered,
-- nothing is dropped, no data is destroyed. Idempotent — ADD COLUMN IF NOT
-- EXISTS + a CHECK swap guarded by DROP ... IF EXISTS, safe to re-run.
--
-- WHY. During the Zoho-parallel migration Zoho still notifies everyone. Bee Hub
-- notifying too = DOUBLE notification for the 44 onboarding locations. Every
-- one of those 44 already has seeded recipients from the earlier top-up, so
-- "has recipients" cannot be the gate — recipients are exactly what they have.
-- This flag is the gate. Kevin flips locations live one at a time as they cut
-- over off Zoho.
--
-- THE RULE the app enforces (both must be true to send):
--   locations.notifications_live = true  AND  the location resolves ≥1 recipient.
--
-- ── RUN BOTH BLOCKS TOGETHER. THIS IS THE POINT OF THE TRANSACTION. ─────────
-- The column defaults to false, so the instant block 1 commits, EVERY location
-- is muted — including the 6 that are live and correctly emailing today. Block
-- 2 is what un-mutes them. Run block 1 alone and the 6 live locations go dark
-- for however long passes before you run block 2: real leads land, drips fire,
-- the Inbox fills, and nobody gets the heads-up email. That window is the only
-- way this change can hurt a working location, and the BEGIN/COMMIT below is
-- what removes it. Do not split these blocks into two editor runs.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Block 1: the column ─────────────────────────────────────────────────────
-- DEFAULT false is the safe default and the deliberate one: a location created
-- tomorrow (a new franchise mid-migration) starts muted and stays muted until
-- someone decides otherwise. The failure mode of a wrong default here is
-- asymmetric — a missed internal heads-up is recoverable (the lead is still
-- captured, still in the Inbox, still dripping), a double-notification is an
-- email that has already left. Default to the recoverable side.
--
-- NOT NULL because the app treats this as a boolean, not a tri-state. There is
-- no meaningful "unknown" — a location is either cleared to notify or it isn't.
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS notifications_live boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.locations.notifications_live IS
  'Gate for Bee Hub new-lead notifications (email + Slack). false = muted: '
  'leads still land, drip still enrolls, the Inbox still shows them — only the '
  'outbound notification is suppressed, and the suppression is recorded in '
  'notification_log with send_status = ''muted''. Set true only when the '
  'location has cut over off Zoho, or it will double-notify.';

-- ── Block 1b: notification_log.send_status gains 'muted' ────────────────────
-- REQUIRED, not optional. notification_log.sql's own rule: "If a new
-- send_status / channel / email_kind is introduced, extend the CHECK in the
-- same change as the code." A muted send writes send_status='muted'; without
-- this widening every one of those rows is rejected by the CHECK, and
-- logNotification swallows insert failures by design — so the suppression
-- would be invisible in exactly the notebook built to make it visible. That is
-- the sync_log entity_type bug (a CHECK missing a value the code writes)
-- reproduced verbatim. Widening it here is what prevents that.
--
-- 'muted' is an OUTCOME, which is why it belongs on send_status and not on
-- email_kind. A muted row's email_kind stays 'lead_notification' — it IS a
-- lead notification; the kind axis says what it was, the status axis says what
-- happened to it. Encoding the outcome in the kind would conflate the two and
-- silently drop muted rows out of the admin screen's kind filter.
--
-- Drop-then-add rather than ALTER: Postgres has no ALTER CONSTRAINT for a
-- CHECK's expression. This is a widening — every value that passed before
-- still passes — so no existing row can be invalidated by it.
ALTER TABLE public.notification_log
  DROP CONSTRAINT IF EXISTS notification_log_send_status_check;

ALTER TABLE public.notification_log
  ADD CONSTRAINT notification_log_send_status_check
  CHECK (send_status IN ('accepted', 'failed', 'zero_recipients', 'muted'));

-- ── Block 2: seed the 6 live locations ──────────────────────────────────────
-- These 6 are notifying correctly today and must keep notifying without a gap.
-- Everything not named here — the 44 onboarding locations AND loc_other — stays
-- false by default. loc_other is deliberate and not an oversight: Leslie is
-- covered by Zoho, and loc_other already suppresses drip while still emailing,
-- so it is precisely the kind of location that would double-notify.
--
-- Enumerated by slug (locations.location_id is the slug, NOT the uuid). An
-- explicit IN list rather than a lifecycle_status predicate: 'active' is a
-- lifecycle fact, this is a cutover decision, and the two are not the same
-- question. Binding the seed to lifecycle_status would silently un-mute the
-- next location that flips active — which is the exact accident this whole
-- flag exists to prevent.
UPDATE public.locations
   SET notifications_live = true
 WHERE location_id IN (
   'loc_test',
   'loc_portland',
   'loc_nwarkansas',
   'loc_palmbeach',
   'loc_omaha',
   'loc_temecula'
 );

COMMIT;

-- ── Post-apply verification (run after) ─────────────────────────────────────
-- Expect EXACTLY 6 rows, and they must be the 6 named above. If this returns
-- fewer than 6, a slug in the list above does not match a real location — fix
-- the slug and re-run block 2, because the missing one is a live location
-- sitting dark right now.
--
-- SELECT location_id, name, lifecycle_status, notifications_live
--   FROM public.locations
--   WHERE notifications_live = true
--   ORDER BY location_id;
--
-- The other side of the same check — expect ~45 (the 44 + loc_other), all false:
--
-- SELECT count(*) FILTER (WHERE notifications_live) AS live,
--        count(*) FILTER (WHERE NOT notifications_live) AS muted,
--        count(*) AS total
--   FROM public.locations;
--
-- Confirm the widened CHECK took:
--
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname = 'notification_log_send_status_check';
--
-- Then POST a test lead to a MUTED location and confirm the suppression is
-- recorded rather than merely absent — this is the whole observability claim:
--
-- SELECT created_at, channel, email_kind, send_status, location_slug, error
--   FROM public.notification_log
--   WHERE send_status = 'muted' ORDER BY created_at DESC LIMIT 20;
--
-- ── Rollback ────────────────────────────────────────────────────────────────
-- Un-gating everything (restores today's no-gate behavior in one statement):
--   UPDATE public.locations SET notifications_live = true;
-- Full revert (only if the feature is abandoned — drops the flag entirely):
--   ALTER TABLE public.locations DROP COLUMN IF EXISTS notifications_live;
-- The widened CHECK needs no rollback: it is strictly permissive, and leaving
-- it in place costs nothing even if the flag column goes away.
