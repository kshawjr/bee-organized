-- Structured billing invoice records.
-- Manual conversions populate today; Stripe webhooks will populate
-- when that integration lands.

CREATE TABLE IF NOT EXISTS billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

  -- Amount in cents (avoids float precision issues)
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'usd',

  -- When the payment was received
  paid_at timestamptz NOT NULL DEFAULT now(),

  -- What billing period this covers
  period_start date,
  period_end date,

  -- Source / method
  source text NOT NULL CHECK (source IN ('manual_conversion', 'stripe', 'manual_other')),
  payment_method text, -- 'check', 'wire', 'ach', 'card', etc.
  reference_number text, -- check #, wire ref, etc.

  -- Context
  memo text,
  recorded_by uuid REFERENCES hub_users(id),

  -- Stripe-specific (NULL until Stripe wires)
  stripe_invoice_id text,
  stripe_payment_intent_id text,
  stripe_charge_id text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_invoices_location_paid_idx
  ON billing_invoices(location_id, paid_at DESC);

CREATE INDEX IF NOT EXISTS billing_invoices_stripe_invoice_idx
  ON billing_invoices(stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS billing_invoices_stripe_payment_intent_idx
  ON billing_invoices(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

-- updated_at trigger
CREATE OR REPLACE FUNCTION billing_invoices_updated_at_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS billing_invoices_updated_at ON billing_invoices;
CREATE TRIGGER billing_invoices_updated_at
  BEFORE UPDATE ON billing_invoices
  FOR EACH ROW EXECUTE FUNCTION billing_invoices_updated_at_trigger();
