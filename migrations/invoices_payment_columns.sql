-- migrations/invoices_payment_columns.sql
--
-- Safety net for the invoice payment-fields fix. upsertInvoice now writes
-- paid_amount / balance_owing / paid_at on invoice rows; people-mapper.ts
-- has read these columns since the invoices UI shipped, which implies they
-- already exist in production — but the invoices table's DDL is not in
-- this repo, so this idempotent ALTER guarantees it either way.
--
-- ADD COLUMN IF NOT EXISTS: no-op if the columns are already there.
-- Run in the Supabase SQL editor.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS paid_amount    numeric,      -- full total when status='paid'
  ADD COLUMN IF NOT EXISTS balance_owing  numeric,      -- total when unpaid, 0 when paid
  ADD COLUMN IF NOT EXISTS paid_at        timestamptz;  -- issued date stand-in (Jobber bulk shape has no payment timestamp)
