-- migrations/phone_normalized_drop_leading_one_undo.sql
--
-- Puts leads.phone_normalized back to its pre-16-Oct-2026 expression (every
-- digit, leading 1 and extension kept). Only needed if
-- phone_normalized_drop_leading_one.sql has to be reversed.

ALTER TABLE public.leads
  ALTER COLUMN phone_normalized SET EXPRESSION AS (
    NULLIF(regexp_replace(phone, '[^0-9]'::text, ''::text, 'g'::text), ''::text)
  );
