-- migrations/marketing_unsubscribe.sql
--
-- PURPOSE
--   The inverse of migrations/no_coverage_optin.sql: that migration let a
--   person JOIN the mailing list; this one lets them LEAVE it. Backs the
--   public unsubscribe page (app/unsubscribe/[token]) and the send-time
--   consent gate (lib/marketing-consent). CAN-SPAM requires a working
--   unsubscribe mechanism in every marketing email — this is its storage.
--
-- WHY A SEPARATE TOKEN, not a second action on optin_token:
--   Reuse looks cheap — the cohort already carries optin_token — but the two
--   tokens have OPPOSITE lifecycle requirements and reuse makes the two public
--   pages fight each other:
--     · optin_token EXPIRES (45 days) to bound the window a leaked link can
--       CREATE a consent record. An unsubscribe link must do the reverse: work
--       essentially forever (CAN-SPAM demands ≥30 days after each send, and a
--       person forwarding a year-old email still deserves a working way out).
--       One column cannot be both expiring and non-expiring.
--     · optin_token is OVERWRITTEN on a no-coverage re-send ("a retry simply
--       overwrites it") — reuse would silently break the unsubscribe link in
--       every marketing email already delivered.
--     · The same token resolving to "join" on one route and "leave" on another
--       means a mail-client prefetching both links in one message could toggle
--       the person's consent state twice in one render pass.
--   So: its own column, minted at most once per lead (first-mint-wins, see
--   ensureUnsubscribeToken), stable for the life of the lead, NO expiry column.
--   Leak risk runs the safe direction — the token's only power is "stop
--   emailing this person".
--
-- HOW "UNSUBSCRIBED" IS RECORDED — both columns, deliberately:
--     · marketing_opt_out = true    — the DO-NOT-SEND flag. It already exists
--       and is already honored at send time by every rail (drip-send ~114,
--       stage-emails, welcome-email) and cascaded by drip-lifecycle ~405.
--       Setting it means every existing and future sender that follows the
--       house pattern refuses this lead with no second mechanism to build.
--     · marketing_unsubscribed_at   — WHEN the person withdrew, the withdrawal
--       counterpart of marketing_consented_at. Doubles as the public page's
--       idempotency flag (set → re-render the confirmation, write nothing).
--   marketing_consented_at is NOT cleared: it is the historical record that a
--   send made BEFORE the withdrawal was permitted. Consent-then-withdrawal is
--   two events; erasing the first to record the second destroys the evidence
--   the first sends relied on. "May we send NOW?" is answered by the gate:
--   consented AND NOT opted out.
--
-- SCOPE
--   Two nullable columns on `leads` + one partial index. No data written, no
--   existing column altered, no RLS change (the public page reads through the
--   SERVICE role exactly like the opt-in page — the click is anonymous).
--
-- ORDER OF OPERATIONS
--   Run the read-only count FIRST, alone, and keep the number: both new
--   columns must be NULL on every row after the ALTER; the app is the only
--   writer.
--
-- Run in the Supabase SQL editor. Safe to re-run (IF NOT EXISTS throughout).

-- ─── 1. READ-ONLY — run this alone, first, and record the output ────────────
-- Expect: total = today's lead count; opted_out = however many staff-set
-- opt-outs exist (that flag predates this migration); the last two are 0 both
-- before AND immediately after the ALTER. Non-zero after = name collision.
SELECT
  count(*)                                        AS total_leads,
  count(*) FILTER (WHERE marketing_opt_out)       AS opted_out,
  0                                               AS unsubscribed_expected_before,
  0                                               AS tokened_expected_before
FROM leads;


-- ─── 2. THE CHANGE ──────────────────────────────────────────────────────────
ALTER TABLE leads
  -- The unsubscribe link's only key. Random 48-hex, never derived from lead
  -- data, minted at most once (first-mint-wins) and then stable forever.
  -- Deliberately NO expiry column — see the header.
  ADD COLUMN IF NOT EXISTS unsubscribe_token          text,
  -- WHEN the person withdrew. NULL = never unsubscribed. The withdrawal
  -- counterpart of marketing_consented_at, and the page's idempotency flag.
  ADD COLUMN IF NOT EXISTS marketing_unsubscribed_at  timestamptz;

-- Token lookup index. Partial for the same reason as idx_leads_optin_token:
-- most leads never carry one. NOT UNIQUE for the same reason too: 48-hex
-- collision is not a real failure mode, and the lookup uses .maybeSingle()
-- treating a miss as "link no longer active".
CREATE INDEX IF NOT EXISTS idx_leads_unsubscribe_token
  ON public.leads (unsubscribe_token)
  WHERE unsubscribe_token IS NOT NULL;


-- ─── 3. VERIFY (read-only) ──────────────────────────────────────────────────
-- total_leads must match step 1. tokened and unsubscribed must both be 0 —
-- nothing here backfills, and the app is the only writer.
SELECT
  count(*)                                                     AS total_leads,
  count(*) FILTER (WHERE unsubscribe_token IS NOT NULL)        AS tokened,
  count(*) FILTER (WHERE marketing_unsubscribed_at IS NOT NULL) AS unsubscribed
FROM leads;


-- ─── 4. ROLLBACK ────────────────────────────────────────────────────────────
-- CAUTION: after the feature is live, marketing_unsubscribed_at IS the record
-- that a person withdrew consent — dropping it destroys the evidence CAN-SPAM
-- compliance turns on (marketing_opt_out keeps them un-mailable, but the WHEN
-- and the fact it was THEIR act are gone). Export before dropping:
--
--   SELECT id, email, marketing_unsubscribed_at
--     FROM leads
--    WHERE marketing_unsubscribed_at IS NOT NULL;
--
-- DROP INDEX IF EXISTS public.idx_leads_unsubscribe_token;
-- ALTER TABLE leads
--   DROP COLUMN IF EXISTS marketing_unsubscribed_at,
--   DROP COLUMN IF EXISTS unsubscribe_token;
