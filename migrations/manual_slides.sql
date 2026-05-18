-- Hive Hub Manual: second guide system. Mirrors guide_slides + video_url.
-- Apply via Supabase SQL editor. Empty starting state — Leslie populates
-- via the editor in the Admin UI.
--
-- Before applying: verify the RLS policies below match what guide_slides
-- has in your live project (no checked-in migration to compare against).
-- Quick check from the Supabase SQL editor:
--   SELECT * FROM pg_policies WHERE tablename = 'guide_slides';
-- If those policies differ from the ones below, prefer mirroring them.

CREATE TABLE IF NOT EXISTS public.manual_slides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot            integer NOT NULL,
  icon            text,
  chapter         text NOT NULL,
  color           text,
  title           text,
  body            text,
  bullets         jsonb NOT NULL DEFAULT '[]'::jsonb,
  screenshot_url  text,
  screenshots     jsonb NOT NULL DEFAULT '[]'::jsonb,
  video_url       text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS manual_slides_slot_idx ON public.manual_slides (slot);

ALTER TABLE public.manual_slides ENABLE ROW LEVEL SECURITY;

-- Reads: any authenticated user
CREATE POLICY "manual_slides_select_authenticated"
  ON public.manual_slides FOR SELECT TO authenticated USING (true);

-- Writes: super_admin or admin (matches /api/manual-slides allowedRoles)
CREATE POLICY "manual_slides_insert_admins"
  ON public.manual_slides FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.hub_users
    WHERE hub_users.id = auth.uid()
      AND hub_users.role IN ('super_admin','admin')
  ));

CREATE POLICY "manual_slides_update_admins"
  ON public.manual_slides FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.hub_users
    WHERE hub_users.id = auth.uid()
      AND hub_users.role IN ('super_admin','admin')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.hub_users
    WHERE hub_users.id = auth.uid()
      AND hub_users.role IN ('super_admin','admin')
  ));

CREATE POLICY "manual_slides_delete_admins"
  ON public.manual_slides FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.hub_users
    WHERE hub_users.id = auth.uid()
      AND hub_users.role IN ('super_admin','admin')
  ));
