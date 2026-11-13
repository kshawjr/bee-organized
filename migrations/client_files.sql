-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/client_files.sql — a client's files (photos and PDFs)
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: WRITTEN, NOT RUN. Kevin runs it. Safe to run twice.
--
-- WHY. The Files tab on the client card and on a job has been a placeholder
-- since it shipped: no upload, no storage, no read. An owner at Seattle went
-- looking for the upload and reported it broken. This is the table and the
-- bucket behind the real one. Rules: lib/client-files.ts.
--
-- WHAT IS IN THE BUCKET. Photographs of the inside of clients' homes, and
-- quotes with names and prices on them. So:
--   · the bucket is PRIVATE, and this file says so every time it is run;
--   · there is NO policy on storage.objects for it, of any kind. With no
--     policy, a signed-in browser talking to Supabase directly can neither
--     list, read, add nor remove anything in it. Only server code holding the
--     service-role key can, and that code checks who is asking first
--     (app/api/client-files/**);
--   · the table has RLS on and no policy, for the same reason.
--
-- UNTIL THIS IS RUN the app is safe to deploy: the Files tab says "Files
-- isn't switched on yet" and offers no upload.
--
-- ONE ROW PER FILE. A file belongs to a CLIENT (lead_id) and may also be
-- pinned to one of their jobs (engagement_id) — the same shape as lead_notes.
--   · the client is permanently deleted  → rows go with them (CASCADE). The
--     app removes the Storage objects in the same request
--     (app/api/leads/[id]/route.ts DELETE). A client deleted BY HAND in SQL
--     leaves their objects behind under <lead id>/ in the bucket: remove that
--     folder by hand too.
--   · a job is deleted                   → the file stays, on the client
--     (SET NULL).
--   · the person who added it is removed → the file stays; their name is kept
--     in uploaded_by_label.
-- No location column on purpose: who may see a file is read from where the
-- client is filed at that moment, so a transfer or a closed location needs no
-- change here and cannot leave a row pointing at the wrong place.
--
-- AFTER RUNNING: lib/db-columns.snapshot.txt already carries the client_files
-- line (added by hand with the code). Re-run the snapshot query in
-- lib/db-columns-check.ts and confirm the line matches.
--
-- UNDO: migrations/client_files_undo.sql.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. the table ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.client_files (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            uuid        NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  engagement_id      uuid        NULL REFERENCES public.engagements(id) ON DELETE SET NULL,
  -- Storage object path in the client-files bucket:
  --   <lead id>/<random uuid>-<cleaned file name>
  path               text        NOT NULL,
  -- The small preview picture (photos only), or NULL.
  thumb_path         text        NULL,
  -- The name as the owner had it, for showing.
  name               text        NOT NULL,
  -- Decided from the file's own first bytes at upload.
  mime_type          text        NOT NULL,
  size_bytes         integer     NOT NULL,
  uploaded_by        uuid        NULL REFERENCES public.hub_users(id) ON DELETE SET NULL,
  uploaded_by_label  text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_files_path_key UNIQUE (path),
  CONSTRAINT client_files_mime_type_check CHECK (
    mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf')
  ),
  -- 4 MB. The same number as MAX_FILE_BYTES in lib/client-files.ts.
  CONSTRAINT client_files_size_check CHECK (size_bytes > 0 AND size_bytes <= 4194304)
);

-- The tab: this client's files, newest first.
CREATE INDEX IF NOT EXISTS client_files_lead_idx
  ON public.client_files (lead_id, created_at DESC);

-- The job's tab.
CREATE INDEX IF NOT EXISTS client_files_engagement_idx
  ON public.client_files (engagement_id) WHERE engagement_id IS NOT NULL;

-- RLS on, no policy: browser clients read and write nothing.
ALTER TABLE public.client_files ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.client_files IS
  'One row per file (photo or PDF) on a client, optionally pinned to a job. Objects live in the PRIVATE client-files bucket. Server code only (app/api/client-files).';

-- ─── 2. the bucket — PRIVATE ────────────────────────────────────────────────
-- public = false on insert AND on conflict: running this file again puts a
-- bucket someone made public back to private.
-- 4 MB per object; photos and PDFs only. The app checks both first; this is
-- the floor under it.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'client-files', 'client-files', false, 4194304,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ─── 3. policies on storage.objects for this bucket ─────────────────────────
-- None. Deliberately. Do not add one.

-- ─── 4. check (read-only; run after the above) ──────────────────────────────
-- Expect: public = false, and zero policies that mention the bucket.
--
--   select id, public, file_size_limit, allowed_mime_types
--     from storage.buckets where id = 'client-files';
--   select policyname from pg_policies
--    where schemaname = 'storage' and tablename = 'objects'
--      and (coalesce(qual, '') || coalesce(with_check, '')) ilike '%client-files%';
