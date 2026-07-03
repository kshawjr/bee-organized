-- Staging table for the resumable Jobber import.
-- The fetch phase pages Jobber into import_staging keyed by (job_id, entity),
-- checkpointing after each page. If the function times out or trips Jobber's
-- 10k-cost rate budget, the next invocation resumes from the persisted cursor.
-- No RLS: service-role only.

CREATE TABLE IF NOT EXISTS import_staging (
  id          bigserial PRIMARY KEY,
  job_id      uuid NOT NULL,
  entity      text NOT NULL,            -- 'clients' | 'requests' | 'quotes' | 'jobs'
  node        jsonb NOT NULL,
  -- Generated column so PostgREST upsert can target it via onConflict.
  -- All four Jobber GraphQL queries select `id` at the top level of each node.
  node_id     text GENERATED ALWAYS AS (node->>'id') STORED,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_import_staging_job_entity
  ON import_staging(job_id, entity);

-- Dedup: a page re-fetch after a crash-in-window (staging.insert succeeded
-- but cursor persist didn't) or a rival segment must NOT double-insert nodes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_import_staging_dedup
  ON import_staging(job_id, entity, node_id);

ALTER TABLE import_jobs
  ADD COLUMN IF NOT EXISTS fetch_cursors jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS fetch_complete jsonb DEFAULT '{}'::jsonb,
  -- Per-job mutex: a segment claims this at start and clears it on every
  -- exit path (continue / complete / fail). A rival segment sees a
  -- non-null claim younger than 90s and refuses to run.
  ADD COLUMN IF NOT EXISTS segment_started_at timestamptz;

-- fetch_cursors:      { clients: "abc", requests: "def", ... }  last endCursor per entity
-- fetch_complete:     { clients: true, requests: false, ... }   which entities fully fetched
-- segment_started_at: null when no segment is running; timestamp of active claim otherwise
