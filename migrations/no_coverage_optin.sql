-- migrations/no_coverage_optin.sql
--
-- PURPOSE
--   Backs the Inbox's "No coverage" action: corp tells an unroutable lead we
--   don't serve their area yet, and offers a link to join a mailing list for
--   when we do. Clicking that link is the consent act, and consent has to be
--   RECORDED — when it happened AND how it was obtained.
--
--   Why new columns rather than reusing what's there:
--     leads.marketing_opt_out is absence-of-refusal, not consent. A row with
--     marketing_opt_out = false has never affirmed anything; it merely hasn't
--     objected. CAN-SPAM/CASL-grade record-keeping needs the positive act,
--     its timestamp, and its provenance. There is no opt-IN field on leads
--     today, so this adds one.
--
--   Timestamp-as-flag (marketing_consented_at) rather than a boolean, matching
--   the leads.inbox_dismissed_at idiom already in this schema: it
--   self-documents WHEN, and "not consented" is simply NULL.
--
--   marketing_consent_source is the "how" — the provenance string the
--   compliance answer actually turns on. Today's only writer passes
--   'no_coverage_optin_email'. Deliberately un-CHECKed text: a future consent
--   door (a web form, a reply-to-subscribe) must be able to record its own
--   provenance without a migration, exactly like notification_log.email_kind.
--
--   optin_token / optin_token_expires_at mirror the invite rail
--   (pending_invites.invite_token + invite_expires_at): a 48-hex random token
--   is the ONLY key in the emailed URL — no lead id, no email address, no PII
--   in a link that will sit in an inbox and a browser history forever. The
--   token is NOT one-time: the public page is idempotent, so a second click
--   re-renders the confirmation instead of erroring. Expiry bounds the window
--   in which a leaked link can create a new consent record.
--
-- SCOPE
--   Four nullable columns on `leads` + one partial index for the token lookup.
--   No data is written, no existing column is read or altered, no RLS policy
--   changes. The public opt-in page reads through the SERVICE role (the click
--   is anonymous — there is no session to scope by), so the existing leads RLS
--   is untouched and stays as restrictive as it is today.
--
-- ORDER OF OPERATIONS
--   Run the read-only count FIRST, on its own, and keep the number. It is the
--   before-picture: every one of these columns must be NULL on every row after
--   the ALTER, and the app is the only thing that may ever populate them.
--
-- Run in the Supabase SQL editor. Safe to re-run (IF NOT EXISTS throughout).

-- ─── 1. READ-ONLY — run this alone, first, and record the output ────────────
-- Expect: total = today's lead count; the other three = 0 both before AND
-- immediately after the ALTER below. A non-zero consented/tokened count after
-- the ALTER means a column name collided with something that already existed.
SELECT
  count(*)                                        AS total_leads,
  count(*) FILTER (WHERE marketing_opt_out)       AS opted_out,
  0                                               AS consented_expected_before,
  0                                               AS tokened_expected_before
FROM leads;


-- ─── 2. THE CHANGE ──────────────────────────────────────────────────────────
ALTER TABLE leads
  -- WHEN consent was given. NULL = never consented. Doubles as the flag.
  ADD COLUMN IF NOT EXISTS marketing_consented_at    timestamptz,
  -- HOW it was obtained. e.g. 'no_coverage_optin_email'. No CHECK — a new
  -- consent door must be able to name itself without a migration.
  ADD COLUMN IF NOT EXISTS marketing_consent_source  text,
  -- The emailed link's only key. Random hex, never derived from lead data.
  ADD COLUMN IF NOT EXISTS optin_token               text,
  -- Bounds the window in which a leaked link can create a consent record.
  ADD COLUMN IF NOT EXISTS optin_token_expires_at    timestamptz;

-- Token lookup index. Partial (WHERE optin_token IS NOT NULL) because the vast
-- majority of leads will never carry one — this indexes the handful that do.
--
-- NOT UNIQUE, deliberately: uniqueness would have to be enforced against a
-- 48-hex random space where collision is not a real failure mode, and a UNIQUE
-- constraint here would turn a re-send race into a 23505 on the send path.
-- The lookup uses .maybeSingle() and treats a miss as "link no longer active".
CREATE INDEX IF NOT EXISTS idx_leads_optin_token
  ON public.leads (optin_token)
  WHERE optin_token IS NOT NULL;


-- ─── 3. VERIFY (read-only) ──────────────────────────────────────────────────
-- total_leads must match step 1. The other three must all be 0 — nothing here
-- backfills, and the app is the only writer.
SELECT
  count(*)                                            AS total_leads,
  count(*) FILTER (WHERE marketing_consented_at IS NOT NULL) AS consented,
  count(*) FILTER (WHERE marketing_consent_source IS NOT NULL) AS sourced,
  count(*) FILTER (WHERE optin_token IS NOT NULL)     AS tokened
FROM leads;


-- ─── 4. ROLLBACK ────────────────────────────────────────────────────────────
-- Reversible with no data loss for anything that predates this migration —
-- the columns are new and nothing else reads them.
--
-- CAUTION: after the feature has been live, dropping marketing_consented_at /
-- marketing_consent_source DESTROYS the consent record. That record is the
-- evidence that a marketing send was permitted. Export it before dropping:
--
--   SELECT id, email, marketing_consented_at, marketing_consent_source
--     FROM leads
--    WHERE marketing_consented_at IS NOT NULL;
--
-- DROP INDEX IF EXISTS public.idx_leads_optin_token;
-- ALTER TABLE leads
--   DROP COLUMN IF EXISTS optin_token_expires_at,
--   DROP COLUMN IF EXISTS optin_token,
--   DROP COLUMN IF EXISTS marketing_consent_source,
--   DROP COLUMN IF EXISTS marketing_consented_at;
