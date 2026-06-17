-- ════════════════════════════════════════════════════════════════════
--  Feedback attachments — adds file uploads to the feedback system
--  (extends migrations/feedback_items.sql shipped in 274b2e2).
-- ════════════════════════════════════════════════════════════════════
--
-- Run order:
--   1. The ALTER TABLE block below (adds the attachments column).
--   2. Create the Storage bucket in the Supabase dashboard (manual — see
--      "BUCKET SETUP" below).
--   3. The RLS policy block at the bottom (after the bucket exists).
--
-- ─── STEP 1: schema ──────────────────────────────────────────────────

alter table feedback_items
  add column if not exists attachments jsonb not null default '[]'::jsonb;

-- attachments shape: [{ path, name, size, type, uploaded_at }]
-- path is the Supabase Storage object path (private bucket), of the form
--   <user_id>/<uuid>-<sanitized-filename>


-- ─── STEP 2: BUCKET SETUP (manual, Supabase dashboard) ───────────────
--
-- Create a PRIVATE Storage bucket:
--   Name:                feedback-attachments
--   Public:              NO  (private — access via signed URLs only)
--   File size limit:     10 MB
--   Allowed MIME types:  (leave empty — allow all types)
--
-- The backend uploads with the service-role client and generates signed
-- URLs server-side, so the bucket must NOT be public.


-- ─── STEP 3: RLS policies on storage.objects ─────────────────────────
--
-- Run this block AFTER the bucket has been created. These scope user
-- access to their own <user_id>/ folder. The backend's service-role
-- client bypasses RLS entirely, so super_admin / corp signed-URL
-- generation needs no policy of its own.
--
-- Copy-paste the block below as-is:

-- Authenticated users can INSERT to their own folder (user_id/)
create policy "feedback_attachments_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'feedback-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users can SELECT their own files
create policy "feedback_attachments_select_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'feedback-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Super admin / corp service-role bypasses RLS so the admin viewer
-- doesn't need its own policy. Backend uses the service client to
-- generate signed URLs.
