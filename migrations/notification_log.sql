-- ═══════════════════════════════════════════════════════════════════════════
-- Notification Log — the outbound-mail notebook. One row per RECIPIENT per
-- send, recording who/what/when and whether Resend accepted the message.
--
-- Schema only. NOT YET APPLIED — run manually in the Supabase SQL editor after
-- review (standing migration-files-need-review rule). Additive: one new table,
-- no changes to existing objects. Idempotent — CREATE TABLE / INDEX IF NOT
-- EXISTS, safe to re-run.
--
-- SHIPS-BEFORE-THE-TABLE. The writing code (lib/notification-log.ts) is
-- deliberately fail-safe: a missing table surfaces as a PostgREST "relation
-- does not exist" error on insert, which logNotification swallows with a
-- console.warn. So the code can (and does) deploy before this migration runs —
-- sends keep working, they just aren't recorded until this lands.
--
-- HOOK POINT. Rows are written from lib/resend.ts sendEmailDirect(), i.e. the
-- RESEND LAYER — not from any one feature. So invites, magic-links, drips AND
-- lead notifications all log automatically. Lead-notification sends pass richer
-- context (lead_id/lead_name/location_id/location_slug); system mail does not.
-- That is why every context column is NULLABLE: a null lead_id on an invite row
-- is the expected, correct state, not missing data.
--
-- GRAIN — one row per RECIPIENT, not per message. notifyNewLead sends ONE
-- Resend message addressed to N recipients; that becomes N rows sharing one
-- resend_message_id. This is why resend_message_id is INDEXED, NOT UNIQUE — a
-- unique constraint here would reject every multi-recipient send after the
-- first row. Half B (the Resend delivery webhook) will look up rows BY
-- resend_message_id and may legitimately update several at once.
--
-- CHECK CONSTRAINTS carry ONLY values the code actually writes today. The
-- sync_log lesson (entity_type CHECK omitted 'lead', silently rejecting rows
-- for months) is the reason: a CHECK listing aspirational values is harmless,
-- but one MISSING a value the code writes is a silent data-loss bug. If a new
-- send_status / channel / email_kind is introduced, extend the CHECK in the
-- same change as the code.
--
--   channel        'email' | 'slack'   — the two send rails that log today.
--   send_status    'accepted'          — Resend took it and returned a message id
--                  'failed'            — Resend errored, threw, or returned no id
--                  'zero_recipients'   — nobody subscribed; nothing was sent
--   email_kind     free TEXT, NO CHECK — deliberately unconstrained. It is a
--                  descriptive label passed by callers ('lead_notification',
--                  'invite', 'magic_link', 'drip'), and a new caller inventing a
--                  new kind must NEVER have its row rejected. Filterable in the
--                  admin screen via DISTINCT, not via a constraint.
--
-- DELIVERY COLUMNS (delivery_status / delivery_updated_at) are written by
-- NOTHING in Half A — they exist now so Half B is a pure code change with no
-- second migration. Every row lands with delivery_status NULL, meaning "we know
-- Resend accepted it; we don't yet know if it landed". Slack rows stay NULL
-- FOREVER: there is no Slack delivery webhook, so absence of a delivery status
-- on a Slack row is permanent and correct, not pending.
--
-- RETENTION. Unbounded for now — volume is low (a handful of sends per lead)
-- and the admin screen reads a capped window, so table growth doesn't degrade
-- the UI. Revisit with a created_at-partitioned purge if this ever gets big.
--
-- NO RLS. This table is written ONLY by the service-role client and read ONLY
-- through app/api/admin/notification-log/route.ts, which gates on
-- super_admin/admin server-side before touching supabaseService (service role
-- bypasses RLS anyway, so the route IS the gate). No authenticated client ever
-- selects this table directly, so there is no policy to defend. It carries
-- recipient email addresses + subject lines — do NOT expose it to a
-- browser-facing anon/authenticated read path without adding RLS first.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.notification_log (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- ── Context (nullable by design — system mail carries none of it) ────────
  -- ON DELETE SET NULL, never CASCADE: deleting a lead must not erase the
  -- record that we emailed people about it. The row survives as an orphan with
  -- lead_name still readable — that denormalized copy is the whole point.
  lead_id             uuid        REFERENCES public.leads(id)     ON DELETE SET NULL,
  lead_name           text,
  location_id         uuid        REFERENCES public.locations(id) ON DELETE SET NULL,
  location_slug       text,

  -- ── The send itself ──────────────────────────────────────────────────────
  channel             text        NOT NULL CHECK (channel IN ('email', 'slack')),
  recipient           text,       -- one email address; NULL on slack + zero_recipients rows
  subject             text,
  email_kind          text,       -- descriptive label, intentionally unconstrained

  send_status         text        NOT NULL
                                  CHECK (send_status IN ('accepted', 'failed', 'zero_recipients')),
  resend_message_id   text,       -- NULL unless send_status = 'accepted' on an email row
  error               text,       -- populated on 'failed'

  -- ── Half B (delivery webhook) — reserved, written by nothing yet ─────────
  delivery_status     text        CHECK (delivery_status IN
                                    ('delivered', 'bounced', 'complained',
                                     'deferred', 'opened', 'clicked')),
  delivery_updated_at timestamptz
);

-- Half B's lookup key: webhook payload carries the message id → find its rows.
-- NOT unique (see the grain note above).
CREATE INDEX IF NOT EXISTS notification_log_resend_message_id_idx
  ON public.notification_log (resend_message_id);

-- The admin screen's default read: newest-first over a bounded window.
CREATE INDEX IF NOT EXISTS notification_log_created_at_idx
  ON public.notification_log (created_at DESC);

-- The admin screen's location filter, in the same newest-first order.
CREATE INDEX IF NOT EXISTS notification_log_location_created_at_idx
  ON public.notification_log (location_id, created_at DESC);

-- ── Post-apply verification (run after) ─────────────────────────────────────
-- Expect: 1 table, 3 indexes, 3 CHECK constraints.
--
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'notification_log' ORDER BY ordinal_position;
--
-- SELECT indexname FROM pg_indexes WHERE tablename = 'notification_log';
--
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.notification_log'::regclass AND contype = 'c';
--
-- Then send any email (invite a user, or POST a test lead) and confirm rows
-- land — before this migration the same send logged nothing and stayed silent:
-- SELECT created_at, channel, email_kind, send_status, recipient, subject
--   FROM public.notification_log ORDER BY created_at DESC LIMIT 20;
