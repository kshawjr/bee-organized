-- migrations/touchpoints_realtime_rls.sql
--
-- PURPOSE
--   Lets Supabase Realtime deliver touchpoint INSERTs to the browser, so one
--   bee's logged call moves the card on another bee's open Inbox.
--
-- WHAT IS ACTUALLY WRONG TODAY
--   public.touchpoints has RLS ENABLED and ZERO policies. In Postgres that is
--   deny-all for every role that doesn't bypass RLS. Nothing is broken in the
--   app because every server route reads touchpoints through the SERVICE key
--   (supabase-service.ts), which bypasses RLS entirely — so the table has run
--   its whole life without a policy and nobody noticed.
--
--   Realtime is the first reader that is NOT the service key. postgres_changes
--   evaluates row visibility as the AUTHENTICATED USER before it sends an
--   event. With no SELECT policy the user can see no touchpoint row, so the
--   subscription connects, stays healthy, and delivers nothing, forever. No
--   amount of client code fixes that. This policy is the missing half of
--   lib/use-touchpoints-realtime.ts, and the "RLS fix" that
--   components/hive/shared/peopleTouchPatch.js names in its SCOPE note.
--
-- WHY IT IS DERIVED FROM THE LEAD, NOT FROM touchpoints.location_uuid
--   touchpoints carries its own location_uuid, and filtering on it would be
--   simpler. It would also be WRONG, and slightly too generous. Measured on
--   production 2026-09-15:
--     · 3914 touchpoints, all with a location_uuid (no nulls to worry about)
--     · 19 of them carry a location_uuid that DISAGREES with their lead's
--     · 9 are orphans whose lead_id matches no lead at all
--   A location_uuid policy would show those 19 to someone who cannot open the
--   lead they belong to, and would expose 9 rows answerable to no lead. That
--   is privilege the feature does not need.
--
--   So visibility is defined the way the app already defines it everywhere
--   else — you may see a touchpoint exactly when you may see its LEAD. The
--   lead half of the predicate is a transcription of the existing
--   "franchise sees own leads" policy (same hub_users lookup, same
--   locations slug-join), so the two can only ever agree. Orphans become
--   visible to admins alone, which is correct: a row with no lead has nothing
--   to authorise it.
--
-- SCOPE OF THE GRANT
--   SELECT only, role `authenticated` only. No INSERT/UPDATE/DELETE policy is
--   added: every write still goes through the service key, exactly as it does
--   today, and adding write policies would widen the table's surface for no
--   reason. Delivery needs SELECT and nothing else.
--
-- REVERSIBLE
--   drop policy "sees touchpoints for the leads it can see" on public.touchpoints;
--   Dropping it returns the table to deny-all-for-users and turns live
--   touchpoints off again. It cannot affect the server routes either way —
--   they bypass RLS.
--
-- NOTE ON REPLICATION
--   public.touchpoints is already a member of the supabase_realtime
--   publication (verified 2026-09-15), so no ALTER PUBLICATION is needed.

create policy "sees touchpoints for the leads it can see"
  on public.touchpoints
  for select
  to authenticated
  using (
    exists (
      select 1
      from hub_users hu
      where hu.id = auth.uid()
        and (
          -- Admins see every touchpoint, matching "super_admin sees all leads".
          hu.role = any (array['super_admin'::text, 'admin'::text])
          -- Everyone else sees a touchpoint only when its LEAD is one of
          -- theirs, by the same slug-join "franchise sees own leads" uses.
          or exists (
            select 1
            from leads l
            where l.id = touchpoints.lead_id
              and l.location_id = (
                select loc.slug
                from locations loc
                where (loc.id)::text = hu.location_id
              )
          )
        )
    )
  );
