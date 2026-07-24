-- Stripe webhook idempotency + audit (subscription milestone 1).
--
-- Layer 1 of replay protection: every verified Stripe event is inserted
-- here FIRST, keyed on Stripe's event id. A duplicate insert (23505)
-- means Stripe re-delivered an event we already processed — the webhook
-- returns 200 without touching anything else.
--
-- Layer 2 lives on billing_invoices: the partial UNIQUE index below
-- makes the same payment_intent unrecordable twice, which also catches
-- the same checkout session arriving via two different event types
-- (checkout.session.completed + checkout.session.async_payment_succeeded).
--
-- HELD AS REVIEW ARTIFACT — run in the Supabase SQL editor BEFORE
-- pointing a Stripe webhook endpoint at /api/webhooks/stripe. The route
-- fails closed (500, Stripe retries for ~3 days) while this table is
-- missing, so applying late loses nothing — but apply it first anyway.

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id          text PRIMARY KEY,          -- Stripe evt_… id
  type              text NOT NULL,             -- e.g. checkout.session.completed
  session_id        text,                      -- cs_… checkout session id
  payment_intent_id text,                      -- pi_… (null for async-pending sessions)
  location_id       uuid REFERENCES locations(id) ON DELETE SET NULL,
  tier              text,                      -- metadata.tier as received (unvalidated)
  amount_cents      integer,                   -- session.amount_total as received
  received_at       timestamptz NOT NULL DEFAULT now(),
  payload           jsonb                      -- full event, for debugging/replay forensics
);

-- Service-role only: RLS enabled with no policies. The webhook route and
-- admin tooling use supabaseService; browsers have no business here.
ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS stripe_webhook_events_location_idx
  ON stripe_webhook_events(location_id, received_at DESC);

-- Layer 2: one billing_invoices row per Stripe payment. Safe to create —
-- stripe_payment_intent_id has never been written (read-only stub until
-- this milestone), so no existing rows can collide.
CREATE UNIQUE INDEX IF NOT EXISTS billing_invoices_stripe_pi_unique
  ON billing_invoices(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
