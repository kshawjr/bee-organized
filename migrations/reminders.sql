-- migrations/reminders.sql
--
-- Reminders: a date and a note, on any record, in one list.
--
-- WRITTEN, NOT RUN. Paste into the Supabase SQL editor as ONE run (it is a
-- single transaction-safe script with no temp tables).
--
-- The whole feature is two fields — due_on and note. Everything else here is
-- plumbing: who it belongs to, which record it is about, and whether it has
-- been ticked off. Deliberately NOT here, and not to be added without asking
-- Kevin: priority, category, assigning to someone else, repeat, sub-tasks,
-- times of day, any kind of alert.
--
-- OWNERSHIP: user_id is whoever SET the reminder (auth.uid() of the caller at
-- create time), never the record's assignee. Setting one on someone else's
-- lead still makes it yours. The API never lets user_id change after insert.
--
-- THE RECORD: exactly one of lead_id / engagement_id / partner_id is set.
--   lead_id       → leads.id. A "lead" and a "client" are the SAME row in
--                   leads (a lead is a client still at the New stage), and both
--                   open the same client card, so both use this column.
--   engagement_id → engagements.id
--   partner_id    → partners.id (a Network person)
-- Real foreign keys, not a free-text "record_type + id" pair, so a reminder can
-- never point at nothing. ON DELETE CASCADE: if the record is hard-deleted the
-- reminder goes with it. (Soft-deleted Network people keep theirs; the API
-- hides reminders on deleted people.)
--
-- location_uuid is copied from the record at create time so a reminder can be
-- scoped and checked without a join. It is not the owner's location — an
-- elevated user can set reminders across locations.
--
-- due_on is a DATE, not a timestamp: "Tuesday", not "Tuesday 00:00 UTC".
-- Today / overdue is decided in the viewer's own browser against their local
-- date, so a reminder due Tuesday is "today" all Tuesday wherever they are.
--
-- done_at: null = open. Tick sets it. Finished reminders drop out of every
-- list; delete removes the row outright.

CREATE TABLE IF NOT EXISTS public.reminders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  location_uuid  uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  lead_id        uuid REFERENCES public.leads(id)       ON DELETE CASCADE,
  engagement_id  uuid REFERENCES public.engagements(id) ON DELETE CASCADE,
  partner_id     uuid REFERENCES public.partners(id)    ON DELETE CASCADE,
  due_on         date NOT NULL,
  note           text NOT NULL CHECK (length(btrim(note)) > 0 AND length(note) <= 500),
  done_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reminders_exactly_one_record CHECK (
    (lead_id IS NOT NULL)::int + (engagement_id IS NOT NULL)::int + (partner_id IS NOT NULL)::int = 1
  )
);

-- "My open reminders, soonest first" — the Home and Reminders page query.
CREATE INDEX IF NOT EXISTS idx_reminders_user_open
  ON public.reminders (user_id, due_on)
  WHERE done_at IS NULL;

-- "My reminders on this record" — the card query.
CREATE INDEX IF NOT EXISTS idx_reminders_lead       ON public.reminders (lead_id)       WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_engagement ON public.reminders (engagement_id) WHERE engagement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reminders_partner    ON public.reminders (partner_id)    WHERE partner_id IS NOT NULL;

-- RLS: the app reads and writes through the service role in /api/reminders
-- (which enforces ownership itself). This policy is the floor under that: a
-- signed-in browser talking to the table directly sees and touches only its
-- own rows.
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reminders own rows" ON public.reminders;
CREATE POLICY "reminders own rows"
  ON public.reminders FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
