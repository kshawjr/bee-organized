-- ═══════════════════════════════════════════════════════════════════════════
-- migrations/zip_coords.sql — a map point for every US zip
-- ═══════════════════════════════════════════════════════════════════════════
-- STATUS: WRITTEN, NOT RUN.
--
-- WHAT. One row per US zip area: its latitude/longitude and its state(s).
-- lib/zip-proximity.ts reads it to measure how far a lead in Other is from
-- each location's nearest claimed zip (the Slack route suggestion). Nothing
-- else reads it, and it holds no customer data — it is public Census
-- reference data.
--
-- SOURCE. US Census Bureau, filled by scripts/load-zip-coords.mjs (dry run
-- first, --commit to write). Two files:
--   · the ZCTA Gazetteer (2025_Gaz_zcta_national.txt, 33,791 zips): the
--     coordinate is the Census "internal point" (INTPTLAT / INTPTLONG), a
--     point guaranteed to sit inside the zip's area.
--   · the 2020 zip-to-county relationship file (tab20_zcta520_county20_natl):
--     which states each zip touches. `state` is the one holding most of its
--     land; `states` is all of them.
-- PO-box-only and single-company zips have no Census area and are not here.
--
-- UPDATING. Once a year, when the Census publishes the next Gazetteer: run the
-- load script against the new file. It shows what moved before writing, and
-- never deletes a zip unless asked (--prune).
--
-- UNDO: migrations/zip_coords_undo.sql drops the table. Safe at any time: it
-- is reference data, reloadable by the script.
--
-- NO POLICIES. RLS on with no policy: browser clients read nothing. The
-- service-role client (server code only) bypasses RLS.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.zip_coords (
  zip        text             PRIMARY KEY CHECK (zip ~ '^[0-9]{5}$'),
  lat        double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng        double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  -- The state holding most of the zip's land, USPS code. NULL when the
  -- relationship file has no county for it.
  state      text             NULL CHECK (state ~ '^[A-Z]{2}$'),
  -- Every state the zip touches, sorted. A lead in any of them does not
  -- disagree with its zip.
  states     text[]           NOT NULL DEFAULT '{}',
  -- Which file the row came from, e.g. 'census_gazetteer_2025'.
  source     text             NOT NULL,
  loaded_at  timestamptz      NOT NULL DEFAULT now()
);

ALTER TABLE public.zip_coords ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.zip_coords IS
  'US Census zip internal points + states, for lead-to-location distance (lib/zip-proximity.ts). Loaded by scripts/load-zip-coords.mjs.';
