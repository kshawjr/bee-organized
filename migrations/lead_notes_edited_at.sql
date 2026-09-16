-- migrations/lead_notes_edited_at.sql
--
-- PURPOSE
--   Records that a note was edited, so an edited note can say so on the card.
--   Kevin's ruling: a note someone has acted on must not change silently
--   underneath them — the fact stays and is legible, quietly. Same principle
--   as the feedback tombstone.
--
--   lead_notes has created_at and nothing else about time. There is no
--   updated_at to lean on, so "edited" cannot be derived from what is already
--   stored: a note edited one second after it was written and one never
--   touched are indistinguishable without this column.
--
-- NULL MEANS NEVER EDITED, which is why this is a timestamp rather than a
--   boolean — the same idiom as leads.inbox_dismissed_at and
--   leads.marketing_consented_at already in this schema. It self-documents
--   WHEN, and the card can say "edited" today and "edited 20 minutes ago"
--   later without another migration.
--
-- THE FEATURE WORKS WITHOUT THIS, DELIBERATELY. PATCH /api/lead-notes/:id
--   sets edited_at when the column is there and carries on without it when it
--   is not, detecting the missing column the way lib/lead-address.ts already
--   detects a missing former_addresses (Postgres 42703 / PostgREST PGRST204).
--   So editing is live the moment the code deploys, and edited notes start
--   showing their marker the moment this migration runs. Nothing is broken in
--   between; the marker is simply absent.
--
--   That is on purpose: three features have shipped silent this week waiting
--   on a migration, and an edit button that 500s until someone runs SQL would
--   be a fourth and worse.
--
-- SAFE TO RUN ANY TIME
--   Nullable, no default, no backfill. Existing rows read as never-edited,
--   which is exactly true of every note written before this shipped. No index:
--   nothing queries by it — it is displayed, never filtered on.
--
-- REVERSIBLE
--   alter table public.lead_notes drop column edited_at;
--   The edit path keeps working; edited notes simply stop saying so.

alter table public.lead_notes
  add column if not exists edited_at timestamptz;

comment on column public.lead_notes.edited_at is
  'When the note text was last edited by its author or an admin. NULL means never edited. Displayed on the client card; never filtered on.';
