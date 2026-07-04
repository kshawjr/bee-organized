-- HIVE Phase 1 — description as a first-class engagement field.
-- The description describes THE WORK (editable anytime in the panel);
-- request_details stays the request record's own data.
-- Idempotent — safe to re-run.

ALTER TABLE public.engagements
  ADD COLUMN IF NOT EXISTS description text;

-- One-time seed from the founding request's text. Two sources, mirroring
-- what the panel used to render:
--   1. the founding SR's own notes (per-SR text, if Jobber ever carried it)
--   2. leads.request_details (the webform text) — CLIENT-level, so it only
--      seeds the client's EARLIEST request-founded engagement (founding
--      semantics: one webform blurb must not spread to every engagement
--      of a repeat client).
-- Both sources are empty in prod as of 2026-07-04 → ~zero rows updated;
-- the forward copy in foundEngagement() takes over from here.
WITH founding AS (
  SELECT DISTINCT ON (s.engagement_id)
    s.engagement_id, s.lead_id,
    nullif(btrim(s.notes), '') AS sr_text
  FROM public.service_requests s
  WHERE s.engagement_id IS NOT NULL
  ORDER BY s.engagement_id, s.requested_at ASC NULLS LAST, s.created_at ASC
),
first_eng AS (
  SELECT DISTINCT ON (client_id) client_id, id
  FROM public.engagements
  WHERE founded_by = 'request'
  ORDER BY client_id, created_at ASC
)
UPDATE public.engagements e
SET description = COALESCE(
  f.sr_text,
  CASE WHEN fe.id = e.id THEN nullif(btrim(l.request_details), '') END
)
FROM founding f
JOIN public.leads l ON l.id = f.lead_id
LEFT JOIN first_eng fe ON fe.client_id = e.client_id
WHERE f.engagement_id = e.id
  AND e.description IS NULL
  AND e.founded_by = 'request'
  AND COALESCE(
    f.sr_text,
    CASE WHEN fe.id = e.id THEN nullif(btrim(l.request_details), '') END
  ) IS NOT NULL;
